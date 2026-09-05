/**
 * Contributor UI: load a calculated densified bus path by route search,
 * edit path turns + visual stop pins, submit for mod review.
 *
 * Official stop coords (open data) stay fixed & merged — used for identity only.
 * Visual stop pins can be moved for map display of the route.
 *
 * Layout: left panel; main toolbar hidden while active. Desktop only.
 */

import {
  buildPathContributionDraft,
  submitPathContribution,
  matchBusShapeForRoute,
  matchSimilarBusShapeOverride,
  applyVisualStopsFromShape,
  busShapeToPolyline,
} from "./busShapes.js";
import {
  densifyStopsViaOsrm,
  projectStops,
  followRoadsPath,
  sliceRouteBetweenStops,
} from "./routeSnapper.js";
import { mergeStopSequence } from "./stopMerge.js";
import { LRT_STOPS } from "./lrtStops.js";
import { t } from "./lang.js";

const ETA = "/eta";

/** @type {Map<string, any>} */
const cache = new Map();
const FETCH_CACHE_MAX = 48;

function rememberBounded(map, key, value, max) {
  map.set(key, value);
  if (map.size <= max) return;
  const oldest = map.keys().next().value;
  if (oldest && oldest !== key) map.delete(oldest);
}

/**
 * @param {string} url
 * @param {number} [ttlMs]
 */
async function fetchJson(url, ttlMs = 300_000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const data = await res.json();
  rememberBounded(cache, url, { t: Date.now(), data }, FETCH_CACHE_MAX);
  return data;
}

/**
 * @typedef {{
 *   stopId: string,
 *   name: string,
 *   seq: number,
 *   officialLon: number,
 *   officialLat: number,
 *   visualLon: number,
 *   visualLat: number,
 * }} ContribStop
 */

/**
 * Load ordered stops for a route bound (merged), densify path via OSRM,
 * and project initial visual stop pins onto the path.
 * Official coords are never overwritten by projection.
 *
 * @param {string} agency KMB|CTB|NLB|GMB|MTR|AEL|LRT|MTRBUS|…
 * @param {string} route
 * @param {string} direction O|I|outbound|inbound|circular|1|2
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{
 *   stops: ContribStop[],
 *   path: number[][],
 *   fromName: string,
 *   toName: string,
 *   direction: string,
 *   pathSource: "override" | "similar" | "osrm",
 *   overrideId?: string,
 *   overrideNotes?: string,
 *   overrideFromMatch?: string[],
 *   overrideToMatch?: string[],
 *   similarFromRoute?: string,
 * }>}
 */
export async function loadCalculatedRoutePath(agency, route, direction, opts = {}) {
  const ag = String(agency || "").toUpperCase();
  const r = String(route || "").trim().toUpperCase();
  if (!ag || !r) throw new Error(t("Operator and route required"));

  const raw = await fetchRouteStops(ag, r, direction, opts);
  if (raw.length < 2) {
    throw new Error(
      t("No stops found for {ag} {r} ({dir})", { ag, r, dir: direction || t("default") }),
    );
  }

  // Fixed official stops — merge duplicates (public code / name+proximity)
  const merged = mergeStopSequence(
    raw.map((s) => ({
      stop_id: s.stopId,
      id: s.stopId,
      stop_name: s.name,
      name: s.name,
      lon: s.lon,
      lat: s.lat,
    })),
    { nearbyM: 90 },
  );

  /** @type {Array<{ stopId: string, name: string, lon: number, lat: number }>} */
  const official = merged.map((s, i) => ({
    stopId: String(s.stop_id || s.id || `seq-${i}`),
    name: String(s.stop_name || s.name || s.stopId || t("Stop {n}", { n: i + 1 })),
    lon: Number(s.lon),
    lat: Number(s.lat),
  })).filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));

  if (official.length < 2) {
    throw new Error(t("No usable stops after merge for {ag} {r}", { ag, r }));
  }

  const fromName = official[0]?.name || "";
  const toName = official[official.length - 1]?.name || "";
  const stopPts = official.map((s) => ({
    lon: s.lon,
    lat: s.lat,
    id: s.stopId,
  }));

  // 1) Exact published override for this route/bound
  const hit = matchBusShapeForRoute({
    agency: ag,
    route_short_name: r,
    direction,
    from: fromName,
    to: toName,
    stops: stopPts,
  });

  /** @type {number[][]} */
  let path;
  /** @type {"override" | "similar" | "osrm"} */
  let pathSource = "osrm";
  /** @type {string | undefined} */
  let overrideId;
  /** @type {string | undefined} */
  let overrideNotes;
  /** @type {string | undefined} */
  let similarFromRoute;
  /** @type {ReturnType<typeof matchBusShapeForRoute>} */
  let usedHit = hit;

  if (hit?.shape?.coordinates?.length >= 2 && !hit.similar) {
    path = hit.shape.coordinates
      .map((c) => {
        if (!Array.isArray(c) || c.length < 2) return null;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        return [lon, lat];
      })
      .filter(Boolean);
    if (path.length >= 2) {
      pathSource = "override";
      overrideId = String(hit.shape.id || "");
      overrideNotes = String(hit.shape.notes || "");
    } else {
      path = [];
    }
  }

  // 2) Similar published path from another route (shared corridor)
  if ((!path || path.length < 2) && hit?.similar && hit.shape) {
    usedHit = hit;
    const poly = busShapeToPolyline(hit.shape, stopPts, sliceRouteBetweenStops);
    if (poly?.length >= 2) {
      path = poly.map((p) => [p.lon, p.lat]);
      pathSource = "similar";
      overrideId = String(hit.shape.id || "");
      overrideNotes = String(hit.shape.notes || "");
      similarFromRoute = String(hit.shape.route_short_name || hit.shape.id || "");
    }
  }

  if (!path || path.length < 2) {
    const similar = matchSimilarBusShapeOverride(stopPts, {
      excludeRoute: r,
      preferAgency: ag,
    });
    if (similar?.shape) {
      const poly = busShapeToPolyline(
        similar.shape,
        stopPts,
        sliceRouteBetweenStops,
      );
      if (poly?.length >= 2) {
        path = poly.map((p) => [p.lon, p.lat]);
        pathSource = "similar";
        overrideId = String(similar.shape.id || "");
        overrideNotes = String(similar.shape.notes || "");
        similarFromRoute = String(
          similar.shape.route_short_name || similar.shape.id || "",
        );
        usedHit = {
          shape: similar.shape,
          score: similar.score,
          similar: true,
        };
      }
    }
  }

  // 3) Live densify: rail → basemap tracks; surface → OSRM
  if (!path || path.length < 2) {
    const stopLngLats = official.map((s) => ({ lon: s.lon, lat: s.lat }));
    if (isRailContributeAgency(ag)) {
      try {
        const { densifyAlongBasemapRail } = await import("./railSnapper.js");
        const railPoly = await densifyAlongBasemapRail(
          stopLngLats.map((s, i) => ({
            ...s,
            stop_name: official[i]?.name || "",
            name: official[i]?.name || "",
          })),
          {
            route_short_name: ag === "AEL" ? "AEL" : r,
            route_id: ag === "LRT" ? `LRT-${r}` : `MTR-${ag === "AEL" ? "AEL" : r}`,
            mode: ag === "LRT" ? "light_rail" : "subway",
          },
          { signal: opts.signal },
        );
        if (railPoly?.length >= 2) {
          path = railPoly.map((p) => [p.lon, p.lat]);
          pathSource = "osrm"; // generic live densify label
        }
      } catch (e) {
        console.warn("[contribute] rail densify", e);
      }
    }
    if (!path || path.length < 2) {
      const densified = await densifyStopsViaOsrm(stopLngLats, {
        signal: opts.signal,
      });
      path = densified.map((p) => [p.lon, p.lat]);
    }
    pathSource = pathSource === "override" || pathSource === "similar" ? pathSource : "osrm";
    if (pathSource === "osrm") {
      overrideId = undefined;
      overrideNotes = undefined;
      similarFromRoute = undefined;
      usedHit = null;
    }
  }

  const routeLine = path.map((c) => ({ lon: c[0], lat: c[1] }));

  // Initial visual = projection onto path (display only)
  const projected = projectStops(
    routeLine,
    official.map((s, i) => ({
      id: s.stopId || String(i),
      lon: s.lon,
      lat: s.lat,
    })),
  );

  /** @type {ContribStop[]} */
  let stops = official.map((s, i) => {
    const p = projected[i];
    const useProj = p && Number.isFinite(p.lon) && Number.isFinite(p.lat);
    return {
      stopId: s.stopId,
      name: s.name,
      seq: i,
      officialLon: s.lon,
      officialLat: s.lat,
      visualLon: useProj ? p.lon : s.lon,
      visualLat: useProj ? p.lat : s.lat,
    };
  });

  // Apply published visual_stops only for exact route overrides (not borrowed)
  if (pathSource === "override" && usedHit?.shape?.visual_stops?.length) {
    /** @type {object[]} */
    const fakeFeats = stops.map((s, i) => ({
      properties: {
        stop_id: s.stopId,
        stop_index: i,
      },
      geometry: {
        type: "Point",
        coordinates: [s.visualLon, s.visualLat],
      },
    }));
    applyVisualStopsFromShape(fakeFeats, usedHit.shape);
    stops = stops.map((s, i) => {
      const g = fakeFeats[i]?.geometry?.coordinates;
      if (!Array.isArray(g) || g.length < 2) return s;
      const lon = Number(g[0]);
      const lat = Number(g[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return s;
      return { ...s, visualLon: lon, visualLat: lat };
    });
  }

  return {
    stops,
    path,
    fromName,
    toName,
    direction: direction || "",
    pathSource,
    overrideId,
    overrideNotes,
    similarFromRoute,
    overrideFromMatch:
      pathSource === "override" && usedHit?.shape?.from_match?.length
        ? usedHit.shape.from_match.map(String)
        : undefined,
    overrideToMatch:
      pathSource === "override" && usedHit?.shape?.to_match?.length
        ? usedHit.shape.to_match.map(String)
        : undefined,
  };
}

/**
 * @param {string} ag
 * @param {string} route
 * @param {string} direction
 * @param {{ serviceType?: string|number }} [opts]
 */
async function fetchRouteStops(ag, route, direction, opts = {}) {
  if (ag === "KMB" || ag === "LWB" || ag === "MTRBUS") {
    // MTR Bus often shares KMB open-data route tables
    return fetchKmbStops(route, direction, opts.serviceType);
  }
  if (ag === "CTB" || ag === "NWFB") {
    return fetchCtbStops(route, direction);
  }
  if (ag === "NLB") {
    return fetchNlbStops(route);
  }
  if (ag === "GMB") {
    return fetchGmbStops(route, direction);
  }
  if (ag === "AEL") {
    return fetchMtrLineStops("AEL", direction);
  }
  if (ag === "MTR") {
    return fetchMtrLineStops(route, direction);
  }
  if (ag === "LRT") {
    return fetchLrtRouteStops(route, direction);
  }
  throw new Error(
    t("Load path not supported for operator {ag} yet — use From plan or draw", { ag }),
  );
}

function isRailContributeAgency(ag) {
  const a = String(ag || "").toUpperCase();
  return a === "MTR" || a === "AEL" || a === "LRT";
}

/** Station order for heavy rail / AEL (codes match stations.geojson). */
const MTR_LINE_ORDER = {
  TCL: ["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"],
  AEL: ["HOK", "KOW", "TSY", "AIR", "AWE"],
  ISL: [
    "KET", "HKU", "SYP", "SHW", "CEN", "ADM", "WAC", "CAB", "TIH", "FOH",
    "NOP", "QUB", "TAK", "SWH", "SKW", "HFC", "CHW",
  ],
  TWL: [
    "CEN", "ADM", "TST", "JOR", "YMT", "MOK", "PRE", "SSP", "CSW", "LCK",
    "MEF", "LAK", "KWF", "KWH", "TWH", "TSW",
  ],
  EAL: [
    "ADM", "EXC", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", "RAC", "UNI",
    "TAP", "TWO", "FAN", "SHS", "LOW", "LMC",
  ],
  TML: [
    "WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", "TAW", "HIK",
    "DIH", "KAT", "SUW", "TKW", "HOM", "HUH", "ETS", "AUS", "NAC", "MEF",
    "TWW", "KSR", "YUL", "LOP", "TIS", "SIH", "TUM",
  ],
  TKL: ["NOP", "QUB", "YAT", "TIK", "TKO", "HAH", "POA", "LHP"],
  SIL: ["ADM", "OCP", "WCH", "LET", "SOH"],
  KTL: [
    "WHA", "HOM", "YMT", "MOK", "PRE", "SKM", "KOT", "LOF", "WTS", "DIH",
    "CHH", "KOB", "NTK", "KWT", "LAT", "YAT", "TIK",
  ],
  DRL: ["SUN", "DIS"],
};

/**
 * MTR / AEL station list from local GeoJSON + official line order.
 * @param {string} lineCode e.g. TWL, AEL
 * @param {string} direction O = order as listed (UP-ish), I = reverse
 */
async function fetchMtrLineStops(lineCode, direction) {
  let line = String(lineCode || "").trim().toUpperCase();
  // Allow "Airport Express" / full names
  if (/AIRPORT|AEL/.test(line)) line = "AEL";
  if (line === "MTR") {
    throw new Error(t("Enter an MTR line code: TWL, ISL, KTL, TML, EAL, TCL, TKL, SIL, DRL, AEL"));
  }
  const order = MTR_LINE_ORDER[line];
  if (!order?.length) {
    throw new Error(
      t("Unknown MTR line “{line}”. Try TWL, ISL, KTL, TML, EAL, TCL, TKL, SIL, DRL, or AEL.", { line: lineCode }),
    );
  }
  const base =
    (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(`${root}mtr/stations.geojson`, window.location.href).href;
  const geo = await fetchJson(url, 3600_000);
  /** @type {Map<string, { lon: number, lat: number, name: string }>} */
  const byCode = new Map();
  for (const f of geo?.features || []) {
    const p = f.properties || {};
    const code = String(p.station_code || "").toUpperCase();
    if (!code) continue;
    const g = f.geometry;
    let lon;
    let lat;
    if (g?.type === "Point" && Array.isArray(g.coordinates)) {
      lon = Number(g.coordinates[0]);
      lat = Number(g.coordinates[1]);
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    byCode.set(code, {
      lon,
      lat,
      name: p.name_en || p.name_zh || code,
    });
  }
  let codes = [...order];
  const d = String(direction || "").toLowerCase();
  if (d === "i" || d === "inbound" || d.includes("down") || d === "2") {
    codes = codes.reverse();
  }
  /** @type {Array<{ lon: number, lat: number, name: string, stopId: string }>} */
  const out = [];
  for (const c of codes) {
    const s = byCode.get(c);
    if (!s) continue;
    out.push({
      stopId: `MTR-${c}`,
      lon: s.lon,
      lat: s.lat,
      name: s.name,
    });
  }
  if (out.length < 2) {
    throw new Error(t("No station coords found for MTR {line}", { line }));
  }
  return out;
}

/**
 * LRT route stop sequence from MTR open-data CSV + LRT_STOPS coords.
 * @param {string} route e.g. 505
 * @param {string} direction 1/O or 2/I
 */
async function fetchLrtRouteStops(route, direction) {
  const r = String(route || "").trim();
  if (!r) throw new Error(t("LRT route number required (e.g. 505, 507, 610)"));
  const dirRaw = String(direction || "O").toLowerCase();
  const dir =
    dirRaw === "i" || dirRaw === "inbound" || dirRaw === "2" || dirRaw.includes("down")
      ? "2"
      : "1";

  const csvText = await fetchText(
    `${ETA}/mtr-open/data/light_rail_routes_and_stops.csv`,
    6 * 3600_000,
  );
  // CSV may have BOM
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(t("LRT route CSV empty"));

  /** @type {Map<string, { lat: number, lon: number, name_en: string, code?: string, stop_id?: string }>} */
  const byCode = new Map();
  /** @type {Map<string, typeof byCode extends Map<string, infer V> ? V : never>} */
  const byStopId = new Map();
  for (const s of LRT_STOPS) {
    if (s.code) byCode.set(String(s.code).toUpperCase(), s);
    if (s.stop_id) byStopId.set(String(s.stop_id), s);
  }

  // Line Code,Direction,Stop Code,Stop ID,Chinese Name,English Name,Sequence
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const lineCode = String(cols[0] || "").trim();
    const directionCol = String(cols[1] || "").trim();
    if (lineCode !== r) continue;
    if (directionCol !== dir) continue;
    rows.push({
      stopCode: String(cols[2] || "").trim().toUpperCase(),
      stopId: String(cols[3] || "").trim(),
      nameEn: String(cols[5] || "").trim(),
      seq: Number(cols[6]) || i,
    });
  }
  rows.sort((a, b) => a.seq - b.seq);
  if (!rows.length) {
    throw new Error(
      t("No LRT stops for route {r} direction {dir}. Check route no. (e.g. 505).", { r, dir }),
    );
  }

  /** @type {Array<{ lon: number, lat: number, name: string, stopId: string }>} */
  const out = [];
  for (const row of rows) {
    const hit =
      byCode.get(row.stopCode) ||
      byStopId.get(row.stopId) ||
      LRT_STOPS.find(
        (s) =>
          String(s.name_en || "").toLowerCase() === row.nameEn.toLowerCase(),
      );
    if (!hit || !Number.isFinite(hit.lon) || !Number.isFinite(hit.lat)) continue;
    out.push({
      stopId: `LRT-${row.stopId || row.stopCode}`,
      lon: hit.lon,
      lat: hit.lat,
      name: hit.name_en || row.nameEn || row.stopCode,
    });
  }
  if (out.length < 2) {
    throw new Error(t("Could not resolve LRT coords for route {r}", { r }));
  }
  return out;
}

/**
 * GMB route stops via data.etagmb.gov.hk (region auto-search).
 * @param {string} route route code e.g. 1, 44
 * @param {string} direction O/1 or I/2
 */
async function fetchGmbStops(route, direction) {
  const code = String(route || "").trim().toUpperCase();
  if (!code) throw new Error(t("GMB route code required"));
  const dirRaw = String(direction || "O").toLowerCase();
  const routeSeq =
    dirRaw === "i" || dirRaw === "inbound" || dirRaw === "2" ? 2 : 1;

  const all = await fetchJson(`${ETA}/gmb/route/`, 3600_000);
  const byRegion = all?.data?.routes || {};
  /** @type {{ region: string, route_id: number } | null} */
  let found = null;

  for (const region of ["HKI", "KLN", "NT"]) {
    const codes = byRegion[region] || [];
    const hit = codes.find((c) => String(c).toUpperCase() === code);
    if (!hit) continue;
    const detail = await fetchJson(
      `${ETA}/gmb/route/${region}/${encodeURIComponent(hit)}`,
      3600_000,
    );
    const entries = Array.isArray(detail?.data) ? detail.data : [];
    // Prefer normal departure with matching route_seq
    for (const e of entries) {
      const dirs = e.directions || [];
      if (!dirs.some((d) => Number(d.route_seq) === routeSeq)) continue;
      found = { region, route_id: Number(e.route_id) };
      break;
    }
    if (!found && entries[0]?.route_id) {
      found = { region, route_id: Number(entries[0].route_id) };
    }
    if (found) break;
  }

  if (!found?.route_id) {
    throw new Error(
      t("GMB route {code} not found. Try the public code (e.g. 1, 44A).", { code }),
    );
  }

  const stopData = await fetchJson(
    `${ETA}/gmb/route-stop/${found.route_id}/${routeSeq}`,
    3600_000,
  );
  const stops = stopData?.data?.route_stops || stopData?.data || [];
  if (!Array.isArray(stops) || !stops.length) {
    throw new Error(t("No GMB stops for {code} seq {seq}", { code, seq: routeSeq }));
  }

  // Parallel stop coordinate lookups
  const details = await Promise.all(
    stops.map(async (s) => {
      const sid = s.stop_id;
      try {
        const d = await fetchJson(`${ETA}/gmb/stop/${sid}`, 3600_000);
        const wgs = d?.data?.coordinates?.wgs84;
        return {
          stopId: String(sid),
          lon: Number(wgs?.longitude),
          lat: Number(wgs?.latitude),
          name: s.name_en || s.name_tc || String(sid),
        };
      } catch {
        return null;
      }
    }),
  );

  return details.filter(
    (s) => s && Number.isFinite(s.lon) && Number.isFinite(s.lat),
  );
}

/** @type {Map<string, { t: number, text: string }>} */
const textCache = new Map();

/**
 * @param {string} url
 * @param {number} [ttlMs]
 */
async function fetchText(url, ttlMs = 300_000) {
  const hit = textCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.text;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const text = await res.text();
  rememberBounded(textCache, url, { t: Date.now(), text }, FETCH_CACHE_MAX);
  return text;
}

/** Minimal CSV line parser (handles quoted fields). */
function parseCsvLine(line) {
  /** @type {string[]} */
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchKmbStops(route, direction, serviceType = null) {
  const bound = normalizeBound(direction, "kmb");
  const dirPath = bound === "I" ? "inbound" : "outbound";
  const types = [];
  const st = Number(serviceType);
  if (Number.isFinite(st) && st >= 1) types.push(st);
  for (const n of [1, 2, 3, 4, 5, 6]) if (!types.includes(n)) types.push(n);
  let rows = [];
  for (const stype of types) {
    try {
      const data = await fetchJson(
        `${ETA}/kmb/route-stop/${encodeURIComponent(route)}/${dirPath}/${stype}`,
      );
      const got = (data?.data || [])
        .slice()
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      if (got.length >= 2) {
        rows = got;
        break;
      }
    } catch {
      /* try next service type */
    }
  }
  if (!rows.length) return [];

  // Stop master list
  const stopData = await fetchJson(`${ETA}/kmb/stop`);
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const s of stopData?.data || []) {
    byId.set(String(s.stop), s);
  }

  /** @type {Array<{ lon: number, lat: number, name: string, stopId: string }>} */
  const out = [];
  for (const r of rows) {
    const sid = String(r.stop || "");
    const s = byId.get(sid);
    if (!s) continue;
    const lon = Number(s.long ?? s.lng ?? s.lon);
    const lat = Number(s.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({
      stopId: sid,
      lon,
      lat,
      name: s.name_en || s.name_tc || sid,
    });
  }
  return out;
}

async function fetchCtbStops(route, direction) {
  const dir = normalizeBound(direction, "ctb");
  const data = await fetchJson(
    `${ETA}/ctb/route-stop/CTB/${encodeURIComponent(route)}/${dir}`,
  );
  const rows = [...(data?.data || [])].sort(
    (a, b) => Number(a.seq) - Number(b.seq),
  );
  /** @type {Array<{ lon: number, lat: number, name: string, stopId: string }>} */
  const out = [];
  // Parallel stop detail fetches (cap concurrency lightly)
  const ids = rows.map((r) => String(r.stop || "").padStart(6, "0"));
  const details = await Promise.all(
    ids.map(async (id) => {
      try {
        const d = await fetchJson(`${ETA}/ctb/stop/${id}`);
        return d?.data || null;
      } catch {
        return null;
      }
    }),
  );
  for (let i = 0; i < rows.length; i++) {
    const s = details[i];
    if (!s) continue;
    const lon = Number(s.long ?? s.lng);
    const lat = Number(s.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({
      stopId: String(rows[i].stop),
      lon,
      lat,
      name: s.name_en || s.name_tc || String(rows[i].stop),
    });
  }
  return out;
}

async function fetchNlbStops(route) {
  const list = await fetchJson(`${ETA}/nlb/route.php?action=list`, 6 * 3600_000);
  const routes = list?.routes || list || [];
  const hit = routes.find(
    (r) => String(r.routeNo || "").toUpperCase() === route,
  );
  if (!hit) return [];
  const data = await fetchJson(
    `${ETA}/nlb/stop.php?action=list&routeId=${encodeURIComponent(hit.routeId)}`,
  );
  const stops = data?.stops || [];
  return stops
    .map((s) => ({
      stopId: String(s.stopId || ""),
      lon: Number(s.longitude),
      lat: Number(s.latitude),
      name: s.stopName_e || s.stopName_c || String(s.stopId),
    }))
    .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));
}

/**
 * @param {string} direction
 * @param {"kmb"|"ctb"} kind
 */
function normalizeBound(direction, kind) {
  const raw = String(direction || "").trim();
  const d = raw.split("|")[0].toLowerCase();
  if (kind === "kmb") {
    if (d === "i" || d === "inbound" || d.includes("in")) return "I";
    return "O";
  }
  // ctb
  if (d === "o" || d === "outbound" || d.includes("out")) return "outbound";
  if (d === "i" || d === "inbound" || d.includes("in")) return "inbound";
  return "inbound";
}

/**
 * @param {{
 *   map: import("maplibre-gl").Map,
 *   showToast?: (msg: string, ms?: number) => void,
 *   getSelectedPlanRoute?: () => object | null,
 *   getSelectedPlanPolyline?: () => number[][] | null,
 *   searchRoutes?: (q: string) => Promise<any[]> | any[],
 *   routeDirections?: (route: any) => Promise<any[]> | any[],
 * }} ctx
 */
export function createPathContributor(ctx) {
  const {
    map,
    showToast = () => {},
    getSelectedPlanRoute,
    getSelectedPlanPolyline,
    searchRoutes = async () => [],
    routeDirections = async () => [],
    /** Clear trip/ETA route path on the map when entering contribute */
    clearRoutePath = () => {},
  } = ctx;

  /** @type {number[][]} lon,lat — dense editable path */
  let points = [];
  /** @type {ContribStop[]} Official fixed + visual editable stop pins */
  let stopMarkers = [];
  let active = false;
  let draftSourceReady = false;
  /** Path vertex drag index, or -1 */
  let dragIdx = -1;
  /** Visual stop drag index, or -1 */
  let dragStopIdx = -1;
  let loadAbort = null;
  /**
   * path = edit road turning points (default)
   * stops = edit visual stop pins (official stays fixed)
   * select = box-select path vertices (offset cleanup)
   * @type {"path"|"stops"|"select"}
   */
  let editMode = "path";
  let keyHandler = null;
  /** @type {Set<number>} selected path vertex indices */
  let selectedIdx = new Set();
  /** @type {Set<number>} vertices flagged as offset from route backbone */
  let offsetIdx = new Set();
  /** Box-select drag state (screen px, map canvas) */
  let boxSelecting = false;
  /** @type {{ x: number, y: number } | null} */
  let boxStart = null;
  /** @type {{ x: number, y: number } | null} */
  let boxEnd = null;
  /** @type {HTMLDivElement | null} */
  let boxEl = null;
  /** Offset threshold in meters for auto-select */
  const OFFSET_SELECT_M = 40;
  /** Focused path vertex (Path turns: Start here / Set as last) */
  let focusIdx = -1;
  /** Junction blockers: OSRM must not snap/densify onto these points */
  /** @type {number[][]} */
  let blockers = [];
  /** Next map click in path mode drops a blocker */
  let placingBlocker = false;
  /** True once the current vertex drag moved far enough to count as a drag */
  let dragMoved = false;

  const els = {
    sheet: document.getElementById("contribute-sheet"),
    btnOpen: document.getElementById("btn-contribute-path"),
    agency: document.getElementById("contrib-agency"),
    route: document.getElementById("contrib-route"),
    routeSearch: document.getElementById("contrib-route-search"),
    routeSuggest: document.getElementById("contrib-route-suggest"),
    dirCount: document.getElementById("contrib-dir-count"),
    from: document.getElementById("contrib-from"),
    to: document.getElementById("contrib-to"),
    direction: document.getElementById("contrib-direction"),
    notes: document.getElementById("contrib-notes"),
    name: document.getElementById("contrib-name"),
    count: document.getElementById("contrib-point-count"),
    status: document.getElementById("contrib-status"),
    modeLabel: document.getElementById("contrib-mode-label"),
    btnModePath: document.getElementById("contrib-mode-path"),
    btnModeStops: document.getElementById("contrib-mode-stops"),
    btnModeSelect: document.getElementById("contrib-mode-select"),
    btnAddBlocker: document.getElementById("contrib-add-blocker"),
    btnSetStart: document.getElementById("contrib-set-start"),
    btnSetLast: document.getElementById("contrib-set-last"),
    btnClearBlockers: document.getElementById("contrib-clear-blockers"),
    btnSelectOffsets: document.getElementById("contrib-select-offsets"),
    btnDeleteSelected: document.getElementById("contrib-delete-selected"),
    btnClearSelection: document.getElementById("contrib-clear-selection"),
    btnUndo: document.getElementById("contrib-undo"),
    btnRedo: document.getElementById("contrib-redo"),
    btnClear: document.getElementById("contrib-clear"),
    btnFromPlan: document.getElementById("contrib-from-plan"),
    btnLoad: document.getElementById("contrib-load-path"),
    btnFollowRoads: document.getElementById("contrib-follow-roads"),
    btnImport: document.getElementById("contrib-import-json"),
    importFile: document.getElementById("contrib-import-file"),
    btnDownload: document.getElementById("contrib-download"),
    btnSubmit: document.getElementById("contrib-submit"),
    btnCopy: document.getElementById("contrib-copy"),
    submitOverlay: document.getElementById("contrib-submit-overlay"),
    submitLoading: document.getElementById("contrib-submit-loading"),
    submitResult: document.getElementById("contrib-submit-result"),
    submitTitle: document.getElementById("contrib-submit-dialog-title"),
    submitMsg: document.getElementById("contrib-submit-result-msg"),
    submitMeta: document.getElementById("contrib-submit-result-meta"),
    submitIconOk: document.getElementById("contrib-submit-result-icon-ok"),
    submitIconFail: document.getElementById("contrib-submit-result-icon-fail"),
    submitVisitPr: document.getElementById("contrib-submit-visit-pr"),
    submitDownload: document.getElementById("contrib-submit-download"),
    submitCopy: document.getElementById("contrib-submit-copy"),
    submitDone: document.getElementById("contrib-submit-done"),
    modeOauth: document.getElementById("contrib-submit-mode-oauth"),
    modeBot: document.getElementById("contrib-submit-mode-bot"),
    ghUser: document.getElementById("contrib-github-user"),
    ghAvatar: document.getElementById("contrib-gh-avatar"),
    ghLoginLabel: document.getElementById("contrib-gh-login"),
    ghLogout: document.getElementById("contrib-gh-logout"),
    ghLoginRow: document.getElementById("contrib-github-login-row"),
    ghLoginBtn: document.getElementById("contrib-gh-login-btn"),
    ghLoginHint: document.getElementById("contrib-gh-login-hint"),
  };

  /** @type {object | null} last draft for post-submit download/copy */
  let lastSubmitDraft = null;

  /** @type {{ logged_in?: boolean, login?: string, name?: string, avatar?: string, oauth_configured?: boolean }} */
  let ghSession = { logged_in: false, oauth_configured: false };

  /** @returns {"oauth" | "bot"} */
  function getSubmitMode() {
    const checked = document.querySelector(
      'input[name="contrib-submit-mode"]:checked',
    );
    return checked?.value === "bot" ? "bot" : "oauth";
  }

  function updateAuthUi() {
    const mode = getSubmitMode();
    const loggedIn = !!ghSession.logged_in;
    const oauthOk = ghSession.oauth_configured !== false;

    if (els.ghUser) {
      els.ghUser.hidden = !loggedIn;
      if (loggedIn) {
        if (els.ghLoginLabel) {
          els.ghLoginLabel.textContent =
            ghSession.name && ghSession.name !== ghSession.login
              ? `${ghSession.name} (@${ghSession.login})`
              : `@${ghSession.login || ""}`;
        }
        if (els.ghAvatar) {
          if (ghSession.avatar) {
            els.ghAvatar.src = ghSession.avatar;
            els.ghAvatar.hidden = false;
          } else {
            els.ghAvatar.removeAttribute("src");
            els.ghAvatar.hidden = true;
          }
        }
      }
    }

    // Login row: show when OAuth mode and not logged in
    if (els.ghLoginRow) {
      els.ghLoginRow.hidden = mode !== "oauth" || loggedIn;
    }
    if (els.ghLoginHint) {
      if (!oauthOk && mode === "oauth") {
        els.ghLoginHint.textContent =
          "OAuth not configured on this server (set GITHUB_OAUTH_CLIENT_ID / SECRET). Use Bot account or Download JSON.";
      } else {
        els.ghLoginHint.textContent =
          'Required for “GitHub account” submit.';
      }
    }
    if (els.ghLoginBtn) {
      els.ghLoginBtn.disabled = !oauthOk;
    }

    // Soft-disable submit when OAuth needs login
    if (els.btnSubmit) {
      const needLogin = mode === "oauth" && !loggedIn;
      els.btnSubmit.title = needLogin
        ? "Log in with GitHub first (or switch to Bot account)"
        : "";
    }
  }

  async function refreshGithubAuth() {
    try {
      const res = await fetch("/api/auth/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        ghSession = await res.json();
      } else {
        ghSession = { logged_in: false, oauth_configured: false };
      }
    } catch {
      ghSession = { logged_in: false, oauth_configured: false };
    }
    updateAuthUi();
  }

  function startGithubLogin() {
    const returnTo = `${window.location.pathname}${window.location.search || ""}${window.location.hash || ""}`;
    const safe = returnTo.startsWith("/") ? returnTo : "/";
    window.location.href = `/api/auth/github?return_to=${encodeURIComponent(safe)}`;
  }

  async function logoutGithub() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      /* ignore */
    }
    ghSession = {
      logged_in: false,
      oauth_configured: ghSession.oauth_configured,
    };
    updateAuthUi();
    showToast(t("Logged out of GitHub"), 1600);
  }

  /** Path undo stack (deep copies of coordinates) */
  /** @type {number[][][]} */
  let pathHistory = [];
  /** Path redo stack (cleared on new edits) */
  /** @type {number[][][]} */
  let pathFuture = [];

  /**
   * Pending Follow-roads preview awaiting Confirm / Revert.
   * @type {{
   *   beforePath: number[][],
   *   beforeStops: ContribStop[],
   *   afterPath: number[][],
   *   debug: object | null,
   *   stats: { snapN: number, insN: number, rawN: number, densN: number, failN: number, beforeN: number, afterN: number },
   * } | null}
   */
  let followPending = null;

  /** Desktop-only: wide viewport + fine pointer (not primary touch). */
  function isDesktopContribute() {
    if (typeof window === "undefined") return false;
    const wide = window.matchMedia("(min-width: 900px)").matches;
    const fine = window.matchMedia("(pointer: fine)").matches;
    const noTouchPrimary = !window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    return wide && (fine || noTouchPrimary);
  }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg || "";
  }

  function setEditMode(mode) {
    const m =
      mode === "stops" ? "stops" : mode === "select" ? "select" : "path";
    editMode = m;
    dragIdx = -1;
    dragStopIdx = -1;
    endBoxSelect(false);
    try {
      if (editMode === "select") map.dragPan.disable();
      else map.dragPan.enable();
    } catch {
      /* ignore */
    }
    document.body.classList.toggle("contrib-edit-path", editMode === "path");
    document.body.classList.toggle("contrib-edit-stops", editMode === "stops");
    document.body.classList.toggle("contrib-edit-select", editMode === "select");
    els.btnModePath?.classList.toggle("is-active", editMode === "path");
    els.btnModeStops?.classList.toggle("is-active", editMode === "stops");
    els.btnModeSelect?.classList.toggle("is-active", editMode === "select");
    if (editMode !== "path") setPlacingBlocker(false);
    // Path-turns + Select action rows
    document.getElementById("contrib-path-actions")?.toggleAttribute(
      "hidden",
      editMode !== "path",
    );
    document.getElementById("contrib-select-actions")?.toggleAttribute(
      "hidden",
      editMode !== "select",
    );
    if (els.modeLabel) {
      els.modeLabel.textContent =
        editMode === "path"
          ? t("Mode: Path turns (V) — drag rings · arrows show direction · 1 start · 2 last")
          : editMode === "stops"
            ? t("Mode: Visual stops (S) — drag orange pins · official (grey) is fixed")
            : t("Mode: Select (B) — box-select · Follow roads snaps selected only");
    }
    // Layer visibility + dimming so path rings ≠ stop pins
    try {
      const showPathPts = editMode === "path" || editMode === "select";
      if (map.getLayer("contrib-path-pts")) {
        map.setLayoutProperty(
          "contrib-path-pts",
          "visibility",
          showPathPts ? "visible" : "none",
        );
      }
      if (map.getLayer("contrib-path-line")) {
        map.setPaintProperty(
          "contrib-path-line",
          "line-opacity",
          editMode === "stops" ? 0.45 : 0.92,
        );
        map.setPaintProperty(
          "contrib-path-line",
          "line-width",
          editMode === "stops" ? 3 : 5,
        );
      }
      if (map.getLayer("contrib-path-arrows")) {
        map.setLayoutProperty(
          "contrib-path-arrows",
          "visibility",
          editMode === "path" ? "visible" : "none",
        );
      }
      if (map.getLayer("contrib-path-end-labels")) {
        map.setLayoutProperty(
          "contrib-path-end-labels",
          "visibility",
          editMode === "path" ? "visible" : "none",
        );
      }
      if (map.getLayer("contrib-path-wrap")) {
        map.setLayoutProperty(
          "contrib-path-wrap",
          "visibility",
          editMode === "path" ? "visible" : "none",
        );
      }
      if (map.getLayer("contrib-path-blockers")) {
        map.setLayoutProperty(
          "contrib-path-blockers",
          "visibility",
          editMode === "stops" ? "none" : "visible",
        );
      }
      if (map.getLayer("contrib-stops-circle")) {
        map.setLayoutProperty("contrib-stops-circle", "visibility", "visible");
        map.setPaintProperty(
          "contrib-stops-circle",
          "circle-opacity",
          editMode === "stops" ? 1 : 0.4,
        );
        map.setPaintProperty(
          "contrib-stops-circle",
          "circle-stroke-opacity",
          1,
        );
        map.setPaintProperty(
          "contrib-stops-circle",
          "circle-radius",
          editMode === "stops" ? 9 : 5,
        );
      }
      if (map.getLayer("contrib-stops-core")) {
        map.setLayoutProperty("contrib-stops-core", "visibility", "visible");
        map.setPaintProperty(
          "contrib-stops-core",
          "circle-opacity",
          editMode === "stops" ? 1 : 0.45,
        );
      }
      if (map.getLayer("contrib-stops-label")) {
        map.setLayoutProperty(
          "contrib-stops-label",
          "visibility",
          editMode === "stops" ? "visible" : "none",
        );
      }
      // Official ghosts only useful when visual ≠ official (always in data when moved)
      if (map.getLayer("contrib-stops-official")) {
        map.setLayoutProperty(
          "contrib-stops-official",
          "visibility",
          "visible",
        );
      }
      if (editMode === "stops") {
        promoteContribStopLayers();
      }
    } catch {
      /* style not ready */
    }
    if (editMode === "select") {
      // Refresh offset flags for amber preview
      recomputeOffsetFlags();
    }
    paintDraft();
    if (editMode === "stops") {
      // After data paint, keep pins above path / follow-debug
      try {
        promoteContribStopLayers();
      } catch {
        /* ignore */
      }
    }
    setStatus(
      editMode === "path"
        ? t("Path mode: drag rings · click a ring then 1/2 for start/last · Shift+click blocker · R Follow roads")
        : editMode === "stops"
          ? stopMarkers.length
            ? t("Visual stops: {n} orange pins · grey ghost only if moved from official · drag to adjust", { n: stopMarkers.length })
            : t("Visual stops: no stops loaded — Load calculated path first")
          : t("Select mode: box-select · Follow roads snaps selected points only · Del removes", { n: OFFSET_SELECT_M }),
    );
  }

  /** Keep contrib stop pins above path line and follow-roads debug. */
  function promoteContribStopLayers() {
    if (!map) return;
    // Order: official (under) → visual fill → core → labels (top)
    const order = [
      "contrib-stops-official",
      "contrib-stops-circle",
      "contrib-stops-core",
      "contrib-stops-label",
    ];
    for (const id of order) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  }

  function ensureDraftLayer() {
    if (!map || draftSourceReady) return;
    if (!map.isStyleLoaded()) {
      map.once("load", () => ensureDraftLayer());
      return;
    }
    if (!map.getSource("contrib-path")) {
      map.addSource("contrib-path", {
        type: "geojson",
        data: emptyFc(),
        tolerance: 0,
      });
    }
    if (!map.getSource("contrib-stops")) {
      map.addSource("contrib-stops", {
        type: "geojson",
        data: emptyFc(),
      });
    }
    if (!map.getLayer("contrib-path-line")) {
      map.addLayer({
        id: "contrib-path-line",
        type: "line",
        source: "contrib-path",
        filter: ["==", ["get", "kind"], "line"],
        paint: {
          "line-color": "#7dcea0",
          "line-width": 5,
          "line-opacity": 0.92,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }
    // Path turning handles — hollow rings; selected / offset tinted in select mode
    if (!map.getLayer("contrib-path-pts")) {
      map.addLayer({
        id: "contrib-path-pts",
        type: "circle",
        source: "contrib-path",
        filter: ["==", ["get", "kind"], "vertex"],
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "selected"], 1],
            7.5,
            ["==", ["get", "focused"], 1],
            7.5,
            ["==", ["get", "anchor"], true],
            7,
            ["==", ["get", "offset"], 1],
            6,
            5,
          ],
          "circle-color": [
            "case",
            ["==", ["get", "selected"], 1],
            "#ff5c5c",
            ["==", ["get", "focused"], 1],
            "#4dabf7",
            ["==", ["get", "offset"], 1],
            "#ffb020",
            "#000000",
          ],
          "circle-opacity": [
            "case",
            ["==", ["get", "selected"], 1],
            0.85,
            ["==", ["get", "focused"], 1],
            0.75,
            ["==", ["get", "offset"], 1],
            0.55,
            0.01,
          ],
          "circle-stroke-opacity": 1,
          "circle-stroke-width": [
            "case",
            ["==", ["get", "selected"], 1],
            2.5,
            ["==", ["get", "focused"], 1],
            3,
            ["==", ["get", "anchor"], true],
            3,
            2.25,
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "selected"], 1],
            "#ffffff",
            ["==", ["get", "focused"], 1],
            "#ffffff",
            ["==", ["get", "offset"], 1],
            "#ffb020",
            ["==", ["get", "anchor"], true],
            "#c0aefc",
            "#5ee4a0",
          ],
          "circle-pitch-alignment": "viewport",
        },
      });
    }
    if (!map.getLayer("contrib-path-arrows")) {
      map.addLayer({
        id: "contrib-path-arrows",
        type: "symbol",
        source: "contrib-path",
        filter: ["==", ["get", "kind"], "line"],
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 56,
          "text-field": "▶",
          "text-size": 11,
          "text-keep-upright": false,
          "text-rotation-alignment": "map",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          visibility: "visible",
        },
        paint: {
          "text-color": "#c8ffe0",
          "text-halo-color": "#0b1a12",
          "text-halo-width": 1.2,
          "text-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer("contrib-path-end-labels")) {
      map.addLayer({
        id: "contrib-path-end-labels",
        type: "symbol",
        source: "contrib-path",
        filter: ["==", ["get", "kind"], "end-label"],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [
            "case",
            ["==", ["get", "role"], "start"],
            ["literal", [0, -1.35]],
            ["literal", [0, 1.35]],
          ],
          "text-anchor": [
            "case",
            ["==", ["get", "role"], "start"],
            "bottom",
            "top",
          ],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          visibility: "visible",
        },
        paint: {
          "text-color": [
            "case",
            ["==", ["get", "role"], "start"],
            "#b8f2d0",
            "#ffd8a8",
          ],
          "text-halo-color": "#000",
          "text-halo-width": 1.4,
        },
      });
    }
    if (!map.getLayer("contrib-path-wrap")) {
      map.addLayer({
        id: "contrib-path-wrap",
        type: "line",
        source: "contrib-path",
        filter: ["==", ["get", "kind"], "wrap"],
        paint: {
          "line-color": "#cc5de8",
          "line-width": 2.5,
          "line-opacity": 0.7,
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getLayer("contrib-path-blockers")) {
      map.addLayer({
        id: "contrib-path-blockers",
        type: "circle",
        source: "contrib-path",
        filter: ["==", ["get", "kind"], "blocker"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#ff5c5c",
          "circle-opacity": 0.85,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });
    }
    // Official ghosts first (under visual pins)
    if (!map.getLayer("contrib-stops-official")) {
      map.addLayer({
        id: "contrib-stops-official",
        type: "circle",
        source: "contrib-stops",
        filter: ["==", ["get", "kind"], "official"],
        paint: {
          "circle-radius": 6,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#9aa0a8",
          "circle-opacity": 1,
          "circle-stroke-opacity": 0.9,
        },
      });
    }
    // Visual stop pins (editable in stops mode) — solid orange, above official
    if (!map.getLayer("contrib-stops-circle")) {
      map.addLayer({
        id: "contrib-stops-circle",
        type: "circle",
        source: "contrib-stops",
        filter: ["==", ["get", "kind"], "visual"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#f0a030",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#1a1208",
          "circle-opacity": 0.4,
          "circle-stroke-opacity": 1,
          "circle-pitch-alignment": "viewport",
        },
      });
    }
    if (!map.getLayer("contrib-stops-core")) {
      map.addLayer({
        id: "contrib-stops-core",
        type: "circle",
        source: "contrib-stops",
        filter: ["==", ["get", "kind"], "visual"],
        paint: {
          "circle-radius": 2,
          "circle-color": "#1a1208",
          "circle-opacity": 0.75,
        },
      });
    }
    if (!map.getLayer("contrib-stops-label")) {
      map.addLayer({
        id: "contrib-stops-label",
        type: "symbol",
        source: "contrib-stops",
        filter: ["==", ["get", "kind"], "visual"],
        layout: {
          "text-field": ["concat", "#", ["get", "label"], " ", ["get", "name"]],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-max-width": 14,
          "text-optional": true,
          visibility: "none",
        },
        paint: {
          "text-color": "#ffd8a8",
          "text-halo-color": "#000",
          "text-halo-width": 1.4,
        },
      });
    }
    // Follow-roads debug visualization (ghost original + snap links + segment status)
    if (!map.getSource("contrib-follow-debug")) {
      map.addSource("contrib-follow-debug", {
        type: "geojson",
        data: emptyFc(),
      });
    }
    if (!map.getLayer("contrib-follow-orig-line")) {
      map.addLayer({
        id: "contrib-follow-orig-line",
        type: "line",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "orig_line"],
        paint: {
          "line-color": "#9aa0a8",
          "line-width": 3,
          "line-opacity": 0.75,
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getLayer("contrib-follow-seg-ok")) {
      map.addLayer({
        id: "contrib-follow-seg-ok",
        type: "line",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "seg_ok"],
        paint: {
          "line-color": "#4dabf7",
          "line-width": 4,
          "line-opacity": 0.85,
        },
      });
    }
    if (!map.getLayer("contrib-follow-seg-fail")) {
      map.addLayer({
        id: "contrib-follow-seg-fail",
        type: "line",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "seg_fail"],
        paint: {
          "line-color": "#ff922b",
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [1.5, 1.5],
        },
      });
    }
    if (!map.getLayer("contrib-follow-links")) {
      map.addLayer({
        id: "contrib-follow-links",
        type: "line",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "snap_link"],
        paint: {
          "line-color": "#cc5de8",
          "line-width": 1.5,
          "line-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer("contrib-follow-orig-pts")) {
      map.addLayer({
        id: "contrib-follow-orig-pts",
        type: "circle",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "orig_pt"],
        paint: {
          "circle-radius": 3.5,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#adb5bd",
          "circle-opacity": 1,
        },
      });
    }
    if (!map.getLayer("contrib-follow-snapped-pts")) {
      map.addLayer({
        id: "contrib-follow-snapped-pts",
        type: "circle",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "snapped_pt"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#51cf66",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.95,
        },
      });
    }
    if (!map.getLayer("contrib-follow-raw-pts")) {
      map.addLayer({
        id: "contrib-follow-raw-pts",
        type: "circle",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "raw_pt"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ff922b",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#1a1208",
          "circle-opacity": 0.95,
        },
      });
    }
    if (!map.getLayer("contrib-follow-insert-pts")) {
      map.addLayer({
        id: "contrib-follow-insert-pts",
        type: "circle",
        source: "contrib-follow-debug",
        filter: ["==", ["get", "kind"], "insert_pt"],
        paint: {
          "circle-radius": 3.5,
          "circle-color": "#4dabf7",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.95,
        },
      });
    }
    draftSourceReady = true;
  }

  function emptyFc() {
    return { type: "FeatureCollection", features: [] };
  }

  /**
   * Every path vertex gets a green handle in path mode (no subsampling).
   * Endpoints render slightly larger (anchor) via paint expressions.
   */
  function editVertexIndices() {
    return points.map((_, i) => i);
  }

  function paintDraft() {
    ensureDraftLayer();

    const src = map?.getSource("contrib-path");
    if (src && typeof src.setData === "function") {
      /** @type {object[]} */
      const features = [];
      if (points.length >= 2) {
        features.push({
          type: "Feature",
          properties: { kind: "line" },
          geometry: { type: "LineString", coordinates: points },
        });
      }
      if (editMode === "path" && isClosedPath(points)) {
        const a = points[0];
        const b = points[points.length - 1];
        if (a && b) {
          features.push({
            type: "Feature",
            properties: { kind: "wrap" },
            geometry: { type: "LineString", coordinates: [b, a] },
          });
        }
      }
      // Path turning handles in path + select modes (hidden in stops mode)
      if (editMode === "path" || editMode === "select") {
        const idxs = editVertexIndices();
        for (const i of idxs) {
          const c = points[i];
          if (!c) continue;
          features.push({
            type: "Feature",
            properties: {
              kind: "vertex",
              i,
              anchor: i === 0 || i === points.length - 1,
              selected: selectedIdx.has(i) ? 1 : 0,
              focused: focusIdx === i ? 1 : 0,
              offset: offsetIdx.has(i) ? 1 : 0,
            },
            geometry: { type: "Point", coordinates: c },
          });
        }
      }
      if (editMode === "path" && points.length >= 2) {
        features.push({
          type: "Feature",
          properties: { kind: "end-label", role: "start", label: t("START") },
          geometry: { type: "Point", coordinates: points[0] },
        });
        features.push({
          type: "Feature",
          properties: { kind: "end-label", role: "end", label: t("END") },
          geometry: { type: "Point", coordinates: points[points.length - 1] },
        });
      }
      for (const c of blockers) {
        if (!c || c.length < 2) continue;
        features.push({
          type: "Feature",
          properties: { kind: "blocker" },
          geometry: { type: "Point", coordinates: c },
        });
      }
      src.setData({ type: "FeatureCollection", features });
    }

    const stopSrc = map?.getSource("contrib-stops");
    if (stopSrc && typeof stopSrc.setData === "function") {
      /** @type {object[]} */
      const stopFeatures = [];
      for (let i = 0; i < stopMarkers.length; i++) {
        const s = stopMarkers[i];
        if (!s) continue;
        const vLon = Number(s.visualLon ?? s.lon);
        const vLat = Number(s.visualLat ?? s.lat);
        const oLon = Number(s.officialLon ?? s.lon);
        const oLat = Number(s.officialLat ?? s.lat);
        if (!Number.isFinite(vLon) || !Number.isFinite(vLat)) continue;

        // Official ghost first (under), only when visual was moved off official
        const moved =
          Number.isFinite(oLon) &&
          Number.isFinite(oLat) &&
          (Math.abs(oLon - vLon) > 1e-5 || Math.abs(oLat - vLat) > 1e-5);
        if (moved) {
          stopFeatures.push({
            type: "Feature",
            properties: {
              name: String(s.name || ""),
              label: String(i + 1),
              kind: "official",
              i,
            },
            geometry: { type: "Point", coordinates: [oLon, oLat] },
          });
        }

        // Visual pin (always on top of its official ghost)
        stopFeatures.push({
          type: "Feature",
          properties: {
            name: String(s.name || ""),
            label: String(i + 1),
            kind: "visual",
            i,
          },
          geometry: { type: "Point", coordinates: [vLon, vLat] },
        });
      }
      stopSrc.setData({ type: "FeatureCollection", features: stopFeatures });
    }

    if (els.count) {
      if (editMode === "select") {
        els.count.textContent = `${selectedIdx.size} selected · ${offsetIdx.size} offset >${OFFSET_SELECT_M}m · ${points.length} path pts`;
      } else if (editMode === "path") {
        const loop = isClosedPath(points) ? ` · ${t("loop")}` : "";
        const blk = blockers.length ? ` · ${blockers.length} ${t("blockers")}` : "";
        els.count.textContent = `${points.length} path pts${loop}${blk} · ${stopMarkers.length} stops (official fixed)`;
      } else {
        els.count.textContent = stopMarkers.length
          ? `${stopMarkers.length} visual stops · drag orange pins`
          : `0 visual stops · Load path first`;
      }
    }
    updateSelectActionState();
    updatePathActionState();
  }

  function updateSelectActionState() {
    const n = selectedIdx.size;
    if (els.btnDeleteSelected) {
      els.btnDeleteSelected.disabled = n === 0;
      els.btnDeleteSelected.textContent = n ? t("Delete ({n})", { n }) : t("Delete selected");
    }
    if (els.btnClearSelection) els.btnClearSelection.disabled = n === 0;
  }

  function updatePathActionState() {
    if (els.btnClearBlockers) els.btnClearBlockers.disabled = blockers.length === 0;
    if (els.btnSetStart) els.btnSetStart.disabled = focusIdx < 0 || points.length < 2;
    if (els.btnSetLast) els.btnSetLast.disabled = focusIdx < 0 || points.length < 2;
    els.btnAddBlocker?.classList.toggle("is-active", placingBlocker);
    document.body.classList.toggle("contrib-placing-blocker", placingBlocker);
  }

  /**
   * Closed loop: first and last vertices sit on the same kerb.
   * @param {number[][]} pts
   * @param {number} [maxM]
   */
  function isClosedPath(pts, maxM = 40) {
    if (!pts || pts.length < 4) return false;
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (!a || !b) return false;
    const dlat = (a[1] - b[1]) * 111320;
    const dlng = (a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180);
    return Math.hypot(dlat, dlng) < maxM;
  }

  function setPlacingBlocker(on) {
    placingBlocker = !!on;
    updatePathActionState();
    if (placingBlocker) {
      setStatus(t("Placing blockers — click the wrong road at a junction · Esc to stop"));
    }
  }

  function addBlockerAt(lng, lat) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const dup = blockers.some((c) => {
      const dlat = (c[1] - lat) * 111320;
      const dlng = (c[0] - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
      return Math.hypot(dlat, dlng) < 12;
    });
    if (dup) {
      showToast(t("Blocker already there"), 1200);
      return;
    }
    blockers.push([lng, lat]);
    paintDraft();
    setStatus(t("Blocker added — Follow roads will avoid this junction"));
    showToast(t("Blocker added"), 1400);
  }

  function hitBlocker(point, maxPx = 16) {
    if (!map || !blockers.length) return -1;
    let best = -1;
    let bestD = maxPx;
    for (let i = 0; i < blockers.length; i++) {
      const c = blockers[i];
      const p = map.project({ lng: c[0], lat: c[1] });
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function removeBlockerAt(i) {
    if (i < 0 || i >= blockers.length) return;
    blockers.splice(i, 1);
    paintDraft();
    showToast(t("Blocker removed"), 1200);
  }

  function clearBlockers() {
    if (!blockers.length) return;
    blockers = [];
    setPlacingBlocker(false);
    paintDraft();
    setStatus(t("Blockers cleared"));
    showToast(t("Blockers cleared"), 1200);
  }

  /**
   * Rotate the polyline so vertex `i` becomes the start (index 0).
   * Closed loops keep the wrap after rotation.
   */
  function rotatePathStart(i) {
    if (i < 0 || i >= points.length) {
      showToast(t("Need a focused path point — click a green ring first"), 2200);
      return;
    }
    if (i === 0) {
      showToast(t("Path already starts here"), 1400);
      return;
    }
    if (points.length < 2) return;
    pushPathHistory();
    const closed = isClosedPath(points);
    let ring = points.map((c) => [c[0], c[1]]);
    if (closed && ring.length >= 2) ring.pop();
    const idx = Math.min(i, ring.length - 1);
    const rotated = ring.slice(idx).concat(ring.slice(0, idx));
    if (closed && rotated.length) {
      rotated.push([rotated[0][0], rotated[0][1]]);
    }
    points = rotated;
    selectedIdx.clear();
    focusIdx = 0;
    recomputeOffsetFlags();
    paintDraft();
    setStatus(t("Path rotated · this point is now the start"));
    showToast(t("Line start moved here"), 1800);
  }

  /**
   * Trim so vertex `i` is the last point (opens a circular wrap).
   */
  function setPathLast(i) {
    if (i < 0 || i >= points.length) {
      showToast(t("Need a focused path point — click a green ring first"), 2200);
      return;
    }
    if (i === 0) {
      showToast(t("Cannot set the first point as last"), 1800);
      return;
    }
    if (i === points.length - 1) {
      showToast(t("Path already ends here"), 1400);
      return;
    }
    pushPathHistory();
    points = points.slice(0, i + 1).map((c) => [c[0], c[1]]);
    selectedIdx.clear();
    focusIdx = points.length - 1;
    recomputeOffsetFlags();
    paintDraft();
    setStatus(t("Path end set · {n} pts remain", { n: points.length }));
    showToast(t("Line now ends here"), 1800);
  }

  /** Ensure box-select overlay on map container */
  function ensureBoxEl() {
    if (boxEl && boxEl.isConnected) return boxEl;
    const host = map?.getContainer?.();
    if (!host) return null;
    boxEl = document.createElement("div");
    boxEl.className = "contrib-box-select";
    boxEl.hidden = true;
    boxEl.setAttribute("aria-hidden", "true");
    host.appendChild(boxEl);
    return boxEl;
  }

  function updateBoxEl() {
    const el = ensureBoxEl();
    if (!el || !boxStart || !boxEnd) {
      if (el) el.hidden = true;
      return;
    }
    const x1 = Math.min(boxStart.x, boxEnd.x);
    const y1 = Math.min(boxStart.y, boxEnd.y);
    const x2 = Math.max(boxStart.x, boxEnd.x);
    const y2 = Math.max(boxStart.y, boxEnd.y);
    el.hidden = false;
    el.style.left = `${x1}px`;
    el.style.top = `${y1}px`;
    el.style.width = `${Math.max(1, x2 - x1)}px`;
    el.style.height = `${Math.max(1, y2 - y1)}px`;
  }

  function endBoxSelect(_apply) {
    boxSelecting = false;
    boxStart = null;
    boxEnd = null;
    if (boxEl) boxEl.hidden = true;
  }

  /**
   * Select path vertices inside screen-space box.
   * @param {{x:number,y:number}} a
   * @param {{x:number,y:number}} b
   * @param {{ add?: boolean }} [opts]
   */
  function applyBoxSelection(a, b, opts = {}) {
    if (!map || !points.length) return;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    // Tiny click without drag → clear (unless shift)
    if (maxX - minX < 4 && maxY - minY < 4) {
      if (!opts.add) {
        selectedIdx.clear();
        paintDraft();
      }
      return;
    }
    if (!opts.add) selectedIdx.clear();
    for (let i = 0; i < points.length; i++) {
      const c = points[i];
      if (!c) continue;
      // Never select endpoints — deleting them breaks the path
      if (i === 0 || i === points.length - 1) continue;
      const p = map.project({ lng: c[0], lat: c[1] });
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
        selectedIdx.add(i);
      }
    }
    paintDraft();
    setStatus(
      selectedIdx.size
        ? t("{n} points selected · Delete/Backspace to remove · Shift+drag to add", { n: selectedIdx.size })
        : t("No points in box (endpoints are protected)"),
    );
    showToast(
      selectedIdx.size ? t("{n} points selected", { n: selectedIdx.size }) : t("Nothing in box"),
      1200,
    );
  }

  /**
   * Flag vertices that sit far from a simplified route backbone
   * (spikes / road-offset samples after densify).
   */
  function recomputeOffsetFlags() {
    offsetIdx = new Set(findOffsetIndices(OFFSET_SELECT_M));
  }

  /**
   * @param {number} maxM
   * @returns {number[]}
   */
  function findOffsetIndices(maxM) {
    if (points.length < 4) return [];
    // Backbone: simplify path so real road shape remains, spikes fall off
    const backbone = simplifyPathRdp(points, Math.max(12, maxM * 0.55));
    if (backbone.length < 2) return [];
    /** @type {number[]} */
    const out = [];
    for (let i = 1; i < points.length - 1; i++) {
      const d = distPointToPolylineM(points[i], backbone);
      if (d > maxM) out.push(i);
    }
    // Also flag local spikes vs immediate neighbors
    for (let i = 1; i < points.length - 1; i++) {
      const local = distPointToSegmentM(points[i], points[i - 1], points[i + 1]);
      if (local > maxM * 0.85) {
        if (!out.includes(i)) out.push(i);
      }
    }
    return out.sort((a, b) => a - b);
  }

  function selectOffsetPoints() {
    recomputeOffsetFlags();
    selectedIdx = new Set(offsetIdx);
    // Protect endpoints
    selectedIdx.delete(0);
    selectedIdx.delete(points.length - 1);
    paintDraft();
    const n = selectedIdx.size;
    setStatus(
      n
        ? t("Selected {n} offset points (>{m}m from route backbone). Delete to clean, or box-select more.", { n, m: OFFSET_SELECT_M })
        : t("No offset points over {m}m — path is clean enough", { m: OFFSET_SELECT_M }),
    );
    showToast(
      n ? t("{n} offset points selected", { n }) : t("No large offsets found"),
      2000,
    );
  }

  function clearSelection() {
    selectedIdx.clear();
    paintDraft();
    setStatus(t("Selection cleared"));
  }

  function deleteSelectedPoints() {
    if (!selectedIdx.size) {
      showToast(t("No points selected"), 1200);
      return;
    }
    // Keep endpoints
    const kill = [...selectedIdx].filter(
      (i) => i > 0 && i < points.length - 1,
    );
    if (!kill.length) {
      showToast(t("Cannot delete path endpoints"), 1600);
      return;
    }
    if (points.length - kill.length < 2) {
      showToast(t("Need at least 2 path points"), 1600);
      return;
    }
    pushPathHistory();
    const drop = new Set(kill);
    points = points.filter((_, i) => !drop.has(i));
    selectedIdx.clear();
    recomputeOffsetFlags();
    paintDraft();
    setStatus(
      t("Deleted {n} points · {m} remain · Undo available", { n: kill.length, m: points.length }),
    );
    showToast(t("Deleted {n} points", { n: kill.length }), 1600);
  }

  /** Haversine meters */
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(lat2 - lat1);
    const dLon = toR(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** @param {number[]} p @param {number[][]} line */
  function distPointToPolylineM(p, line) {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const d = distPointToSegmentM(p, line[i], line[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  /** @param {number[]} p @param {number[]} a @param {number[]} b */
  function distPointToSegmentM(p, a, b) {
    // Equirectangular local meters
    const lat0 = (((p[1] + a[1] + b[1]) / 3) * Math.PI) / 180;
    const cos = Math.cos(lat0);
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * cos;
    const px = (p[0] - a[0]) * mPerDegLon;
    const py = (p[1] - a[1]) * mPerDegLat;
    const bx = (b[0] - a[0]) * mPerDegLon;
    const by = (b[1] - a[1]) * mPerDegLat;
    const len2 = bx * bx + by * by;
    let t = len2 < 1e-9 ? 0 : (px * bx + py * by) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx;
    const dy = py - t * by;
    return Math.hypot(dx, dy);
  }

  /**
   * Ramer–Douglas–Peucker simplify in meters.
   * @param {number[][]} coords
   * @param {number} epsilonM
   * @returns {number[][]}
   */
  function simplifyPathRdp(coords, epsilonM) {
    if (!coords || coords.length <= 2) return (coords || []).map((c) => [c[0], c[1]]);
    const keep = new Array(coords.length).fill(false);
    keep[0] = true;
    keep[coords.length - 1] = true;
    /** @type {Array<[number, number]>} */
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      let maxD = 0;
      let maxI = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const d = distPointToSegmentM(coords[i], coords[i0], coords[i1]);
        if (d > maxD) {
          maxD = d;
          maxI = i;
        }
      }
      if (maxI >= 0 && maxD > epsilonM) {
        keep[maxI] = true;
        stack.push([i0, maxI], [maxI, i1]);
      }
    }
    return coords.filter((_, i) => keep[i]).map((c) => [c[0], c[1]]);
  }

  /** Re-project visual pins onto current path (keeps official fixed). */
  function reprojectVisualStops() {
    if (points.length < 2 || !stopMarkers.length) return;
    const routeLine = points.map((c) => ({ lon: c[0], lat: c[1] }));
    const projected = projectStops(
      routeLine,
      stopMarkers.map((s, i) => ({
        id: s.stopId || String(i),
        lon: Number(s.officialLon ?? s.lon),
        lat: Number(s.officialLat ?? s.lat),
      })),
    );
    stopMarkers = stopMarkers.map((s, i) => {
      const p = projected[i];
      if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return s;
      return { ...s, visualLon: p.lon, visualLat: p.lat };
    });
    paintDraft();
  }

  function pushPathHistory() {
    if (!points.length) return;
    pathHistory.push(points.map((c) => [c[0], c[1]]));
    if (pathHistory.length > 30) pathHistory.shift();
    // New edit invalidates redo branch
    pathFuture = [];
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    if (els.btnUndo) {
      els.btnUndo.disabled = !pathHistory.length && points.length <= 2;
    }
    if (els.btnRedo) {
      els.btnRedo.disabled = !pathFuture.length;
    }
  }

  function snapshotPath() {
    return points.map((c) => [c[0], c[1]]);
  }

  /**
   * Road-follow assistant: snap *this* path onto nearby road edges only
   * (map-match / nearest) — never free-route onto other corridors.
   */
  function setFollowPendingUi(on) {
    document.body.classList.toggle("contrib-follow-pending", !!on);
    document
      .getElementById("contrib-follow-confirm-row")
      ?.toggleAttribute("hidden", !on);
    if (els.btnFollowRoads) {
      els.btnFollowRoads.disabled = !!on;
    }
  }

  /**
   * Accept pending Follow-roads result.
   */
  function confirmFollowRoads() {
    if (!followPending) {
      showToast(t("Nothing to confirm"), 1200);
      return;
    }
    // Path already applied; just commit (history already has pre-follow snapshot)
    followPending = null;
    setFollowPendingUi(false);
    // Keep debug overlay until user hides it
    setStatus(
      t("Follow roads confirmed · {n} path pts · Undo still available · Hide overlay when done", { n: points.length }),
    );
    showToast(t("Follow roads confirmed"), 1600);
  }

  /**
   * Discard pending Follow-roads result and restore previous path.
   */
  function revertFollowRoads() {
    if (!followPending) {
      showToast(t("Nothing to revert"), 1200);
      return;
    }
    const prev = followPending;
    points = prev.beforePath.map((c) => [c[0], c[1]]);
    stopMarkers = prev.beforeStops.map((s) => ({ ...s }));
    followPending = null;
    // Drop the history entry we pushed for this preview (if still on top)
    if (pathHistory.length) pathHistory.pop();
    clearFollowRoadsDebug();
    setFollowPendingUi(false);
    selectedIdx.clear();
    paintDraft();
    setStatus(
      t("Follow roads reverted · {n} path pts restored", { n: points.length }),
    );
    showToast(t("Follow roads reverted"), 1600);
  }

  async function runFollowRoadsAssist() {
    if (followPending) {
      showToast(t("Confirm or Revert the current Follow roads result first"), 2400);
      return;
    }
    if (points.length < 2) {
      showToast(t("Draw or load a path first (need ≥ 2 points)"), 2200);
      return;
    }
    if (editMode === "select" && !selectedIdx.size) {
      showToast(
        t("Select mode: Follow roads snaps selected points only. Select some, or leave Select mode to snap all."),
        3200,
      );
      setStatus(
        t("Select points first, or press V to snap the whole path"),
      );
      return;
    }
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    const btn = els.btnFollowRoads;
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    }
    clearFollowRoadsDebug();
    setStatus(
      t("Road assistant: snapping vertices onto streets (keeps all your points)…"),
    );
    const beforeN = points.length;
    const beforePath = points.map((c) => [c[0], c[1]]);
    const beforeStops = stopMarkers.map((s) => ({ ...s }));
    pushPathHistory();
    try {
      const result = await followRoadsPath(beforePath, {
        signal: loadAbort.signal,
        skipWrap: true,
        avoidPoints: blockers.map((c) => ({ lon: c[0], lat: c[1] })),
        snapIndices:
          editMode === "select" ? [...selectedIdx] : undefined,
        onProgress: (ev) => {
          if (ev?.msg) setStatus(t("Road assistant: {msg}", { msg: ev.msg }));
        },
      });

      // Always show calculation viz when debug present
      if (result.debug) paintFollowRoadsDebug(result.debug);

      if (result.method === "unchanged" || result.path.length < 2) {
        pathHistory.pop(); // nothing changed
        setStatus(
          t("Road assistant: nothing changed — see map legend (grey=original, amber=kept raw)."),
        );
        showToast(t("Path unchanged — debug overlay shows why"), 2800);
        return;
      }

      // Preview: apply path but require Confirm / Revert
      points = result.path.map((p) => [p.lon, p.lat]);
      if (stopMarkers.length) reprojectVisualStops();
      else paintDraft();
      fitToPath();
      setEditMode("path");
      if (result.debug) paintFollowRoadsDebug(result.debug);

      const snapN = result.snapped ?? 0;
      const insN = result.inserted ?? 0;
      const rawN = result.keptRaw ?? 0;
      const densN = (result.debug?.segments || []).filter(
        (s) => s.status === "densified",
      ).length;
      const failN = (result.debug?.segments || []).filter(
        (s) => s.status === "downgrade",
      ).length;

      followPending = {
        beforePath,
        beforeStops,
        afterPath: points.map((c) => [c[0], c[1]]),
        debug: result.debug || null,
        stats: {
          snapN,
          insN,
          rawN,
          densN,
          failN,
          beforeN,
          afterN: points.length,
        },
      };
      setFollowPendingUi(true);

      setStatus(
        t("Preview: {snap} snapped · {raw} raw · {dens} densified · {fail} kept · {before}→{after} pts — Confirm or Revert", {
          snap: snapN,
          raw: rawN,
          dens: densN,
          fail: failN,
          before: beforeN,
          after: points.length,
        }),
      );
      showToast(
        t("Review the map · Confirm to keep · Revert to undo"),
        3600,
      );
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn("[contribute] follow roads", e);
      pathHistory.pop();
      followPending = null;
      setFollowPendingUi(false);
      setStatus(e?.message || t("Road assistant failed"));
      showToast(e?.message || t("Road assistant failed"), 2800);
    } finally {
      if (btn && !followPending) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      } else if (btn && followPending) {
        btn.removeAttribute("aria-busy");
        // stays disabled until confirm/revert
      }
    }
  }

  /**
   * Import a downloaded contribution JSON so the user can continue editing.
   * @param {File | Blob | string} fileOrText
   */
  async function importContributionJson(fileOrText) {
    try {
      let text;
      if (typeof fileOrText === "string") {
        text = fileOrText;
      } else {
        text = await fileOrText.text();
      }
      const draft = JSON.parse(text);
      if (!draft || typeof draft !== "object") {
        throw new Error(t("Invalid JSON object"));
      }

      const coords = draft.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) {
        throw new Error(t("JSON needs coordinates with at least 2 [lon,lat] points"));
      }

      /** @type {number[][]} */
      const path = [];
      for (const c of coords) {
        if (!Array.isArray(c) || c.length < 2) continue;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        path.push([lon, lat]);
      }
      if (path.length < 2) {
        throw new Error(t("No valid coordinates in JSON"));
      }

      clearPathHistoryStacks();
      selectedIdx.clear();
      offsetIdx.clear();
      focusIdx = -1;
      blockers = [];
      setPlacingBlocker(false);
      points = path;

      // Form fields
      if (els.agency && draft.agency) {
        const ag = String(draft.agency).toUpperCase();
        const opt = [...(els.agency.options || [])].find(
          (o) =>
            ag.includes(String(o.value).toUpperCase()) ||
            String(o.value).toUpperCase().includes(ag),
        );
        if (opt) els.agency.value = opt.value;
        else if ([...els.agency.options].some((o) => o.value === "OTHER")) {
          els.agency.value = "OTHER";
        }
      }
      if (els.route && draft.route_short_name) {
        els.route.value = String(draft.route_short_name);
      }
      if (els.direction && draft.direction != null && draft.direction !== "") {
        const d = String(draft.direction);
        const has = [...(els.direction.options || [])].some((o) => o.value === d);
        if (has) els.direction.value = d;
        else if (/^i/i.test(d)) els.direction.value = "I";
        else if (/^o/i.test(d)) els.direction.value = "O";
      }
      if (els.from) {
        const fm = draft.from_match;
        els.from.value = Array.isArray(fm)
          ? fm.join(", ")
          : String(fm || draft.from || "");
      }
      if (els.to) {
        const tm = draft.to_match;
        els.to.value = Array.isArray(tm)
          ? tm.join(", ")
          : String(tm || draft.to || "");
      }
      if (els.notes && draft.notes != null) els.notes.value = String(draft.notes);
      if (els.name && draft.contributor != null) {
        els.name.value = String(draft.contributor);
      }

      // Visual stops from draft (official stays fixed when provided)
      const vs = draft.visual_stops;
      if (Array.isArray(vs) && vs.length) {
        stopMarkers = vs
          .map((s, i) => {
            const visual = Array.isArray(s?.visual) ? s.visual : null;
            const official = Array.isArray(s?.official) ? s.official : visual;
            if (!visual || visual.length < 2) return null;
            const vLon = Number(visual[0]);
            const vLat = Number(visual[1]);
            if (!Number.isFinite(vLon) || !Number.isFinite(vLat)) return null;
            const oLon = Number(official?.[0] ?? vLon);
            const oLat = Number(official?.[1] ?? vLat);
            return {
              stopId: String(s.stop_id || s.stopId || `import-${i}`),
              name: String(s.name || `Stop ${i + 1}`),
              seq: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i,
              officialLon: Number.isFinite(oLon) ? oLon : vLon,
              officialLat: Number.isFinite(oLat) ? oLat : vLat,
              visualLon: vLon,
              visualLat: vLat,
            };
          })
          .filter(Boolean);
      } else {
        stopMarkers = [];
      }

      paintDraft();
      fitToPath();
      setEditMode("path");
      const id = draft.id ? String(draft.id) : "draft";
      setStatus(
        t("Imported {id} · {n} path pts · {m} visual stops · continue editing", { id, n: points.length, m: stopMarkers.length }),
      );
      showToast(t("Imported JSON · {n} points", { n: points.length }), 2400);
    } catch (e) {
      console.warn("[contribute] import", e);
      showToast(e?.message || t("Could not import JSON"), 3200);
      setStatus(e?.message || t("Import failed"));
    }
  }

  function clearDraftLayer() {
    const src = map?.getSource("contrib-path");
    if (src?.setData) src.setData(emptyFc());
    const stopSrc = map?.getSource("contrib-stops");
    if (stopSrc?.setData) stopSrc.setData(emptyFc());
    clearFollowRoadsDebug();
  }

  /**
   * Paint Follow-roads calculation debug overlay on the map.
   * @param {import("./routeSnapper.js").FollowRoadsDebug | object | null | undefined} debug
   */
  function paintFollowRoadsDebug(debug) {
    ensureDraftLayer();
    const src = map?.getSource("contrib-follow-debug");
    if (!src?.setData) return;
    if (!debug) {
      src.setData(emptyFc());
      document.getElementById("contrib-follow-legend")?.setAttribute("hidden", "");
      return;
    }

    /** @type {object[]} */
    const features = [];

    // Ghost original path
    if (debug.original?.length >= 2) {
      features.push({
        type: "Feature",
        properties: { kind: "orig_line" },
        geometry: {
          type: "LineString",
          coordinates: debug.original.map((p) => [p.lon, p.lat]),
        },
      });
    }

    // Per-vertex: original · snap link · result (snapped green / raw amber)
    for (const v of debug.vertices || []) {
      const o = v.original;
      const r = v.result;
      if (!o || !r) continue;
      features.push({
        type: "Feature",
        properties: { kind: "orig_pt" },
        geometry: { type: "Point", coordinates: [o.lon, o.lat] },
      });
      if (v.snapped) {
        features.push({
          type: "Feature",
          properties: { kind: "snap_link", drift: v.driftM || 0 },
          geometry: {
            type: "LineString",
            coordinates: [
              [o.lon, o.lat],
              [r.lon, r.lat],
            ],
          },
        });
        features.push({
          type: "Feature",
          properties: { kind: "snapped_pt", drift: v.driftM || 0 },
          geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        });
      } else {
        features.push({
          type: "Feature",
          properties: { kind: "raw_pt", reason: v.reason || "" },
          geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        });
      }
    }

    // Segments densified (blue) vs downgraded (orange dashed)
    for (const s of debug.segments || []) {
      if (!s?.a || !s?.b) continue;
      if (s.status === "skip_short") continue;
      const kind = s.status === "densified" ? "seg_ok" : "seg_fail";
      /** @type {number[][]} */
      const coords = [[s.a.lon, s.a.lat]];
      for (const m of s.mids || []) coords.push([m.lon, m.lat]);
      coords.push([s.b.lon, s.b.lat]);
      features.push({
        type: "Feature",
        properties: {
          kind,
          method: s.method || "",
          i: s.i,
        },
        geometry: { type: "LineString", coordinates: coords },
      });
    }

    // Inserted road mid-points
    for (const p of debug.inserted || []) {
      features.push({
        type: "Feature",
        properties: { kind: "insert_pt" },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      });
    }

    src.setData({ type: "FeatureCollection", features });
    const legend = document.getElementById("contrib-follow-legend");
    legend?.removeAttribute("hidden");
    // Confirm row only when a preview is pending
    document
      .getElementById("contrib-follow-confirm-row")
      ?.toggleAttribute("hidden", !followPending);
  }

  function clearFollowRoadsDebug() {
    const src = map?.getSource("contrib-follow-debug");
    if (src?.setData) src.setData(emptyFc());
    document.getElementById("contrib-follow-legend")?.setAttribute("hidden", "");
  }

  function fitToPath() {
    if (!map || points.length < 1) return;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const [lng, lat] of points) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    try {
      // Centre path in the map visible beside the left panel (not absolute canvas centre)
      const mapEl = map.getContainer?.();
      const mapLeft = mapEl?.getBoundingClientRect?.().left || 0;
      const tb = document.getElementById("main-toolbar");
      const tr = tb?.getBoundingClientRect?.();
      const leftPad =
        tr && tr.width > 40
          ? Math.max(48, Math.ceil(tr.right - mapLeft) + 16)
          : 380;
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        {
          padding: { top: 48, bottom: 48, left: leftPad, right: 48 },
          maxZoom: 15,
          duration: 600,
        },
      );
    } catch {
      /* ignore */
    }
  }

  /** Nearest vertex index within px threshold, or -1 */
  function hitVertex(point, maxPx = 14) {
    if (!map || !points.length) return -1;
    let best = -1;
    let bestD = maxPx;
    const idxs = editVertexIndices();
    for (const i of idxs) {
      const c = points[i];
      const p = map.project({ lng: c[0], lat: c[1] });
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Nearest visual stop index within px threshold, or -1 */
  function hitVisualStop(point, maxPx = 16) {
    if (!map || !stopMarkers.length) return -1;
    let best = -1;
    let bestD = maxPx;
    for (let i = 0; i < stopMarkers.length; i++) {
      const s = stopMarkers[i];
      const lon = Number(s.visualLon ?? s.lon);
      const lat = Number(s.visualLat ?? s.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const p = map.project({ lng: lon, lat });
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Insert index along polyline closest to lngLat */
  function nearestInsertIndex(lngLat) {
    if (points.length < 2) return points.length;
    let bestI = 1;
    let bestD = Infinity;
    const p = { x: lngLat.lng, y: lngLat.lat };
    // approximate with projected coords
    for (let i = 0; i < points.length - 1; i++) {
      const a = map.project({ lng: points[i][0], lat: points[i][1] });
      const b = map.project({ lng: points[i + 1][0], lat: points[i + 1][1] });
      const click = map.project(lngLat);
      const d = distToSegment(click, a, b);
      if (d < bestD) {
        bestD = d;
        bestI = i + 1;
      }
    }
    return bestI;
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function onMouseDown(e) {
    if (!active) return;
    if (editMode === "path" && (placingBlocker || e.originalEvent?.shiftKey)) {
      return;
    }
    if (editMode === "select") {
      boxSelecting = true;
      boxStart = { x: e.point.x, y: e.point.y };
      boxEnd = { x: e.point.x, y: e.point.y };
      map.dragPan.disable();
      e.preventDefault();
      updateBoxEl();
      return;
    }
    if (editMode === "path") {
      const i = hitVertex(e.point, 16);
      if (i >= 0) {
        dragIdx = i;
        dragMoved = false;
        map.dragPan.disable();
        e.preventDefault();
      }
      return;
    }
    if (editMode === "stops") {
      const i = hitVisualStop(e.point, 18);
      if (i >= 0) {
        dragStopIdx = i;
        map.dragPan.disable();
        e.preventDefault();
      }
    }
  }

  function onMouseMove(e) {
    if (!active) return;
    if (editMode === "select" && boxSelecting && boxStart) {
      boxEnd = { x: e.point.x, y: e.point.y };
      updateBoxEl();
      map.getCanvas().style.cursor = "crosshair";
      return;
    }
    if (editMode === "path" && dragIdx >= 0 && points[dragIdx]) {
      const prev = points[dragIdx];
      const dlat = (prev[1] - e.lngLat.lat) * 111320;
      const dlng = (prev[0] - e.lngLat.lng) * 111320 * Math.cos((e.lngLat.lat * Math.PI) / 180);
      if (Math.hypot(dlat, dlng) > 1.5) dragMoved = true;
      points[dragIdx] = [e.lngLat.lng, e.lngLat.lat];
      paintDraft();
      return;
    }
    if (editMode === "stops" && dragStopIdx >= 0 && stopMarkers[dragStopIdx]) {
      const s = stopMarkers[dragStopIdx];
      stopMarkers[dragStopIdx] = {
        ...s,
        visualLon: e.lngLat.lng,
        visualLat: e.lngLat.lat,
      };
      paintDraft();
      return;
    }
    if (editMode === "path") {
      if (placingBlocker) {
        map.getCanvas().style.cursor = "crosshair";
      } else {
        const i = hitVertex(e.point, 14);
        const b = hitBlocker(e.point, 14);
        map.getCanvas().style.cursor =
          i >= 0 ? "grab" : b >= 0 ? "pointer" : "crosshair";
      }
    } else if (editMode === "stops") {
      const i = hitVisualStop(e.point, 16);
      map.getCanvas().style.cursor = i >= 0 ? "grab" : "default";
    } else if (editMode === "select") {
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "default";
    }
  }

  function onMouseUp(e) {
    if (editMode === "select" && boxSelecting) {
      const add = !!(e?.originalEvent?.shiftKey);
      if (boxStart && boxEnd) {
        applyBoxSelection(boxStart, boxEnd, { add });
      }
      boxSelecting = false;
      boxStart = null;
      boxEnd = null;
      if (boxEl) boxEl.hidden = true;
      // keep pan disabled while in select mode
      return;
    }
    if (dragIdx >= 0) {
      if (!dragMoved) {
        focusIdx = dragIdx;
        paintDraft();
        setStatus(
          t("Focused point {n} · 1 = start here · 2 = last here", { n: focusIdx + 1 }),
        );
      }
      dragIdx = -1;
      dragMoved = false;
      map.dragPan.enable();
    }
    if (dragStopIdx >= 0) {
      // Soft-snap visual stop onto path if nearby
      const s = stopMarkers[dragStopIdx];
      if (s && points.length >= 2) {
        const routeLine = points.map((c) => ({ lon: c[0], lat: c[1] }));
        const projected = projectStops(routeLine, [
          {
            id: s.stopId || String(dragStopIdx),
            lon: s.visualLon,
            lat: s.visualLat,
          },
        ]);
        const p = projected[0];
        if (p && Number.isFinite(p.lon) && Number.isFinite(p.lat) && (p.error ?? 0) < 80) {
          stopMarkers[dragStopIdx] = {
            ...s,
            visualLon: p.lon,
            visualLat: p.lat,
          };
          paintDraft();
        }
      }
      dragStopIdx = -1;
      map.dragPan.enable();
    }
  }

  function onMapClick(e) {
    if (!active || dragIdx >= 0 || dragStopIdx >= 0 || boxSelecting) return;
    // Select / stops: no path insert
    if (editMode !== "path") return;

    const blkHit = hitBlocker(e.point, 16);
    if (placingBlocker || e.originalEvent?.shiftKey) {
      if (blkHit >= 0 && !placingBlocker) {
        removeBlockerAt(blkHit);
        return;
      }
      addBlockerAt(e.lngLat.lng, e.lngLat.lat);
      return;
    }
    if (blkHit >= 0) {
      removeBlockerAt(blkHit);
      return;
    }
    // Alt/Option+click near vertex → delete turning point
    if (e.originalEvent?.altKey) {
      const i = hitVertex(e.point, 16);
      if (i > 0 && i < points.length - 1) {
        pushPathHistory();
        points.splice(i, 1);
        if (focusIdx === i) focusIdx = -1;
        else if (focusIdx > i) focusIdx -= 1;
        paintDraft();
      }
      return;
    }
    // Clicking a vertex focuses it (handled on mouseup) — don't insert
    if (hitVertex(e.point, 16) >= 0) return;
    // Insert turning point on path (or append if empty)
    if (points.length < 2) {
      points.push([e.lngLat.lng, e.lngLat.lat]);
    } else {
      const idx = nearestInsertIndex(e.lngLat);
      points.splice(idx, 0, [e.lngLat.lng, e.lngLat.lat]);
    }
    paintDraft();
  }

  function onKeyDown(e) {
    if (!active) return;
    // Ignore when typing in inputs
    const tgt = e.target;
    if (
      tgt &&
      (tgt.tagName === "INPUT" ||
        tgt.tagName === "TEXTAREA" ||
        tgt.tagName === "SELECT" ||
        tgt.isContentEditable)
    ) {
      return;
    }
    const k = e.key?.toLowerCase?.() || "";
    if (k === "v" || k === "p") {
      e.preventDefault();
      setEditMode("path");
      showToast(t("Path turns mode (V)"), 1200);
    } else if (k === "s") {
      e.preventDefault();
      setEditMode("stops");
      showToast(t("Visual stops mode (S)"), 1200);
    } else if (k === "b" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setEditMode("select");
      showToast(t("Select mode (B) — box-select · O for offsets"), 1600);
    } else if (k === "o" && !e.ctrlKey && !e.metaKey && editMode === "select") {
      e.preventDefault();
      selectOffsetPoints();
    } else if (k === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (followPending) {
        showToast(t("Confirm (Enter) or Revert (Esc) Follow roads first"), 2200);
      } else {
        void runFollowRoadsAssist();
      }
    } else if (k === "x" && !e.ctrlKey && !e.metaKey && editMode === "path") {
      e.preventDefault();
      setPlacingBlocker(!placingBlocker);
      showToast(
        placingBlocker
          ? t("Click the map to drop a blocker")
          : t("Blocker placement off"),
        1400,
      );
    } else if (k === "1" && !e.ctrlKey && !e.metaKey && editMode === "path") {
      e.preventDefault();
      rotatePathStart(focusIdx);
    } else if (k === "2" && !e.ctrlKey && !e.metaKey && editMode === "path") {
      e.preventDefault();
      setPathLast(focusIdx);
    } else if (k === "enter" && followPending && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      confirmFollowRoads();
    } else if (k === "escape") {
      e.preventDefault();
      if (placingBlocker) {
        setPlacingBlocker(false);
        showToast(t("Blocker placement off"), 1200);
      } else if (followPending) {
        revertFollowRoads();
      } else if (selectedIdx.size) {
        clearSelection();
      } else if (editMode === "select") {
        setEditMode("path");
      }
    } else if (
      (k === "delete" || k === "backspace") &&
      editMode === "select" &&
      selectedIdx.size
    ) {
      e.preventDefault();
      deleteSelectedPoints();
    } else if (
      (k === "z" || k === "Z") &&
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey
    ) {
      e.preventDefault();
      redoPathEdit();
    } else if ((k === "y" || k === "Y") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      redoPathEdit();
    } else if ((k === "z" || k === "Z") && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      undoPathEdit();
    } else if (k === "tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const order = ["path", "stops", "select"];
      const i = order.indexOf(editMode);
      const next = order[(i + 1) % order.length];
      setEditMode(next);
      showToast(
        next === "path"
          ? t("Path turns mode (V)")
          : next === "stops"
            ? t("Visual stops mode (S)")
            : t("Select mode (B)"),
        1200,
      );
    }
  }

  function undoPathEdit() {
    if (followPending) {
      showToast(t("Confirm or Revert Follow roads first"), 2000);
      return;
    }
    if (pathHistory.length) {
      pathFuture.push(snapshotPath());
      if (pathFuture.length > 30) pathFuture.shift();
      points = pathHistory.pop() || [];
      selectedIdx.clear();
      recomputeOffsetFlags();
      paintDraft();
      updateUndoRedoButtons();
      setStatus(
        t("Undo · {n} path pts · {u} undo · {r} redo", { n: points.length, u: pathHistory.length, r: pathFuture.length }),
      );
      showToast(t("Path undone"), 1000);
      return;
    }
    if (points.length <= 2) {
      showToast(t("Nothing to undo"), 1400);
      updateUndoRedoButtons();
      return;
    }
    pathFuture.push(snapshotPath());
    if (pathFuture.length > 30) pathFuture.shift();
    points.pop();
    selectedIdx.clear();
    paintDraft();
    updateUndoRedoButtons();
    showToast(t("Last point removed"), 1000);
  }

  function redoPathEdit() {
    if (followPending) {
      showToast(t("Confirm or Revert Follow roads first"), 2000);
      return;
    }
    if (!pathFuture.length) {
      showToast(t("Nothing to redo"), 1200);
      return;
    }
    pathHistory.push(snapshotPath());
    if (pathHistory.length > 30) pathHistory.shift();
    points = pathFuture.pop() || [];
    selectedIdx.clear();
    recomputeOffsetFlags();
    paintDraft();
    updateUndoRedoButtons();
    setStatus(
      t("Redo · {n} path pts · {u} undo · {r} redo", { n: points.length, u: pathHistory.length, r: pathFuture.length }),
    );
    showToast(t("Path redone"), 1000);
  }

  function clearPathHistoryStacks() {
    pathHistory = [];
    pathFuture = [];
    updateUndoRedoButtons();
  }

  function readFields() {
    const fromRaw = String(els.from?.value || "").trim();
    const toRaw = String(els.to?.value || "").trim();
    return {
      agency: String(els.agency?.value || "").trim(),
      route_short_name: String(els.route?.value || "").trim(),
      from_match: fromRaw
        ? fromRaw.split(/[,;|/]+/).map((s) => s.trim()).filter(Boolean)
        : [],
      to_match: toRaw
        ? toRaw.split(/[,;|/]+/).map((s) => s.trim()).filter(Boolean)
        : [],
      direction: String(els.direction?.value || "").trim(),
      notes: String(els.notes?.value || "").trim(),
      contributor: String(els.name?.value || "").trim(),
      coordinates: points,
      visual_stops: stopMarkers.map((s, i) => ({
        stop_id: String(s.stopId || ""),
        name: String(s.name || ""),
        seq: Number.isFinite(s.seq) ? s.seq : i,
        official: [Number(s.officialLon), Number(s.officialLat)],
        visual: [Number(s.visualLon), Number(s.visualLat)],
      })),
    };
  }

  function validate(fields) {
    if (!fields.route_short_name) return t("Enter a route number (e.g. 38, S1, E11).");
    if (!fields.agency) {
      return t("Select an operator / mode (KMB, GMB, MTR, AEL, LRT, …).");
    }
    if (fields.coordinates.length < 2) {
      return t("Load a calculated path or draw at least 2 points.");
    }
    if (!fields.from_match.length || !fields.to_match.length) {
      return t("Board/alight name fragments required (auto-filled after Load path).");
    }
    return null;
  }

  function buildDraft() {
    const fields = readFields();
    const err = validate(fields);
    if (err) {
      showToast(err, 2800);
      return null;
    }
    return buildPathContributionDraft(fields);
  }

  function downloadDraft(draft) {
    const blob = new Blob([JSON.stringify(draft, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `morgan-path-${draft.id || "draft"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function showSubmitOverlayLoading() {
    const ov = els.submitOverlay;
    if (!ov) {
      console.warn("[contribute] submit overlay missing from DOM");
      return;
    }
    ov.hidden = false;
    ov.removeAttribute("hidden");
    ov.classList.remove("is-success", "is-failed");
    ov.setAttribute("aria-busy", "true");
    document.body.classList.add("contrib-submitting");
    if (els.submitLoading) {
      els.submitLoading.hidden = false;
      els.submitLoading.removeAttribute("hidden");
    }
    if (els.submitResult) {
      els.submitResult.hidden = true;
      els.submitResult.setAttribute("hidden", "");
    }
    if (els.submitVisitPr) {
      els.submitVisitPr.hidden = true;
      els.submitVisitPr.setAttribute("hidden", "");
      els.submitVisitPr.removeAttribute("href");
    }
    // Force a paint so "Submitting…" is visible before the network call
    void ov.offsetHeight;
  }

  /** Wait for browser paint (2 rAFs) so loading UI shows before await fetch. */
  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  /**
   * @param {{
   *   ok: boolean,
   *   title: string,
   *   message: string,
   *   meta?: string,
   *   prUrl?: string | null,
   *   draft?: object | null,
   * }} opts
   */
  function showSubmitOverlayResult(opts) {
    const ov = els.submitOverlay;
    if (!ov) return;
    ov.hidden = false;
    ov.removeAttribute("hidden");
    ov.setAttribute("aria-busy", "false");
    document.body.classList.add("contrib-submitting");
    ov.classList.toggle("is-success", !!opts.ok);
    ov.classList.toggle("is-failed", !opts.ok);
    if (els.submitLoading) {
      els.submitLoading.hidden = true;
      els.submitLoading.setAttribute("hidden", "");
    }
    if (els.submitResult) {
      els.submitResult.hidden = false;
      els.submitResult.removeAttribute("hidden");
    }
    if (els.submitTitle) {
      els.submitTitle.textContent =
        opts.title || (opts.ok ? t("Submit successful") : t("Submit failed"));
    }
    if (els.submitMsg) els.submitMsg.textContent = opts.message || "";
    if (els.submitMeta) els.submitMeta.textContent = opts.meta || "";
    // Icons: CSS shows one based on .is-success / .is-failed (see style.css)
    if (els.submitIconOk) {
      els.submitIconOk.hidden = !opts.ok;
      if (opts.ok) els.submitIconOk.removeAttribute("hidden");
      else els.submitIconOk.setAttribute("hidden", "");
    }
    if (els.submitIconFail) {
      els.submitIconFail.hidden = !!opts.ok;
      if (!opts.ok) els.submitIconFail.removeAttribute("hidden");
      else els.submitIconFail.setAttribute("hidden", "");
    }
    if (els.submitVisitPr) {
      if (opts.prUrl) {
        els.submitVisitPr.hidden = false;
        els.submitVisitPr.removeAttribute("hidden");
        els.submitVisitPr.href = opts.prUrl;
        const labelEl = document.getElementById("contrib-submit-visit-pr-label");
        if (labelEl) labelEl.textContent = opts.prLabel || "Visit your PR";
      } else {
        els.submitVisitPr.hidden = true;
        els.submitVisitPr.setAttribute("hidden", "");
        els.submitVisitPr.removeAttribute("href");
      }
    }
    lastSubmitDraft = opts.draft || null;
    requestAnimationFrame(() => {
      if (opts.prUrl && els.submitVisitPr) els.submitVisitPr.focus();
      else els.submitDone?.focus();
    });
  }

  function hideSubmitOverlay() {
    const ov = els.submitOverlay;
    if (!ov) return;
    ov.hidden = true;
    ov.setAttribute("hidden", "");
    ov.setAttribute("aria-busy", "false");
    ov.classList.remove("is-success", "is-failed");
    document.body.classList.remove("contrib-submitting");
    if (els.submitLoading) {
      els.submitLoading.hidden = false;
      els.submitLoading.removeAttribute("hidden");
    }
    if (els.submitResult) {
      els.submitResult.hidden = true;
      els.submitResult.setAttribute("hidden", "");
    }
  }

  function parseDirValue(raw) {
    const s = String(raw || "");
    const [bound, serviceType] = s.split("|");
    return { bound: bound || "O", serviceType: serviceType || "" };
  }

  function dirOptionLabel(d) {
    const orig = d.orig || d.origZh || "";
    const dest = d.destZh || d.dest || "";
    const destClean = String(dest).replace(/\s*\((circular|循環|循环)\)\s*/gi, "").trim();
    const circular =
      d.circular ||
      d.variant === "loop" ||
      /↺|circular|循環|循环/i.test(`${dest} ${orig}`);
    if (circular && orig && destClean) return `${orig} ↺ ${destClean}`;
    if (orig && destClean) return `${orig} → ${destClean}`;
    return destClean || orig || d.bound || t("Direction");
  }

  async function applyRouteHit(hit) {
    if (!hit) return;
    const co = String(hit.co || hit.kind || "").toUpperCase();
    const kind = String(hit.kind || "").toLowerCase();
    let ag = "KMB";
    if (kind === "mtr") ag = hit.id === "AEL" ? "AEL" : "MTR";
    else if (kind === "lrt") ag = "LRT";
    else if (kind === "mtr_bus") ag = "MTRBUS";
    else if (co === "CTB") ag = "CTB";
    else if (co === "NLB") ag = "NLB";
    else if (co === "GMB") ag = "GMB";
    else if (co === "KMB" || co === "LWB") ag = "KMB";
    if (els.agency) {
      const opt = [...(els.agency.options || [])].find(
        (o) => String(o.value).toUpperCase() === ag,
      );
      if (opt) els.agency.value = opt.value;
    }
    if (els.route) els.route.value = String(hit.id || "");
    if (els.routeSearch) {
      els.routeSearch.value = `${hit.id || ""} ${hit.label || ""}`.trim();
    }
    hideSuggest();
    await fillDirectionsForRoute(hit);
  }

  async function fillDirectionsForRoute(hit) {
    if (!els.direction) return;
    els.direction.innerHTML = `<option value="">${t("Loading directions…")}</option>`;
    els.direction.disabled = true;
    let dirs = [];
    try {
      dirs = (await routeDirections(hit)) || [];
    } catch (e) {
      console.warn("[contribute] directions", e);
    }
    if (!dirs.length) {
      els.direction.innerHTML = `<option value="O">${t("Outbound / O / UP / seq 1")}</option>
        <option value="I">${t("Inbound / I / DOWN / seq 2")}</option>`;
      els.direction.disabled = false;
      if (els.dirCount) els.dirCount.textContent = "";
      return;
    }
    els.direction.innerHTML = dirs
      .map((d, i) => {
        const bound = String(d.bound || "O").toUpperCase() || "O";
        const st = d.serviceType || d.service_type || "";
        const val = st ? `${bound}|${st}` : bound;
        return `<option value="${val}" ${i === 0 ? "selected" : ""}>${dirOptionLabel(d)}</option>`;
      })
      .join("");
    els.direction.disabled = false;
    if (els.dirCount) {
      els.dirCount.textContent = t("{n} directions on this route", { n: dirs.length });
    }
  }

  function hideSuggest() {
    if (!els.routeSuggest) return;
    els.routeSuggest.hidden = true;
    els.routeSuggest.innerHTML = "";
  }

  let searchTimer = 0;
  async function onRouteSearchInput() {
    const q = String(els.routeSearch?.value || "").trim();
    if (els.route && !q) els.route.value = "";
    if (q.length < 1) {
      hideSuggest();
      return;
    }
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      let hits = [];
      try {
        hits = (await searchRoutes(q)) || [];
      } catch (e) {
        console.warn("[contribute] search", e);
      }
      if (!els.routeSuggest) return;
      if (!hits.length) {
        els.routeSuggest.innerHTML = `<li class="loc-suggest-empty">${t("No routes match “{q}”", { q })}</li>`;
        els.routeSuggest.hidden = false;
        return;
      }
      els.routeSuggest.innerHTML = hits
        .slice(0, 12)
        .map((h, i) => {
          const label = `${h.id || ""} · ${h.label || h.co || ""}`.trim();
          return `<li><button type="button" class="loc-suggest-item" data-hit="${i}" role="option">${label}</button></li>`;
        })
        .join("");
      els.routeSuggest.hidden = false;
      els.routeSuggest.querySelectorAll("button[data-hit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = Number(btn.getAttribute("data-hit"));
          void applyRouteHit(hits[i]);
        });
      });
    }, 160);
  }

  async function loadPathFromSearch() {
    const agency = String(els.agency?.value || "").trim();
    const route = String(els.route?.value || "").trim();
    const parsed = parseDirValue(els.direction?.value);
    const direction = parsed.bound;
    if (!agency || !route) {
      showToast(t("Search and pick a route first"), 2200);
      return;
    }
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    setStatus(t("Loading stops + checking published overrides…"));
    if (els.btnLoad) els.btnLoad.disabled = true;
    try {
      const result = await loadCalculatedRoutePath(agency, route, direction, {
        signal: loadAbort.signal,
        serviceType: parsed.serviceType || undefined,
      });
      clearPathHistoryStacks();
      selectedIdx.clear();
      offsetIdx.clear();
      focusIdx = -1;
      blockers = [];
      setPlacingBlocker(false);
      points = result.path;
      stopMarkers = result.stops;
      if (els.from) {
        els.from.value = result.overrideFromMatch?.length
          ? result.overrideFromMatch.join(", ")
          : result.fromName || "";
      }
      if (els.to) {
        els.to.value = result.overrideToMatch?.length
          ? result.overrideToMatch.join(", ")
          : result.toName || "";
      }
      paintDraft();
      fitToPath();
      setEditMode("path");
      if (result.pathSource === "override") {
        const idLabel = result.overrideId ? ` (${result.overrideId})` : "";
        setStatus(
          t("Published override loaded{id} · {n} path pts · {stops} stops. Edit & re-submit to improve, or Follow roads (R).", { id: idLabel, n: points.length, stops: result.stops.length }),
        );
        showToast(
          t("Override path loaded{id} · {n} pts", { id: idLabel, n: points.length }),
          2800,
        );
      } else if (result.pathSource === "similar") {
        const fromR = result.similarFromRoute
          ? t("route {r}", { r: result.similarFromRoute })
          : result.overrideId || t("another route");
        setStatus(
          t("No override for this route — using similar published path from {from} (shared corridor) · {n} pts. Edit & submit your own.", { from: fromR, n: points.length }),
        );
        showToast(
          t("Similar override ({from}) · {n} pts", { from: fromR, n: points.length }),
          3000,
        );
      } else {
        setStatus(
          t("Live OSRM path · {stops} stops · {n} pts (no matching published path). Press R to follow roads.", { stops: result.stops.length, n: points.length }),
        );
        showToast(
          t("Path loaded · {stops} stops · {n} pts (live densify)", { stops: result.stops.length, n: points.length }),
          2400,
        );
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn("[contribute] load path", e);
      setStatus(e?.message || t("Load failed"));
      showToast(e?.message || t("Could not load route path"), 3200);
    } finally {
      if (els.btnLoad) els.btnLoad.disabled = false;
    }
  }

  function fillFromPlan() {
    const r =
      typeof getSelectedPlanRoute === "function" ? getSelectedPlanRoute() : null;
    if (!r) {
      showToast(t("No plan selected — search a route instead"), 2000);
      return;
    }
    if (els.agency && r.agency) {
      const ag = String(r.agency).toUpperCase();
      const opt = [...(els.agency.options || [])].find((o) =>
        ag.includes(String(o.value).toUpperCase()),
      );
      if (opt) els.agency.value = opt.value;
    }
    if (els.route && r.route_short_name) els.route.value = r.route_short_name;
    if (els.routeSearch && r.route_short_name) {
      els.routeSearch.value = String(r.route_short_name);
    }
    if (els.from && r.from) els.from.value = r.from;
    if (els.to && r.to) els.to.value = r.to;

    // Prefer densified plan polyline when available
    const poly =
      typeof getSelectedPlanPolyline === "function"
        ? getSelectedPlanPolyline()
        : null;
    if (poly?.length >= 2) {
      clearPathHistoryStacks();
      points = poly.map((c) => [c[0], c[1]]);
      stopMarkers = [];
      paintDraft();
      fitToPath();
      setStatus(
        t("Loaded calculated path from plan ({n} pts). Follow roads (R) to hug streets, then edit.", { n: points.length }),
      );
      showToast(t("Loaded path from current plan"), 1800);
      return;
    }
    // Otherwise load from open-data + OSRM
    void loadPathFromSearch();
  }

  function open() {
    if (!els.sheet) return;
    if (!isDesktopContribute()) {
      showToast(
        "Path contributions are desktop-only (wide screen + mouse/trackpad).",
        3200,
      );
      return;
    }
    // Unload trip/ETA painted route so only contribute draft layers show
    try {
      clearRoutePath();
    } catch {
      /* ignore */
    }
    els.sheet.hidden = false;
    active = true;
    ensureDraftLayer();
    document.body.classList.add("contrib-mode");
    document.getElementById("app")?.setAttribute("data-contrib", "open");
    map.getCanvas().style.cursor = "crosshair";
    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);
    map.on("click", onMapClick);
    if (!keyHandler) {
      keyHandler = onKeyDown;
      window.addEventListener("keydown", keyHandler);
    }
    setEditMode("path");
    // Toolbar gone — reflow map
    requestAnimationFrame(() => {
      try {
        map.resize();
      } catch {
        /* ignore */
      }
    });
    if (els.route && !els.route.value) fillFromPlan();
    updateUndoRedoButtons();
    void refreshGithubAuth();
    showToast(
      "V path · S stops · B select · R roads · X blocker · 1 start · 2 last.",
      3400,
    );
  }

  function close() {
    if (!els.sheet) return;
    hideSubmitOverlay();
    els.sheet.hidden = true;
    active = false;
    dragIdx = -1;
    dragStopIdx = -1;
    clearPathHistoryStacks();
    document.body.classList.remove(
      "contrib-mode",
      "contrib-edit-path",
      "contrib-edit-stops",
      "contrib-edit-select",
      "contrib-submitting",
      "contrib-placing-blocker",
      "contrib-follow-pending",
    );
    document.getElementById("app")?.removeAttribute("data-contrib");
    endBoxSelect(false);
    selectedIdx.clear();
    offsetIdx.clear();
    focusIdx = -1;
    blockers = [];
    placingBlocker = false;
    if (followPending) {
      // Closing while previewing: discard follow result
      points = followPending.beforePath.map((c) => [c[0], c[1]]);
      stopMarkers = followPending.beforeStops.map((s) => ({ ...s }));
      if (pathHistory.length) pathHistory.pop();
      followPending = null;
      setFollowPendingUi(false);
    }
    if (boxEl) {
      boxEl.remove();
      boxEl = null;
    }
    if (keyHandler) {
      window.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    if (map) {
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      map.off("click", onMapClick);
      requestAnimationFrame(() => {
        try {
          map.resize();
        } catch {
          /* ignore */
        }
      });
    }
    if (loadAbort) loadAbort.abort();
    clearDraftLayer();
  }

  function syncDesktopGate() {
    const desktop = isDesktopContribute();
    document.body.classList.toggle("contrib-desktop-ok", desktop);
    if (els.btnOpen) {
      els.btnOpen.hidden = !desktop;
      els.btnOpen.disabled = !desktop;
    }
    const section = document.getElementById("contrib-about-section");
    if (section) section.hidden = !desktop;
    // Auto-close if viewport shrinks while open
    if (active && !desktop) {
      close();
      showToast(t("Contribute closed — desktop only"), 2200);
    }
  }

  // Wire controls
  els.btnOpen?.addEventListener("click", () => {
    if (!isDesktopContribute()) {
      showToast(
        "Path contributions are desktop-only (wide screen + mouse/trackpad).",
        3200,
      );
      return;
    }
    const info = document.getElementById("info-sheet");
    if (info) info.hidden = true;
    open();
  });

  els.btnModePath?.addEventListener("click", () => {
    setEditMode("path");
    showToast(t("Path turns mode (V)"), 1000);
  });
  els.btnModeStops?.addEventListener("click", () => {
    setEditMode("stops");
    showToast(t("Visual stops mode (S) — drag orange pins"), 1400);
  });
  els.btnModeSelect?.addEventListener("click", () => {
    setEditMode("select");
    showToast(t("Select mode (B) — Follow roads snaps selected points only"), 1800);
  });
  els.btnAddBlocker?.addEventListener("click", () => {
    if (editMode !== "path") setEditMode("path");
    setPlacingBlocker(!placingBlocker);
    showToast(
      placingBlocker
        ? t("Click the map to drop a blocker")
        : t("Blocker placement off"),
      1600,
    );
  });
  els.btnSetStart?.addEventListener("click", () => {
    rotatePathStart(focusIdx);
  });
  els.btnSetLast?.addEventListener("click", () => {
    setPathLast(focusIdx);
  });
  els.btnClearBlockers?.addEventListener("click", () => {
    clearBlockers();
  });
  els.btnSelectOffsets?.addEventListener("click", () => {
    if (editMode !== "select") setEditMode("select");
    selectOffsetPoints();
  });
  els.btnDeleteSelected?.addEventListener("click", () => {
    deleteSelectedPoints();
  });
  els.btnClearSelection?.addEventListener("click", () => {
    clearSelection();
  });

  document.getElementById("contrib-snap-stops")?.addEventListener("click", () => {
    if (!stopMarkers.length || points.length < 2) {
      showToast(t("Load a path first"), 1600);
      return;
    }
    reprojectVisualStops();
    showToast(t("Visual stops snapped to path (official unchanged)"), 2000);
    setStatus(t("Visual stops re-projected onto path · official coords still fixed"));
  });

  els.btnFollowRoads?.addEventListener("click", () => {
    void runFollowRoadsAssist();
  });
  document.getElementById("contrib-follow-confirm")?.addEventListener(
    "click",
    () => confirmFollowRoads(),
  );
  document.getElementById("contrib-follow-revert")?.addEventListener(
    "click",
    () => revertFollowRoads(),
  );
  document.getElementById("contrib-clear-follow-debug")?.addEventListener(
    "click",
    () => {
      if (followPending) {
        showToast(t("Confirm or Revert the path first"), 2000);
        return;
      }
      clearFollowRoadsDebug();
      showToast(t("Follow-roads overlay hidden"), 1200);
    },
  );

  els.btnImport?.addEventListener("click", () => {
    els.importFile?.click();
  });
  els.importFile?.addEventListener("change", () => {
    const f = els.importFile?.files?.[0];
    if (!f) return;
    void importContributionJson(f).finally(() => {
      // allow re-importing the same file
      if (els.importFile) els.importFile.value = "";
    });
  });

  // Drag-and-drop JSON onto the contribute panel
  els.sheet?.addEventListener("dragover", (e) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
  });
  els.sheet?.addEventListener("drop", (e) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const name = String(f.name || "").toLowerCase();
    if (!name.endsWith(".json") && f.type && !f.type.includes("json")) {
      showToast(t("Drop a .json contribution file"), 2000);
      return;
    }
    void importContributionJson(f);
  });

  syncDesktopGate();
  window.addEventListener("resize", () => syncDesktopGate());
  try {
    window.matchMedia("(min-width: 900px)").addEventListener("change", syncDesktopGate);
    window.matchMedia("(pointer: fine)").addEventListener("change", syncDesktopGate);
  } catch {
    /* older Safari */
  }

  // After OAuth callback (?gh_login=1) reopen contribute panel
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get("gh_login") === "1") {
      u.searchParams.delete("gh_login");
      const cleaned = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : "") + u.hash;
      history.replaceState({}, "", cleaned);
      void refreshGithubAuth().then(() => {
        // Delay so map / desktop gate are ready
        setTimeout(() => {
          if (isDesktopContribute()) open();
          showToast(
            ghSession.logged_in
              ? `Signed in as @${ghSession.login}`
              : "GitHub login finished",
            2400,
          );
        }, 200);
      });
    } else {
      void refreshGithubAuth();
    }
  } catch {
    void refreshGithubAuth();
  }

  els.sheet?.querySelectorAll("[data-contrib-close]").forEach((btn) => {
    btn.addEventListener("click", () => close());
  });

  els.btnUndo?.addEventListener("click", () => {
    undoPathEdit();
  });
  els.btnRedo?.addEventListener("click", () => {
    redoPathEdit();
  });
  els.btnClear?.addEventListener("click", () => {
    pushPathHistory();
    points = [];
    stopMarkers = [];
    selectedIdx.clear();
    offsetIdx.clear();
    focusIdx = -1;
    blockers = [];
    setPlacingBlocker(false);
    paintDraft();
    updateUndoRedoButtons();
    setStatus(t("Path cleared"));
  });
  els.btnFromPlan?.addEventListener("click", () => fillFromPlan());
  els.btnLoad?.addEventListener("click", () => void loadPathFromSearch());
  els.routeSearch?.addEventListener("input", () => void onRouteSearchInput());
  els.routeSearch?.addEventListener("focus", () => {
    if (els.routeSuggest && els.routeSuggest.childElementCount) {
      els.routeSuggest.hidden = false;
    }
  });
  document.addEventListener("click", (e) => {
    if (!els.routeSuggest || els.routeSuggest.hidden) return;
    if (e.target === els.routeSearch || els.routeSuggest.contains(e.target)) return;
    hideSuggest();
  });

  els.btnDownload?.addEventListener("click", () => {
    const draft = buildDraft();
    if (!draft) return;
    downloadDraft(draft);
    showToast(t("JSON downloaded"), 2000);
  });

  document.querySelectorAll('input[name="contrib-submit-mode"]').forEach((el) => {
    el.addEventListener("change", () => updateAuthUi());
  });
  els.ghLoginBtn?.addEventListener("click", () => startGithubLogin());
  els.ghLogout?.addEventListener("click", () => void logoutGithub());

  els.btnSubmit?.addEventListener("click", async () => {
    const draft = buildDraft();
    if (!draft) return;
    const submit_mode = getSubmitMode();

    if (submit_mode === "oauth" && !ghSession.logged_in) {
      showToast(t("Log in with GitHub first (or switch to Bot account)"), 2800);
      els.ghLoginBtn?.focus();
      return;
    }

    // Prefill contributor from GitHub if empty
    if (
      submit_mode === "oauth" &&
      ghSession.login &&
      els.name &&
      !String(els.name.value || "").trim()
    ) {
      els.name.value = ghSession.login;
      draft.contributor = ghSession.login;
    }

    const btn = els.btnSubmit;
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    }
    lastSubmitDraft = draft;
    showSubmitOverlayLoading();
    const t0 = Date.now();
    await waitForPaint();
    try {
      const res = await submitPathContribution(draft, { submit_mode });
      // Keep loading visible briefly so it doesn't flash away on fast local API
      const elapsed = Date.now() - t0;
      if (elapsed < 450) {
        await new Promise((r) => setTimeout(r, 450 - elapsed));
      }

      const prUrl = res.github_pr_url || res.local_review_url || null;
      const pts = Array.isArray(draft.coordinates) ? draft.coordinates.length : 0;
      const meta = [
        draft.agency,
        draft.route_short_name,
        t("{pts} pts", { pts }),
        res.submit_mode || submit_mode,
        res.github_author ? t("as {author}", { author: res.github_author }) : "",
        draft.id ? t("id {id}", { id: draft.id }) : "",
      ]
        .filter(Boolean)
        .join(" · ");

      if (res.accepted) {
        let msg = res.message || t("Your path was submitted for review.");
        if (res.github_pr && prUrl) {
          msg =
            submit_mode === "oauth"
              ? t("Your path was submitted and a pull request was opened from your GitHub account.")
              : t("Your path was submitted and a review pull request was opened by the site bot.");
        } else if (res.local_pending) {
          msg =
            t("Saved locally to the overrides pending folder. Open the review page or merge via npm run overrides:merge.");
        } else if (res.stored) {
          msg = t("Your path was saved to the review queue.");
        }
        showSubmitOverlayResult({
          ok: true,
          title: "Submit successful",
          message: msg,
          meta,
          prUrl,
          prLabel: res.github_pr
            ? "Visit your PR"
            : res.local_review_url
              ? "View local draft"
              : "Visit your PR",
          draft,
        });
      } else {
        showSubmitOverlayResult({
          ok: false,
          title: "Submit incomplete",
          message:
            res.message ||
            "Server validated the draft but could not open a PR or store it. Download JSON and share with mods.",
          meta,
          prUrl: null,
          draft,
        });
      }
    } catch (err) {
      console.warn("[contribute] API submit failed", err);
      if (err?.data?.need_login || err?.status === 401) {
        void refreshGithubAuth();
        showSubmitOverlayResult({
          ok: false,
          title: t("GitHub login required"),
          message:
            t("Log in with GitHub to submit with your account, or switch to Bot account."),
          meta: draft.id ? t("id {id}", { id: draft.id }) : "",
          prUrl: null,
          draft,
        });
      } else {
        const errMsg =
          err?.message ||
          err?.data?.error ||
          t("Could not reach the submit API.");
        showSubmitOverlayResult({
          ok: false,
          title: t("Submit failed"),
          message: `${errMsg} ${t("Download or copy the JSON and share it with moderators if needed.")}`,
          meta: draft.id ? t("id {id}", { id: draft.id }) : "",
          prUrl: null,
          draft,
        });
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      }
    }
  });

  els.submitOverlay?.querySelectorAll("[data-contrib-submit-dismiss]").forEach((el) => {
    el.addEventListener("click", (e) => {
      // Don't dismiss while still loading unless Done/scrim after result
      if (els.submitOverlay?.getAttribute("aria-busy") === "true") {
        e.preventDefault();
        return;
      }
      hideSubmitOverlay();
    });
  });
  els.submitDownload?.addEventListener("click", () => {
    const d = lastSubmitDraft || buildDraft();
    if (!d) {
      showToast(t("No draft to download"), 1600);
      return;
    }
    downloadDraft(d);
    showToast(t("JSON downloaded"), 1600);
  });
  els.submitCopy?.addEventListener("click", async () => {
    const d = lastSubmitDraft || buildDraft();
    if (!d) {
      showToast(t("No draft to copy"), 1600);
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
      showToast(t("JSON copied"), 1600);
    } catch {
      showToast(t("Could not copy — use Download instead"), 2200);
    }
  });

  els.btnCopy?.addEventListener("click", async () => {
    const draft = buildDraft();
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
      showToast(t("JSON copied to clipboard"), 1800);
    } catch {
      showToast(t("Could not copy — use Download instead"), 2200);
    }
  });

  return {
    open,
    close,
    isOpen: () => active,
  };
}
