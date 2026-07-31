/**
 * MTR stations / platforms / exits map layers
 * Data from wheelstransit/mtr-platform-exits-crawler (CSDI-powered).
 *
 * Stations are NOT always drawn — only exits/platforms for stations
 * used by the selected itinerary (see setRouteStationCodes).
 */

import { tinWingPlatformOverride } from "./lrtShapes.js";

const BASE = () =>
  new URL(`${import.meta.env.BASE_URL}mtr/`, window.location.href).href;

/** @type {GeoJSON.FeatureCollection | null} */
let stationsFc = null;
/** @type {GeoJSON.FeatureCollection | null} */
let exitsFc = null;
/** @type {GeoJSON.FeatureCollection | null} */
let platformsFc = null;
/** @type {GeoJSON.FeatureCollection | null} */
let lrtPlatformsFc = null;

let loaded = false;

/** Codes currently shown (empty = hide all MTR overlays) */
let activeStationCodes = /** @type {string[]} */ ([]);

export async function loadMtrGeo() {
  if (loaded) return { stationsFc, exitsFc, platformsFc, lrtPlatformsFc };
  const [stations, exits, platforms, lrtPlatforms] = await Promise.all([
    fetch(`${BASE()}stations.geojson`).then((r) => r.json()),
    fetch(`${BASE()}exits.geojson`).then((r) => r.json()),
    fetch(`${BASE()}platforms.geojson`).then((r) => r.json()),
    fetch(`${BASE()}lrt-platforms.geojson`)
      .then((r) => (r.ok ? r.json() : { type: "FeatureCollection", features: [] }))
      .catch(() => ({ type: "FeatureCollection", features: [] })),
  ]);
  stationsFc = stations;
  exitsFc = exits;
  platformsFc = platforms;
  lrtPlatformsFc = lrtPlatforms;
  loaded = true;
  console.info(
    "[mtrLayer] stations",
    stations.features?.length,
    "exits",
    exits.features?.length,
    "platforms",
    platforms.features?.length,
    "lrtPlatforms",
    lrtPlatforms.features?.length,
  );
  return { stationsFc, exitsFc, platformsFc, lrtPlatformsFc };
}

/**
 * Add MapLibre sources + layers (hidden until setRouteMtrOverlay).
 * Station centroids are intentionally not drawn — platforms only.
 * @param {import('maplibre-gl').Map} map
 */
export function addMtrLayers(map) {
  if (!stationsFc || map.getSource("mtr-exits")) return;

  // stations source kept for name→code lookup only (no paint layers)
  map.addSource("mtr-stations", { type: "geojson", data: stationsFc });
  map.addSource("mtr-exits", { type: "geojson", data: exitsFc });
  map.addSource("mtr-platforms", { type: "geojson", data: platformsFc });

  // Platforms used by the itinerary (filtered by platform_key)
  map.addLayer({
    id: "mtr-platforms-circle",
    type: "circle",
    source: "mtr-platforms",
    filter: neverPlatformFilter(),
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        11,
        5,
        14,
        7,
        17,
        9,
      ],
      "circle-color": "#5EB6E4",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.4,
      "circle-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "mtr-platforms-label",
    type: "symbol",
    source: "mtr-platforms",
    filter: neverPlatformFilter(),
    minzoom: 13,
    layout: {
      "text-field": [
        "concat",
        "P",
        ["coalesce", ["get", "ref"], ""],
      ],
      "text-size": 10,
      "text-font": ["Noto Sans Bold"],
      "text-offset": [0, 1.15],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#cfe8ff",
      "text-halo-color": "#000000",
      "text-halo-width": 1.2,
    },
  });

  map.addLayer({
    id: "mtr-exits-circle",
    type: "circle",
    source: "mtr-exits",
    filter: neverFilter(),
    minzoom: 14,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        14,
        4,
        17,
        7,
      ],
      "circle-color": "#F7943E",
      "circle-stroke-color": "#1a0a00",
      "circle-stroke-width": 1,
      "circle-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "mtr-exits-label",
    type: "symbol",
    source: "mtr-exits",
    filter: neverFilter(),
    minzoom: 15,
    layout: {
      "text-field": ["coalesce", ["get", "ref"], ["get", "name_en"]],
      "text-size": 10,
      "text-font": ["Noto Sans Bold"],
      "text-offset": [0, 0],
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#1a0a00",
      "text-halo-color": "#F7943E",
      "text-halo-width": 1.5,
    },
  });
}

/** Match nothing (hide layer until a plan sets codes). */
function neverFilter() {
  return ["==", ["get", "station_code"], "__none__"];
}

function neverPlatformFilter() {
  return ["==", ["get", "platform_key"], "__none__"];
}

/**
 * Show exits for stations on the route + only the platforms the plan uses.
 * Does not draw station centroids.
 * @param {import('maplibre-gl').Map} map
 * @param {{ stationCodes?: string[], platformKeys?: string[] } | string[] | null} opts
 */
export function setRouteStationCodes(map, opts) {
  // Back-compat: array of codes only
  let stationCodes = [];
  let platformKeys = [];
  if (Array.isArray(opts)) {
    stationCodes = opts;
  } else if (opts && typeof opts === "object") {
    stationCodes = opts.stationCodes || [];
    platformKeys = opts.platformKeys || [];
  }

  const codes = [
    ...new Set(
      stationCodes
        .map((c) => String(c || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const keys = [
    ...new Set(platformKeys.map((k) => String(k || "").trim()).filter(Boolean)),
  ];
  activeStationCodes = codes;

  const exitFilter =
    codes.length === 0
      ? neverFilter()
      : ["in", ["get", "station_code"], ["literal", codes]];

  const platFilter =
    keys.length === 0
      ? neverPlatformFilter()
      : ["in", ["get", "platform_key"], ["literal", keys]];

  if (map.getLayer("mtr-exits-circle")) map.setFilter("mtr-exits-circle", exitFilter);
  if (map.getLayer("mtr-exits-label")) map.setFilter("mtr-exits-label", exitFilter);
  if (map.getLayer("mtr-platforms-circle")) {
    map.setFilter("mtr-platforms-circle", platFilter);
  }
  if (map.getLayer("mtr-platforms-label")) {
    map.setFilter("mtr-platforms-label", platFilter);
  }
}

/**
 * Pick the best platform feature for a plan stop on an MTR leg.
 * Prefer: explicit platform ref → line/route name match → nearest to stop.
 * Light Rail uses OSM stop_positions in lrt-platforms.geojson.
 * @param {{ stop_name?: string, platform?: string, location?: { lat: number, lon: number }, lat?: number, lon?: number }} stop
 * @param {{ route_short_name?: string, route_name?: string, route_id?: string, mode?: string, agency?: { id?: string, name?: string } }} [opt]
 * @returns {{ lon: number, lat: number, platform_key: string, ref: string, name_en: string, station_code: string, station_name: string } | null}
 */
export function resolvePlatformForStop(stop, opt = {}) {
  if (!stop) return null;

  // Light Rail: prefer hand-corrected Tin Wing YOHO West platforms, then OSM
  if (looksLikeLrtOption(opt) || looksLikeLrtStopName(stop)) {
    const tw = resolveTinWingOverride(stop);
    if (tw) return tw;
    const lrt = resolveLrtPlatformPoint(stop);
    if (lrt) return lrt;
  }

  if (!platformsFc?.features?.length) {
    // Still try LRT if heavy platforms missing
    return resolveLrtPlatformPoint(stop);
  }

  const rawName = String(stop.stop_name || stop.address || "");
  // Parse "East Tsim Sha Tsui (Platform 2)" → platform ref when field missing
  const platFromName =
    rawName.match(/\(\s*platform\s*(\d+)\s*\)/i)?.[1] ||
    rawName.match(/\bplatform\s*(\d+)\b/i)?.[1] ||
    "";
  const stationName = rawName
    .replace(/\s*\(platform[^)]*\)/gi, "")
    .replace(/\s*platform\s*\d+/gi, "")
    .replace(/\s+station$/i, "")
    .trim();
  const code =
    stationCodeFromName(stationName) ||
    stationCodeFromName(rawName) ||
    stationCodeFromName(formatLooseName(stop));
  if (!code) {
    // Unknown heavy-rail code — try LRT name match
    return resolveLrtPlatformPoint(stop);
  }

  const plats = platformsFc.features.filter(
    (f) => String(f.properties?.station_code || "").toUpperCase() === code,
  );
  if (!plats.length) {
    return resolveLrtPlatformPoint(stop);
  }

  const pref = String(
    stop.platform || stop.platform_code || platFromName || "",
  ).trim();
  let best = null;

  if (pref) {
    best = plats.find((f) => String(f.properties?.ref || "") === pref) || null;
  }

  if (!best) {
    const lineHints = lineHintsFromOption(opt);
    if (lineHints.length) {
      let scoreBest = -1;
      for (const f of plats) {
        const n = String(f.properties?.name_en || "").toLowerCase();
        let s = 0;
        for (const h of lineHints) {
          if (n.includes(h)) s += 1;
        }
        if (s > scoreBest) {
          scoreBest = s;
          best = f;
        }
      }
      if (scoreBest <= 0) best = null;
    }
  }

  if (!best) {
    const lon = stop.location?.lon ?? stop.lon;
    const lat = stop.location?.lat ?? stop.lat;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      let minD = Infinity;
      for (const f of plats) {
        const [plon, plat] = f.geometry.coordinates;
        const d = (plon - lon) ** 2 + (plat - lat) ** 2;
        if (d < minD) {
          minD = d;
          best = f;
        }
      }
    } else {
      best = plats[0];
    }
  }

  if (!best?.geometry?.coordinates) return null;
  const [lon, lat] = best.geometry.coordinates;
  const st = findStationByName(stationName) || findStationByCode(code);
  return {
    lon,
    lat,
    platform_key: best.properties.platform_key,
    ref: String(best.properties.ref || ""),
    name_en: best.properties.name_en || `Platform ${best.properties.ref || ""}`,
    station_code: code,
    station_name: st?.properties?.name_en || stationName,
  };
}

function looksLikeLrtOption(opt) {
  if (!opt) return false;
  const agency = String(opt.agency?.id || opt.agency?.name || "").toLowerCase();
  if (agency === "lr" || /light\s*rail|輕鐵/.test(agency)) return true;
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "light_rail") return true;
  if (mode === "tram" && /^(505|507|610|614|615|705|706|751|761)/i.test(opt.route_short_name || "")) {
    return true;
  }
  return false;
}

function looksLikeLrtStopName(stop) {
  const n = String(stop?.stop_name || stop?.name || "");
  if (/light\s*rail|輕鐵/i.test(n)) return true;
  if (/tin\s*wing|天榮/i.test(n)) return true;
  return false;
}

/** Tin Wing YOHO West indoor platforms (post 2026-04-24). */
function resolveTinWingOverride(stop) {
  const rawName = String(stop?.stop_name || stop?.name || stop?.address || "");
  const pref = String(stop?.platform || stop?.platform_code || "").trim();
  const platFromName =
    rawName.match(/\(\s*platform\s*(\d+)\s*\)/i)?.[1] ||
    rawName.match(/\bp\s*(\d+)\b/i)?.[1] ||
    "";
  const ref = pref || platFromName || "1";
  const ov = tinWingPlatformOverride(rawName, ref);
  if (!ov) return null;
  return {
    lon: ov.lon,
    lat: ov.lat,
    platform_key: `lrt_TWI_${ov.ref}`,
    ref: ov.ref,
    name_en: `Tin Wing · P${ov.ref}`,
    station_code: "TWI",
    station_name: "Tin Wing",
  };
}

/**
 * Snap a plan stop onto the nearest OSM LRT stop_position / platform.
 */
function resolveLrtPlatformPoint(stop) {
  if (!lrtPlatformsFc?.features?.length || !stop) return null;
  const rawName = String(stop.stop_name || stop.address || stop.name || "");
  const lon = stop.location?.lon ?? stop.lon;
  const lat = stop.location?.lat ?? stop.lat;

  // Prefer platforms sharing stop English name
  const nameKey = rawName
    .toLowerCase()
    .replace(/\blight\s*rail\b/g, "")
    .replace(/輕鐵/g, "")
    .replace(/\s+/g, " ")
    .trim();

  let candidates = lrtPlatformsFc.features;
  if (nameKey.length >= 2) {
    const named = candidates.filter((f) => {
      const en = String(f.properties?.stop_name_en || "").toLowerCase();
      const zh = String(f.properties?.name_zh || "");
      return (
        en === nameKey ||
        nameKey.includes(en) ||
        en.includes(nameKey) ||
        (zh && rawName.includes(zh))
      );
    });
    if (named.length) candidates = named;
  }

  let best = null;
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    let minD = Infinity;
    for (const f of candidates) {
      const [plon, plat] = f.geometry.coordinates;
      const d = (plon - lon) ** 2 + (plat - lat) ** 2;
      if (d < minD) {
        minD = d;
        best = f;
      }
    }
    // Require reasonable proximity (~400 m) unless name matched a shortlist
    if (best && candidates === lrtPlatformsFc.features && minD > 0.00004) {
      // ~200m^2 in deg^2 roughly; use haversine-ish: 0.004 deg ~ 400m
      const deg = Math.sqrt(minD);
      if (deg > 0.004) best = null;
    }
  } else if (candidates.length === 1 || (candidates !== lrtPlatformsFc.features && candidates.length)) {
    best = candidates[0];
  }

  if (!best?.geometry?.coordinates) return null;
  const [plon, plat] = best.geometry.coordinates;
  return {
    lon: plon,
    lat: plat,
    platform_key: best.properties.platform_key,
    ref: String(best.properties.ref || ""),
    name_en:
      best.properties.name_en ||
      best.properties.stop_name_en ||
      rawName,
    station_code: String(best.properties.station_code || best.properties.stop_code || ""),
    station_name: best.properties.stop_name_en || rawName,
  };
}

function formatLooseName(stop) {
  return String(stop?.stop_name || stop?.name || "").trim();
}

function findStationByCode(code) {
  if (!stationsFc?.features || !code) return null;
  const c = String(code).toUpperCase();
  return (
    stationsFc.features.find(
      (f) => String(f.properties?.station_code || "").toUpperCase() === c,
    ) || null
  );
}

/** Keywords from GTFS route names for matching platform name_en. */
function lineHintsFromOption(opt) {
  const raw = `${opt.route_short_name || ""} ${opt.route_name || ""} ${opt.route_id || ""}`.toLowerCase();
  const hints = [];
  const map = [
    [/eal|east\s*rail/, "east rail"],
    [/twl|tsuen\s*wan/, "tsuen wan"],
    [/isl|island/, "island"],
    [/ktl|kwun\s*tong/, "kwun tong"],
    [/tml|tuen\s*ma/, "tuen ma"],
    [/tcl|tung\s*chung/, "tung chung"],
    [/tkl|tseung\s*kwan\s*o/, "tseung kwan o"],
    [/ael|airport/, "airport"],
    [/sil|south\s*island/, "south island"],
    [/drl|disneyland/, "disneyland"],
  ];
  for (const [re, hint] of map) {
    if (re.test(raw)) hints.push(hint);
  }
  // also add short tokens
  for (const m of raw.match(/\b(eal|twl|isl|ktl|tml|tcl|tkl|ael|sil|drl)\b/g) || []) {
    hints.push(m);
  }
  return [...new Set(hints)];
}

/**
 * Normalize a free-text station label for matching.
 * Strips platform / "Station" / "MTR" noise; keeps East/West distinction.
 */
function normalizeStationQuery(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[·•]/g, " ")
    .replace(/\s+station(\s*[-–]\s*mtr)?$/i, "")
    .replace(/\s*[-–]\s*mtr$/i, "")
    .replace(/\s*\(platform[^)]*\)/gi, "")
    .replace(/\s*platform\s*\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Directional / "East" markers that must match both sides of a pair. */
function stationDirectionKey(s) {
  const t = String(s || "").toLowerCase();
  const keys = [];
  if (/^east\s+|\s+east$|尖東|東$/.test(t) && !/eastern|east\s*rail/.test(t)) {
    keys.push("east");
  }
  if (/^west\s+|\s+west$|西$/.test(t) && !/western|west\s*rail|west\s*kowloon/.test(t)) {
    keys.push("west");
  }
  if (/^south\s+|\s+south$|南$/.test(t) && !/south\s*island/.test(t)) {
    keys.push("south");
  }
  if (/^north\s+|\s+north$|北$/.test(t)) keys.push("north");
  return keys.sort().join(",");
}

function directionCompatible(query, stationName) {
  const qk = stationDirectionKey(query);
  const sk = stationDirectionKey(stationName);
  // "Tsim Sha Tsui" must not match "East Tsim Sha Tsui"
  // "East Tsim Sha Tsui" must not match "Tsim Sha Tsui"
  return qk === sk;
}

/**
 * Find station feature by English / Chinese name.
 * Prefers exact matches; never collapses East/West parent pairs via substring.
 * @param {string} nameEn
 */
export function findStationByName(nameEn) {
  if (!stationsFc?.features || !nameEn) return null;
  const raw = String(nameEn).trim();
  const q = normalizeStationQuery(raw);
  if (!q) return null;

  let best = null;
  let bestScore = -1;

  for (const f of stationsFc.features) {
    const en = String(f.properties?.name_en || "").toLowerCase().trim();
    const zh = String(f.properties?.name_zh || "").trim();
    if (!en && !zh) continue;

    let score = -1;

    // Chinese exact / contained (尖東, 尖沙咀, …)
    if (zh) {
      if (raw.includes(zh) || q.includes(zh.toLowerCase())) {
        // Prefer longer Chinese names when several match (旺角東 over 旺角)
        score = Math.max(score, 900 + zh.length);
      }
    }

    if (en) {
      if (en === q) {
        score = Math.max(score, 1000);
      } else if (directionCompatible(q, en)) {
        // Query is station name + trailing junk already mostly stripped
        if (q.startsWith(en) && q.length > en.length) {
          const rem = q.slice(en.length).trim();
          if (!rem || /^(mtr|港鐵)$/i.test(rem)) score = Math.max(score, 850);
        } else if (en.startsWith(q) && en.length > q.length) {
          // Station longer than query with same direction — weak; only if remainder is not a new place word
          const rem = en.slice(q.length).trim();
          // "sha tin wai" vs "sha tin" → rem "wai" → reject (different station)
          if (!rem) score = Math.max(score, 800);
        } else if (q.includes(en) && en.length >= 4) {
          const rem = q.replace(en, " ").replace(/\s+/g, " ").trim();
          if (!rem || /^(mtr|港鐵)$/i.test(rem)) score = Math.max(score, 700);
        }
      }
      // Intentionally no bare en.includes(q) / q.includes(en) without direction check —
      // that made "Tsim Sha Tsui" → ETS and "Mong Kok" → MKK.
    }

    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }

  // Require a solid match (exact / zh / clean prefix) — not weak noise
  return bestScore >= 700 ? best : null;
}

/**
 * Resolve stop / station name → station_code when known.
 * @param {string} name
 * @returns {string | null}
 */
export function stationCodeFromName(name) {
  const f = findStationByName(name);
  return f?.properties?.station_code || null;
}

/**
 * Build a MapLibre popup HTML for an exit / station feature.
 */
export function featurePopupHtml(feature) {
  const p = feature.properties || {};
  if (p.ref || p.exit_key) {
    return `<div class="mtr-popup">
      <strong>Exit ${escape(p.ref || "")}</strong>
      <div>${escape(p.name_en || "")} ${p.name_zh ? `· ${escape(p.name_zh)}` : ""}</div>
      <div class="muted">${escape(p.station_code || "")} ${p.level_name_en ? `· ${escape(p.level_name_en)}` : ""}</div>
    </div>`;
  }
  if (p.station_code && p.name_en) {
    const lines = Array.isArray(p.lines) ? p.lines.join(" · ") : p.lines || "";
    return `<div class="mtr-popup">
      <strong>${escape(p.name_en)}</strong>
      ${p.name_zh ? `<div>${escape(p.name_zh)}</div>` : ""}
      <div class="muted">${escape(p.station_code)} ${lines ? `· ${escape(lines)}` : ""}</div>
      <div class="muted">${Array.isArray(p.exits) ? p.exits.length : 0} exits</div>
    </div>`;
  }
  if (p.platform_key || (p.ref && p.station_code && !p.exit_key)) {
    return `<div class="mtr-popup">
      <strong>${escape(p.name_en || `Platform ${p.ref || p.platform_ref || ""}`)}</strong>
      <div class="muted">${escape(p.station_code || "")}</div>
    </div>`;
  }
  // Route stop feature (from plan) — may already be platform-snapped
  if (p.stop_name || p.role) {
    return `<div class="mtr-popup">
      <strong>${escape(p.stop_name || "Stop")}</strong>
      ${p.route ? `<div>${escape(p.route)}</div>` : ""}
      <div class="muted">${escape(p.role || "")}${
        p.platform_ref ? ` · P${escape(p.platform_ref)}` : ""
      }${p.mode ? ` · ${escape(p.mode)}` : ""}</div>
    </div>`;
  }
  return "";
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sync mtrStations-style entries from stations.geojson for search.
 * @returns {Array<{ name_en: string, name_zh?: string, lat: number, lon: number, code?: string }>}
 */
export function stationsFromGeoJson() {
  if (!stationsFc?.features) return [];
  return stationsFc.features
    .map((f) => {
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return null;
      return {
        name_en: f.properties?.name_en,
        name_zh: f.properties?.name_zh,
        lat: c[1],
        lon: c[0],
        code: f.properties?.station_code,
      };
    })
    .filter((s) => s?.name_en && Number.isFinite(s.lat));
}
