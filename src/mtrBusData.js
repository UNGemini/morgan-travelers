/**
 * MTR Bus (LRT Feeder) open data — routes + stop sequences.
 * https://opendata.mtr.com.hk/data/mtr_bus_routes.csv
 * https://opendata.mtr.com.hk/data/mtr_bus_stops.csv
 * Live ETA: POST /eta/mtr/bus/getSchedule { language, routeName }
 *
 * Load order (same pattern as LRT):
 *  1) Bundled public/data/*.csv (COEP-safe)
 *  2) /eta/mtr-open proxy
 *  3) Direct opendata.mtr.com.hk (may fail under COEP)
 */

import { fetchDataText } from "./offlineCache.js";

/** Same-origin static bundle */
function staticUrl(file) {
  try {
    const base =
      (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "./";
    if (typeof window !== "undefined" && window.location?.href) {
      return new URL(`${base}data/${file}`, window.location.href).href;
    }
  } catch {
    /* ignore */
  }
  return `/data/${file}`;
}

const ROUTES_PROXY = "/eta/mtr-open/data/mtr_bus_routes.csv";
const STOPS_PROXY = "/eta/mtr-open/data/mtr_bus_stops.csv";
const ROUTES_DIRECT = "https://opendata.mtr.com.hk/data/mtr_bus_routes.csv";
const STOPS_DIRECT = "https://opendata.mtr.com.hk/data/mtr_bus_stops.csv";

/**
 * @typedef {{
 *   id: string,
 *   nameEn: string,
 *   nameZh: string,
 *   circular: boolean,
 *   lineUp: string,
 *   lineDown: string,
 *   refId: string,
 * }} MtrBusRoute
 *
 * @typedef {{
 *   routeId: string,
 *   direction: string,
 *   seq: number,
 *   stopId: string,
 *   lat: number,
 *   lon: number,
 *   nameZh: string,
 *   nameEn: string,
 *   refId: string,
 * }} MtrBusStop
 */

/** null = not loaded / failed (retry ok); array = loaded */
/** @type {MtrBusRoute[] | null} */
let routesCache = null;
/** @type {MtrBusStop[] | null} */
let stopsCache = null;
/** @type {Promise<void> | null} */
let loadPromise = null;

/**
 * Minimal CSV parser (handles quoted fields + BOM).
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let inQ = false;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => String(x).trim())) rows.push(row);
      row = [];
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((x) => String(x).trim())) rows.push(row);
  }
  return rows;
}

/**
 * @param {string} url
 * @param {{ preferCache?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function fetchText(url, opts = {}) {
  const text = opts.preferCache
    ? await fetchDataText(url)
    : await (async () => {
        const res = await fetch(url, {
          headers: { Accept: "text/csv,text/plain,*/*" },
        });
        if (!res.ok) throw new Error(`MTR bus CSV ${res.status} @ ${url}`);
        return res.text();
      })();
  if (!text || text.length < 40) {
    throw new Error(`MTR bus CSV empty @ ${url}`);
  }
  return text;
}

/**
 * @param {string} kind routes | stops
 * @returns {Promise<{ text: string, via: string }>}
 */
async function loadCsvText(kind) {
  const file =
    kind === "routes" ? "mtr_bus_routes.csv" : "mtr_bus_stops.csv";
  const staticU = staticUrl(file);
  const proxy = kind === "routes" ? ROUTES_PROXY : STOPS_PROXY;
  const direct = kind === "routes" ? ROUTES_DIRECT : STOPS_DIRECT;
  let lastErr = null;
  for (const [url, preferCache] of [
    [staticU, true],
    [proxy, false],
    [direct, false],
  ]) {
    try {
      const text = await fetchText(url, { preferCache });
      // Sanity: must look like MTR bus headers
      if (
        /route_id/i.test(text) &&
        (kind === "routes"
          ? /route_name/i.test(text)
          : /station_id|station_name/i.test(text))
      ) {
        return { text, via: url };
      }
      throw new Error(`unusable CSV @ ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`MTR bus ${kind} CSV unavailable`);
}

/**
 * @param {string[]} head
 * @param {string[]} names
 */
function colIndex(head, names) {
  for (const n of names) {
    const i = head.indexOf(n);
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = head.findIndex((h) => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Load routes + stops once (retry after failure).
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function ensureMtrBusData(opts = {}) {
  if (opts.force) {
    routesCache = null;
    stopsCache = null;
    loadPromise = null;
  }
  if (routesCache !== null && stopsCache !== null) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const [routesPack, stopsPack] = await Promise.all([
        loadCsvText("routes"),
        loadCsvText("stops"),
      ]);
      const routeRows = parseCsv(routesPack.text);
      const stopRows = parseCsv(stopsPack.text);

      const rHead = (routeRows[0] || []).map((h) =>
        String(h).trim().toUpperCase().replace(/\s+/g, "_"),
      );
      const sHead = (stopRows[0] || []).map((h) =>
        String(h).trim().toUpperCase().replace(/\s+/g, "_"),
      );

      const ri = (...names) => colIndex(rHead, names);
      const si = (...names) => colIndex(sHead, names);

      const iRid = ri("ROUTE_ID");
      const iNameZh = ri("ROUTE_NAME_CHI", "ROUTE_NAME_ZH");
      const iNameEn = ri("ROUTE_NAME_ENG", "ROUTE_NAME_EN");
      const iCirc = ri("IS_CIRCULAR");
      const iUp = ri("LINE_UP");
      const iDown = ri("LINE_DOWN");
      const iRef = ri("REFERENCE_ID");

      /** @type {MtrBusRoute[]} */
      const routes = [];
      for (const row of routeRows.slice(1)) {
        const id = String(row[iRid >= 0 ? iRid : 0] || "")
          .trim()
          .toUpperCase();
        if (!id || id === "ROUTE_ID") continue;
        routes.push({
          id,
          nameZh: String(row[iNameZh >= 0 ? iNameZh : 1] || "").trim(),
          nameEn: String(row[iNameEn >= 0 ? iNameEn : 2] || "").trim(),
          circular: String(row[iCirc >= 0 ? iCirc : 3] || "0") === "1",
          lineUp: String(row[iUp >= 0 ? iUp : 4] || "").trim(),
          lineDown: String(row[iDown >= 0 ? iDown : 5] || "").trim(),
          refId: String(row[iRef >= 0 ? iRef : 6] || id).trim(),
        });
      }

      const iSRoute = si("ROUTE_ID");
      const iSDir = si("DIRECTION");
      const iSSeq = si("STATION_SEQNO", "SEQ", "STATION_SEQ");
      const iSId = si("STATION_ID", "STOP_ID", "BUS_STOP_ID");
      const iSLat = si("STATION_LATITUDE", "LATITUDE", "LAT");
      const iSLon = si("STATION_LONGITUDE", "LONGITUDE", "LON", "LNG");
      const iSZh = si("STATION_NAME_CHI", "STATION_NAME_ZH", "NAME_CHI");
      const iSEn = si("STATION_NAME_ENG", "STATION_NAME_EN", "NAME_ENG");
      const iSRef = si("REFERENCE_ID");

      /** @type {MtrBusStop[]} */
      const stops = [];
      for (const row of stopRows.slice(1)) {
        const routeId = String(row[iSRoute >= 0 ? iSRoute : 0] || "")
          .trim()
          .toUpperCase();
        const stopId = String(row[iSId >= 0 ? iSId : 3] || "").trim();
        if (!routeId || !stopId || routeId === "ROUTE_ID") continue;
        const lat = Number(row[iSLat >= 0 ? iSLat : 4]);
        const lon = Number(row[iSLon >= 0 ? iSLon : 5]);
        // Keep stops even without coords so names/dest still show
        stops.push({
          routeId,
          direction: String(row[iSDir >= 0 ? iSDir : 1] || "O")
            .trim()
            .toUpperCase(),
          seq: Number(row[iSSeq >= 0 ? iSSeq : 2]) || 0,
          stopId,
          lat: Number.isFinite(lat) ? lat : NaN,
          lon: Number.isFinite(lon) ? lon : NaN,
          nameZh: String(row[iSZh >= 0 ? iSZh : 6] || "").trim(),
          nameEn: String(row[iSEn >= 0 ? iSEn : 7] || "").trim(),
          refId: String(row[iSRef >= 0 ? iSRef : 8] || routeId).trim(),
        });
      }

      if (!routes.length && !stops.length) {
        throw new Error("MTR bus parsed 0 routes and 0 stops");
      }

      routesCache = routes;
      stopsCache = stops;
      console.info(
        "[eta] MTR Bus data",
        routes.length,
        "routes,",
        stops.length,
        "stops",
        "via",
        routesPack.via,
        "+",
        stopsPack.via,
      );
    } catch (e) {
      console.warn("[eta] MTR Bus data load failed", e);
      // Leave null so a later open can retry (do not stick empty forever)
      routesCache = null;
      stopsCache = null;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/** @returns {MtrBusRoute[]} */
export function getMtrBusRoutes() {
  return routesCache || [];
}

/** @returns {MtrBusStop[]} */
export function getMtrBusStops() {
  return stopsCache || [];
}

/**
 * Unique route ids for catalog (prefer ROUTE_ID from routes file).
 * @returns {string[]}
 */
export function mtrBusRouteIds() {
  const ids = new Set();
  for (const r of routesCache || []) {
    if (r.id) ids.add(r.id);
  }
  for (const s of stopsCache || []) {
    if (s.routeId) ids.add(s.routeId);
  }
  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/**
 * Prefer primary variant (REFERENCE_ID === ROUTE_ID) so 506-1 etc. don't mix.
 * @param {string} routeId
 * @returns {MtrBusStop[]}
 */
function stopsForRoute(routeId) {
  const rid = String(routeId || "").toUpperCase();
  if (!rid || !stopsCache?.length) return [];
  const all = stopsCache.filter((s) => s.routeId === rid);
  if (!all.length) {
    // Match by reference id (e.g. catalog used 506-1)
    return stopsCache.filter(
      (s) => String(s.refId || "").toUpperCase() === rid,
    );
  }
  const primary = all.filter(
    (s) => String(s.refId || "").toUpperCase() === rid,
  );
  return primary.length ? primary : all;
}

/**
 * Parse "A to B" / "A至B" route name into OD ends.
 * @param {string} en
 * @param {string} zh
 * @returns {{ orig: string, dest: string, origZh?: string, destZh?: string } | null}
 */
function parseRouteNameOd(en, zh) {
  const enM = /^(.+?)\s+to\s+(.+)$/i.exec(String(en || "").trim());
  if (enM) {
    const zhM = /^(.+?)至(.+)$/.exec(String(zh || "").trim());
    return {
      orig: enM[1].trim(),
      dest: enM[2].trim(),
      origZh: zhM ? zhM[1].trim() : "",
      destZh: zhM ? zhM[2].trim() : "",
    };
  }
  const zhM = /^(.+?)至(.+)$/.exec(String(zh || "").trim());
  if (zhM) {
    return {
      orig: zhM[1].trim(),
      dest: zhM[2].trim(),
      origZh: zhM[1].trim(),
      destZh: zhM[2].trim(),
    };
  }
  return null;
}

/**
 * OD-style directions from stop ends, else route name.
 * @param {string} routeId
 * @returns {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>}
 */
export function mtrBusRouteDirections(routeId) {
  const rid = String(routeId || "").toUpperCase();
  const stops = stopsForRoute(rid);
  if (stops.length) {
    const fromStops = directionsFromStops(stops);
    if (fromStops.length) return fromStops;
  }

  // Fallback: parse official route name(s)
  const metas = (routesCache || []).filter((r) => r.id === rid);
  /** @type {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>} */
  const out = [];
  // Prefer primary ref row
  const ordered = [
    ...metas.filter((r) => String(r.refId || "").toUpperCase() === rid),
    ...metas,
  ];
  const seen = new Set();
  for (const meta of ordered) {
    const key = meta.refId || meta.nameEn;
    if (seen.has(key)) continue;
    seen.add(key);
    const od = parseRouteNameOd(meta.nameEn, meta.nameZh);
    if (!od) continue;
    // Only emit first variant as O/I pair for the main catalog entry
    if (!out.length) {
      out.push({
        bound: "O",
        dest: od.dest,
        destZh: od.destZh || "",
        orig: od.orig,
      });
      if (!meta.circular) {
        out.push({
          bound: "I",
          dest: od.orig,
          destZh: od.origZh || "",
          orig: od.dest,
        });
      }
    }
  }
  return out;
}

/**
 * @param {MtrBusStop[]} stops
 */
function directionsFromStops(stops) {
  /** @type {Map<string, MtrBusStop[]>} */
  const byDir = new Map();
  for (const s of stops) {
    const d = s.direction || "O";
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(s);
  }
  /** @type {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>} */
  const out = [];
  for (const bound of ["O", "I", ...byDir.keys()]) {
    const arr = byDir.get(bound);
    if (!arr?.length) continue;
    if (out.some((x) => x.bound === bound)) continue;
    arr.sort((a, b) => a.seq - b.seq);
    const first = arr[0];
    const last = arr[arr.length - 1];
    out.push({
      bound,
      dest: last.nameEn || last.nameZh || "—",
      destZh: last.nameZh || "",
      orig: first.nameEn || first.nameZh || "",
    });
  }
  return out;
}

/**
 * Stop sequence for a route bound.
 * @param {string} routeId
 * @param {string} [bound] O | I
 * @returns {Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>}
 */
export function mtrBusStopSequence(routeId, bound = "O") {
  const rid = String(routeId || "").toUpperCase();
  const b = String(bound || "O").toUpperCase();
  let list = stopsForRoute(rid).filter((s) => s.direction === b);
  if (!list.length) {
    // Any direction for this route (one-way / circular)
    list = stopsForRoute(rid);
  }
  list = list.slice().sort((a, b2) => a.seq - b2.seq);
  // Prefer rows with coords for map; still keep named stops for list
  return list.map((s) => ({
    seq: s.seq,
    name: s.nameZh || s.nameEn || s.stopId,
    nameEn: s.nameEn || "",
    nameTc: s.nameZh || "",
    stopId: s.stopId,
    lon: s.lon,
    lat: s.lat,
  }));
}

/**
 * Nearby MTR Bus stops within radius.
 * @param {{ lat: number, lon: number }} geo
 * @param {number} [radiusM]
 * @returns {Array<{ stop: MtrBusStop, distM: number }>}
 */
export function nearbyMtrBusStops(geo, radiusM = 500) {
  if (!geo || !stopsCache?.length) return [];
  const out = [];
  for (const s of stopsCache) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    // Prefer primary variant so nearby doesn't double-count 506-1
    const ref = String(s.refId || "").toUpperCase();
    if (ref && ref !== s.routeId && !ref.startsWith(s.routeId + "-")) {
      /* keep all */
    }
    const d = haversineM(geo.lat, geo.lon, s.lat, s.lon);
    if (d <= radiusM) out.push({ stop: s, distM: d });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
