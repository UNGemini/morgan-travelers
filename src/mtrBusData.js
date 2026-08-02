/**
 * MTR Bus (LRT Feeder) open data — routes + stop sequences.
 * https://opendata.mtr.com.hk/data/mtr_bus_routes.csv
 * https://opendata.mtr.com.hk/data/mtr_bus_stops.csv
 * Live ETA: POST /eta/mtr/bus/getSchedule { language, routeName }
 */

const ROUTES_URL = "/eta/mtr-open/data/mtr_bus_routes.csv";
const STOPS_URL = "/eta/mtr-open/data/mtr_bus_stops.csv";

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

/** @type {MtrBusRoute[] | null} */
let routesCache = null;
/** @type {MtrBusStop[] | null} */
let stopsCache = null;
/** @type {Promise<void> | null} */
let loadPromise = null;

/**
 * Minimal CSV parser (handles quoted fields).
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let inQ = false;
  // strip BOM
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
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((x) => x.trim())) rows.push(row);
  }
  return rows;
}

/**
 * @param {string} url
 * @returns {Promise<string[][]>}
 */
async function fetchCsvRows(url) {
  const res = await fetch(url, {
    headers: { Accept: "text/csv,text/plain,*/*" },
    cache: "force-cache",
  });
  if (!res.ok) throw new Error(`MTR bus CSV ${res.status} ${url}`);
  const text = await res.text();
  return parseCsv(text);
}

/**
 * Load routes + stops once.
 * @returns {Promise<void>}
 */
export async function ensureMtrBusData() {
  if (routesCache && stopsCache) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const [routeRows, stopRows] = await Promise.all([
        fetchCsvRows(ROUTES_URL),
        fetchCsvRows(STOPS_URL),
      ]);
      const rHead = (routeRows[0] || []).map((h) => h.trim().toUpperCase());
      const sHead = (stopRows[0] || []).map((h) => h.trim().toUpperCase());
      const ri = (name) => rHead.indexOf(name);
      const si = (name) => sHead.indexOf(name);

      /** @type {MtrBusRoute[]} */
      const routes = [];
      for (const row of routeRows.slice(1)) {
        const id = String(row[ri("ROUTE_ID")] || "").trim().toUpperCase();
        if (!id) continue;
        routes.push({
          id,
          nameZh: String(row[ri("ROUTE_NAME_CHI")] || "").trim(),
          nameEn: String(row[ri("ROUTE_NAME_ENG")] || "").trim(),
          circular: String(row[ri("IS_CIRCULAR")] || "0") === "1",
          lineUp: String(row[ri("LINE_UP")] || "").trim(),
          lineDown: String(row[ri("LINE_DOWN")] || "").trim(),
          refId: String(row[ri("REFERENCE_ID")] || id).trim(),
        });
      }

      /** @type {MtrBusStop[]} */
      const stops = [];
      for (const row of stopRows.slice(1)) {
        const routeId = String(row[si("ROUTE_ID")] || "").trim().toUpperCase();
        const stopId = String(row[si("STATION_ID")] || "").trim();
        if (!routeId || !stopId) continue;
        const lat = Number(row[si("STATION_LATITUDE")]);
        const lon = Number(row[si("STATION_LONGITUDE")]);
        stops.push({
          routeId,
          direction: String(row[si("DIRECTION")] || "O")
            .trim()
            .toUpperCase(),
          seq: Number(row[si("STATION_SEQNO")]) || 0,
          stopId,
          lat,
          lon,
          nameZh: String(row[si("STATION_NAME_CHI")] || "").trim(),
          nameEn: String(row[si("STATION_NAME_ENG")] || "").trim(),
          refId: String(row[si("REFERENCE_ID")] || routeId).trim(),
        });
      }

      routesCache = routes;
      stopsCache = stops;
      console.info(
        "[eta] MTR Bus data",
        routes.length,
        "routes,",
        stops.length,
        "stops",
      );
    } catch (e) {
      console.warn("[eta] MTR Bus data load failed", e);
      routesCache = routesCache || [];
      stopsCache = stopsCache || [];
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
  // Fallback: stops may list variants not in routes
  for (const s of stopsCache || []) {
    if (s.routeId) ids.add(s.routeId);
  }
  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/**
 * OD-style directions from first/last stop names per bound.
 * @param {string} routeId
 * @returns {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>}
 */
export function mtrBusRouteDirections(routeId) {
  const rid = String(routeId || "").toUpperCase();
  const stops = (stopsCache || []).filter((s) => s.routeId === rid);
  if (!stops.length) {
    // Try REFERENCE_ID grouping (e.g. 506 vs 506-1)
    const byRef = (stopsCache || []).filter(
      (s) => String(s.refId || "").toUpperCase() === rid,
    );
    if (byRef.length) return directionsFromStops(byRef);
    return [];
  }
  return directionsFromStops(stops);
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
  let list = (stopsCache || []).filter(
    (s) => s.routeId === rid && s.direction === b,
  );
  if (!list.length) {
    // fall back to any direction / reference id
    list = (stopsCache || []).filter((s) => s.routeId === rid);
    if (!list.length) {
      const byRef = (stopsCache || []).filter(
        (s) => String(s.refId || "").toUpperCase() === rid,
      );
      const dirOnly = byRef.filter((s) => s.direction === b);
      list = dirOnly.length ? dirOnly : byRef;
    }
  }
  list = list.slice().sort((a, b2) => a.seq - b2.seq);
  return list
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({
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
