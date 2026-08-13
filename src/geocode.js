/**
 * Place search + reverse geocode for MORGAN Travelers.
 * Uses OpenStreetMap Nominatim via same-origin /geocode proxy (COEP-safe),
 * plus a local MTR station directory so rail pins beat bus stops
 * (e.g. "Sha Tin Station" → railway centroid, not a nearby bus stop).
 *
 * Note: Nominatim countrycodes=hk returns empty for most HK places
 * (they are often tagged under other admin trees). We bias with a
 * viewbox and filter client-side to the HK bounding box instead.
 */

import { searchMtrStationsLocal, MTR_STATIONS } from "./mtrStations.js";
import { searchLrtStopsLocal, matchLrtStop, lrtStopToHit } from "./lrtStops.js";
import { t } from "./lang.js";

/**
 * Parse @MTR / @LRT / @Bus mode filters from a search query.
 * @param {string} query
 * @returns {{ mode: "mtr" | "lrt" | "bus" | null, text: string }}
 */
export function parseSearchModeFilter(query) {
  const raw = String(query || "");
  let mode = null;
  let text = raw;
  // First matching @tag wins; strip all mode tags from the free-text part
  const tagRe = /@\s*(mtr|lrt|bus|輕鐵|地鐵|巴士)\b/gi;
  let m;
  while ((m = tagRe.exec(raw)) !== null) {
    const t = m[1].toLowerCase();
    if (!mode) {
      if (t === "mtr" || t === "地鐵") mode = "mtr";
      else if (t === "lrt" || t === "輕鐵") mode = "lrt";
      else if (t === "bus" || t === "巴士") mode = "bus";
    }
  }
  text = raw
    .replace(/@\s*(mtr|lrt|bus|輕鐵|地鐵|巴士)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { mode, text };
}

/** Hong Kong approximate bounds */
const HK = {
  minLat: 22.13,
  maxLat: 22.58,
  minLon: 113.82,
  maxLon: 114.51,
};

// Nominatim viewbox: left,top,right,bottom (lon/lat)
const HK_VIEWBOX = `${HK.minLon},${HK.maxLat},${HK.maxLon},${HK.minLat}`;

/**
 * Same-origin proxy base (Vite / Cloudflare Pages).
 */
function geocodeBase() {
  return `${location.origin}/geocode`;
}

function inHongKong(lat, lon) {
  return (
    lat >= HK.minLat &&
    lat <= HK.maxLat &&
    lon >= HK.minLon &&
    lon <= HK.maxLon
  );
}

/** User typed something that implies they want a rail/MTR station. */
function wantsStation(query) {
  return /\bstation\b|\bstn\b|\bmtr\b|站|鐵路|地铁|地鐵/i.test(query);
}

/** OSM / Nominatim hit is a bus stop or bus station (not MTR). */
function isBusFacility(p) {
  if (!p) return false;
  const cat = String(p.category || p.class || "").toLowerCase();
  const typ = String(p.type || "").toLowerCase();
  if (typ === "bus_stop" || typ === "bus_station") return true;
  if (cat === "highway" && typ === "bus_stop") return true;
  if (cat === "amenity" && typ === "bus_station") return true;
  const blob = `${p.name || ""} ${p.label || ""}`.toLowerCase();
  if (
    /\bbus\s*stop\b|\bbus\s*station\b|\bbus\s*terminus\b|alighting|落客|巴士站|巴士總站|小巴站|專線小巴/.test(
      blob,
    )
  ) {
    // Allow names like "Sha Tin Station" that are rail — only flag if bus-ish words present
    if (/\bbus\b|巴士|小巴|alighting|落客|terminus|總站/.test(blob)) return true;
  }
  return false;
}

function isRailOrMtrHit(p) {
  if (!p) return false;
  // Light Rail is rail but not heavy-rail MTR for badging / snap purposes
  if (p.isLrt || p.mode === "lrt" || p.source === "lrt-local") return false;
  if (p.isMtr || p.source === "mtr-local" || p.source === "mtr-snap") return true;
  const cat = String(p.category || p.class || "").toLowerCase();
  const typ = String(p.type || "").toLowerCase();
  return cat === "railway" || typ === "station" || typ === "halt";
}

/**
 * If a Nominatim / free-text hit is actually an LRT stop, re-pin to OSM LRT coords
 * and retag so the UI shows LRT (not MTR) and selection does not snap to TML.
 */
function promoteToLrtIfMatch(p) {
  if (!p) return p;
  if (p.isLrt || p.mode === "lrt" || p.source === "lrt-local") {
    return { ...p, isLrt: true, isMtr: false, mode: "lrt" };
  }
  const hit = matchLrtStop(p.name || p.label, p.lat, p.lon, 220);
  if (!hit) return p;
  // Name strongly matches an LRT stop, or pin is on top of one
  const out = lrtStopToHit(hit);
  return {
    ...out,
    // keep original display if richer
    importance: p.importance,
  };
}

/**
 * Higher = better. Boosts MTR / railway stations when the query mentions "station".
 * Nominatim jsonv2 uses `category` (not `class`).
 * @param {{ name: string, label: string, type: string, class?: string, category?: string, lat: number, lon: number }} place
 * @param {string} query
 * @param {boolean} preferStation
 */
function rankPlace(place, query, preferStation) {
  let score = 0;
  const name = `${place.name} ${place.label}`.toLowerCase();
  const q = query.toLowerCase().replace(/,?\s*hong\s*kong\s*$/i, "").trim();
  // jsonv2: category; older json: class
  const cls = String(place.category || place.class || "").toLowerCase();
  const typ = String(place.type || "").toLowerCase();

  if (inHongKong(place.lat, place.lon)) score += 100;

  // True MTR / rail station (OSM railway=station)
  const isRailwayStation =
    (cls === "railway" &&
      (typ === "station" || typ === "halt" || typ === "stop" || typ === "subway_entrance")) ||
    (cls === "public_transport" && typ === "station");

  // Bus facilities often named "Yuen Long Station" at the same interchange
  const isBusFacility =
    typ === "bus_station" ||
    typ === "bus_stop" ||
    (cls === "amenity" && typ === "bus_station") ||
    (cls === "highway" && typ === "bus_stop");

  const nameLooksMtr = /\bmtr\b|港鐵|地鐵|地铁/.test(name);
  const nameHasStation = /\bstation\b|站/.test(name);

  if (preferStation) {
    if (isRailwayStation) score += 800; // hard prioritise MTR/rail
    if (nameLooksMtr && isRailwayStation) score += 100;
    if (nameHasStation && isRailwayStation) score += 50;
    if (isBusFacility) score -= 400; // push bus termini below rail
    if (nameHasStation && !isBusFacility && !isRailwayStation) score += 120;

    const token = q
      .replace(/\b(station|stn|mtr|站|railway|鐵路)\b/gi, "")
      .trim()
      .toLowerCase();
    if (token && name.includes(token)) score += 80;
    if (token && place.name.toLowerCase().includes(token)) score += 40;
    // Exact-ish rail name "元朗 Yuen Long" after stripping Station
    if (token && isRailwayStation && place.name.toLowerCase().includes(token.split(/\s+/)[0])) {
      score += 60;
    }
  } else {
    if (isRailwayStation) score += 40;
    if (isBusFacility) score += 10;
  }

  if (typeof place.importance === "number") {
    score += place.importance * 20;
  }

  return score;
}

/**
 * Forward geocode: free-text place search (Hong Kong biased).
 * Supports @MTR / @LRT / @Bus filters (see parseSearchModeFilter).
 * When the query contains "station" / 站 / MTR, railway & MTR stations are ranked first.
 * @param {string} query
 * @param {{ limit?: number, signal?: AbortSignal, mode?: "mtr"|"lrt"|"bus"|null }} [opts]
 * @returns {Promise<Array<{ lat: number, lon: number, label: string, name: string }>>}
 */
export async function searchPlaces(query, opts = {}) {
  const rawQ = String(query || "").trim();
  const parsed = parseSearchModeFilter(rawQ);
  const mode = opts.mode ?? parsed.mode;
  const q = (parsed.text || rawQ.replace(/@\s*\w+/g, "").trim()).trim();

  // @tag alone with no free text: still search by mode (list top stops)
  const limit = opts.limit ?? 8;

  // ── Mode-filtered directories ────────────────────────────────────────────
  if (mode === "mtr") {
    let list = q.length >= 2 ? searchMtrStationsLocal(q, limit) : [];
    if (!list.length && q.length < 2) {
      // @MTR alone — sample major heavy-rail stations alphabetically
      list = (MTR_STATIONS || []).slice(0, limit).map((st) => ({
        lat: st.lat,
        lon: st.lon,
        name: `${st.name_en} Station`,
        label: st.name_zh
          ? `${st.name_zh} ${st.name_en} Station · MTR`
          : `${st.name_en} Station · MTR`,
        category: "railway",
        type: "station",
        isMtr: true,
        source: "mtr-local",
        mode: "mtr",
      }));
    }
    if (list.length) {
      return list.slice(0, limit).map((p) => ({
        ...p,
        isMtr: true,
        mode: "mtr",
        category: "railway",
        type: "station",
      }));
    }
  }

  if (mode === "lrt") {
    const local = searchLrtStopsLocal(q, limit);
    if (local.length) return local.slice(0, limit);
    // Fall through to Nominatim light rail search below
  }

  if (mode === "bus" && q.length < 2 && !rawQ) {
    return [];
  }

  if (q.length < 2 && mode !== "lrt" && mode !== "mtr") return [];
  if (q.length < 1 && !mode) return [];

  const preferStation = wantsStation(q) || mode === "mtr";
  const localMtr =
    mode === "bus" || mode === "lrt" ? [] : searchMtrStationsLocal(q, limit);
  const hasLocalMtr = localMtr.length > 0;
  const stationIntent = preferStation || hasLocalMtr || mode === "mtr";

  // Strong local directory hit: return MTR + matching LRT (do not drop LRT,
  // and never early-return only heavy rail for names like Tin Yat).
  if (mode !== "bus" && mode !== "lrt") {
    const localLrt = searchLrtStopsLocal(q, limit);
    if (hasLocalMtr || localLrt.length) {
      const out = [];
      const seen = new Set();
      const add = (p) => {
        const k = `${p.mode || (p.isLrt ? "lrt" : "mtr")}:${String(p.name).toLowerCase()}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(p);
      };
      // LRT first when name is LRT-primary (Tin Yat); then heavy rail
      for (const p of localLrt) add(p);
      for (const p of localMtr) {
        add({
          ...p,
          isMtr: true,
          isLrt: false,
          mode: "mtr",
          category: "railway",
          type: "station",
        });
      }
      if (out.length) return out.slice(0, limit);
    }
  }

  // Build Nominatim query
  let searchQ = q || (mode === "lrt" ? "Light Rail" : mode === "bus" ? "bus stop" : "");
  if (!searchQ) return [];
  if (!/\bhong\s*kong\b|\bhk\b|香港|九龍|新界/i.test(searchQ)) {
    searchQ = `${searchQ}, Hong Kong`;
  }
  if (mode === "lrt" && !/light\s*rail|輕鐵/i.test(searchQ)) {
    searchQ = `${q} Light Rail, Hong Kong`;
  }
  if (mode === "bus" && !/\bbus\b|巴士/i.test(searchQ)) {
    searchQ = `${q} bus stop, Hong Kong`;
  }
  if (mode === "mtr" && !/\bmtr\b|station/i.test(searchQ)) {
    searchQ = `${q} MTR station, Hong Kong`;
  }

  async function nominatimSearch(qStr, lim) {
    const params = new URLSearchParams({
      q: qStr,
      format: "jsonv2",
      addressdetails: "1",
      limit: String(lim),
      viewbox: HK_VIEWBOX,
      bounded: "0",
    });
    const res = await fetch(`${geocodeBase()}/search?${params}`, {
      signal: opts.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Place search failed (${res.status})${body ? `: ${body.slice(0, 120)}` : ""}`,
      );
    }
    try {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      throw new Error(t("Place search returned invalid JSON — is /geocode proxy running?"));
    }
  }

  const fetchLimit = Math.min(limit * 4, 25);
  let data = [];
  let nominatimOk = true;
  try {
    data = await nominatimSearch(searchQ, fetchLimit);
  } catch (e) {
    nominatimOk = false;
    console.warn("[geocode] Nominatim unavailable — using local directories", e);
  }

  if (nominatimOk && (stationIntent || mode === "mtr")) {
    const placeToken = q
      .replace(/\b(station|stn|mtr|站|鐵路|railway)\b/gi, "")
      .replace(/,?\s*hong\s*kong\s*/gi, "")
      .trim();
    if (placeToken.length >= 2) {
      const extras = await Promise.all([
        nominatimSearch(`${placeToken} MTR, Hong Kong`, 8),
        nominatimSearch(`${placeToken} railway station, Hong Kong`, 8),
      ]);
      const seenIds = new Set(data.map((d) => d.place_id).filter(Boolean));
      for (const batch of extras) {
        for (const item of batch) {
          if (item.place_id && seenIds.has(item.place_id)) continue;
          if (item.place_id) seenIds.add(item.place_id);
          data.push(item);
        }
      }
    }
  }

  if (nominatimOk && mode === "bus") {
    const placeToken = q.replace(/\bbus\b|巴士|stop|站/gi, "").trim() || q;
    const extras = await nominatimSearch(`${placeToken} bus stop, Hong Kong`, 12);
    data = [...data, ...extras];
  }

  if (nominatimOk && mode === "lrt") {
    const placeToken = q.replace(/light\s*rail|輕鐵/gi, "").trim() || q;
    const extras = await Promise.all([
      nominatimSearch(`${placeToken} Light Rail, Hong Kong`, 10),
      nominatimSearch(`${placeToken} 輕鐵, Hong Kong`, 8),
    ]);
    data = [...data, ...extras.flat()];
  }

  const mapped = data
    .map((item) => {
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const category = item.category || item.class || "";
      return {
        lat,
        lon,
        name:
          item.name ||
          item.display_name?.split(",")[0]?.trim() ||
          t("Place"),
        label: formatNominatimLabel(item),
        type: item.type || "",
        category,
        class: category,
        importance: Number(item.importance) || 0,
      };
    })
    .filter(Boolean);

  // Mode filters on OSM hits
  let filtered = mapped;
  if (mode === "mtr") {
    filtered = mapped.filter(
      (p) => isRailOrMtrHit(p) && !isBusFacility(p),
    );
  } else if (mode === "bus") {
    filtered = mapped.filter((p) => isBusFacility(p) || /bus|巴士|小巴/i.test(`${p.name} ${p.label}`));
  } else if (mode === "lrt") {
    filtered = mapped.filter(
      (p) =>
        /light\s*rail|輕鐵|tin |tuen |yuen long|屯門|天水圍|元朗/i.test(
          `${p.name} ${p.label}`,
        ) ||
        (String(p.category) === "railway" &&
          (p.type === "halt" || p.type === "stop" || p.type === "station")),
    );
  } else {
    filtered = mapped.filter((p) => !(stationIntent && isBusFacility(p)));
  }

  filtered.sort((a, b) => {
    const diff = rankPlace(b, q, stationIntent || mode === "mtr") - rankPlace(a, q, stationIntent || mode === "mtr");
    if (diff !== 0) return diff;
    return (b.importance || 0) - (a.importance || 0);
  });

  const inHk = filtered.filter((p) => inHongKong(p.lat, p.lon));
  const list = inHk.length ? inHk : filtered;

  const merged = [];
  const seen = new Set();
  const push = (p) => {
    if (!p) return;
    // Re-pin / retag LRT so free-text search never shows LRT as MTR
    p = promoteToLrtIfMatch(p);

    if (mode === "mtr" && (p.isLrt || p.mode === "lrt")) return;
    if (mode === "mtr" && isBusFacility(p) && !isRailOrMtrHit(p)) return;
    if (mode === "bus" && (p.isLrt || isRailOrMtrHit(p)) && !isBusFacility(p)) return;
    if (stationIntent && !mode && isBusFacility(p) && !isRailOrMtrHit(p) && !p.isLrt) {
      return;
    }

    const isLrt = !!(p.isLrt || p.mode === "lrt" || p.source === "lrt-local");
    // Heavy rail only — never mark LRT as isMtr (avoids snap + wrong badge)
    const isMtr = !isLrt && !!(p.isMtr || isRailOrMtrHit(p));

    const key = isLrt
      ? `lrt:${String(p.name).toLowerCase()}`
      : `${String(p.name).toLowerCase()}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`;
    const nameKey = String(p.name)
      .toLowerCase()
      .replace(/\s+station$/i, "")
      .replace(/站$/u, "")
      .replace(/\s*·\s*mtr$/i, "")
      .replace(/\s*·\s*light\s*rail$/i, "")
      .trim();
    // Allow both "Tin Shui Wai · MTR" and "Tin Shui Wai · Light Rail"
    const dedupeKey = isLrt ? `lrt:${nameKey}` : `mtr:${nameKey}`;
    if (seen.has(key) || seen.has(dedupeKey)) return;
    seen.add(key);
    seen.add(dedupeKey);

    merged.push({
      lat: p.lat,
      lon: p.lon,
      name: p.name,
      label: p.label,
      type: p.type || (isLrt ? "halt" : p.type),
      category: p.category || "railway",
      isMtr,
      isLrt,
      mode: isLrt ? "lrt" : p.mode || mode || (isMtr ? "mtr" : isBusFacility(p) ? "bus" : null),
      source: p.source,
    });
  };

  // Local directories first (authoritative coords)
  if (mode === "lrt" || !mode) {
    for (const p of searchLrtStopsLocal(q, limit)) push(p);
  }
  if (mode !== "bus" && mode !== "lrt") {
    for (const p of localMtr) push(p);
  }
  for (const p of list) push(p);

  // Local GTFS bus-stop fallback — offline (Nominatim down) or zero OSM bus
  // hits: search the shipped stop directory (KMB/CTB/NLB/GMB) instead.
  if (q.length >= 2 && (mode === "bus" || !mode) && (!nominatimOk || !list.length)) {
    const local = await localGtfsStopsSearch(q, limit);
    for (const p of local) push(p);
  }

  if (mode === "mtr") {
    const railOnly = merged.filter((p) => p.isMtr && !p.isLrt);
    if (railOnly.length) return railOnly.slice(0, limit);
  }

  if (mode === "bus") {
    return merged.slice(0, limit);
  }
  if (mode === "lrt") {
    return merged.filter((p) => p.isLrt).slice(0, limit);
  }

  // Unfiltered: prefer rail hits (heavy + light), keep both when dual-named
  if (merged.some((p) => p.isMtr || p.isLrt)) {
    const railFirst = [
      ...merged.filter((p) => p.isLrt || p.isMtr),
      ...(stationIntent
        ? []
        : merged.filter((p) => !p.isLrt && !p.isMtr && !isBusFacility(p))),
    ];
    if (railFirst.length) return railFirst.slice(0, limit);
  }

  return merged.filter((p) => !isBusFacility(p) || !stationIntent).slice(0, limit);
}

/**
 * Local GTFS bus-stop fallback for searchPlaces: prefix/substring matches in
 * the shipped stop directory (works offline from the SW data cache).
 * @param {string} q
 * @param {number} limit
 * @returns {Promise<Array<{ lat: number, lon: number, name: string, label: string }>>}
 */
async function localGtfsStopsSearch(q, limit) {
  try {
    const { searchGtfsStopsLocal } = await import("./routeShapes.js");
    const hits = await searchGtfsStopsLocal(q, limit);
    return hits.map((s) => ({
      lat: s.lat,
      lon: s.lon,
      name: s.name,
      label: `${s.name} · Bus stop`,
      category: "bus_stop",
      type: "stop",
      isBus: true,
      source: "gtfs-local",
    }));
  } catch (e) {
    console.warn("[geocode] local GTFS stop search failed", e);
    return [];
  }
}

/**
 * Reverse geocode coordinates → short label.
 */
export async function reverseGeocode(lat, lon, opts = {}) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2",
    zoom: "17",
    addressdetails: "1",
  });
  const url = `${geocodeBase()}/reverse?${params}`;
  try {
    const res = await fetch(url, {
      signal: opts.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return fmtCoord(lat, lon);
    const data = await res.json();
    return formatNominatimLabel(data) || fmtCoord(lat, lon);
  } catch {
    return fmtCoord(lat, lon);
  }
}

/**
 * Browser geolocation → { lat, lon, accuracy }.
 */
export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported on this device"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        const msg =
          err.code === 1
            ? t("Location permission denied")
            : err.code === 2
              ? t("Location unavailable")
              : err.code === 3
                ? t("Location request timed out")
                : err.message || t("Could not get location");
        reject(new Error(msg));
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30_000,
        ...options,
      },
    );
  });
}

function formatNominatimLabel(item) {
  if (!item) return "";
  if (item.display_name) {
    // Shorten: first 3 comma-separated parts
    const parts = String(item.display_name)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.slice(0, 3).join(", ");
  }
  const a = item.address || {};
  const parts = [
    a.amenity || a.shop || a.tourism || a.railway || a.building || a.road || item.name,
    a.suburb || a.neighbourhood || a.quarter || a.village,
    a.city_district || a.city || a.town || a.county,
  ].filter(Boolean);
  if (parts.length) return [...new Set(parts)].join(", ");
  return "";
}

function fmtCoord(lat, lon) {
  return `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`;
}

export { HK_VIEWBOX, inHongKong };
