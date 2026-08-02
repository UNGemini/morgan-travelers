/**
 * LRT route stop sequences from MTR open data:
 * https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv
 *
 * Live ETA: GET /eta/mtr/lrt/getSchedule?station_id={Stop ID}
 */

import { LRT_STOPS } from "./lrtStops.js";

const CSV_URL = "/eta/mtr-open/data/light_rail_routes_and_stops.csv";

/**
 * @typedef {{
 *   route: string,
 *   direction: string,
 *   stopCode: string,
 *   stopId: string,
 *   nameZh: string,
 *   nameEn: string,
 *   seq: number,
 * }} LrtRouteStopRow
 */

/** @type {LrtRouteStopRow[] | null} */
let rowsCache = null;
/** @type {Promise<void> | null} */
let loadPromise = null;

/**
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

export async function ensureLrtRouteData() {
  if (rowsCache) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const res = await fetch(CSV_URL, {
        headers: { Accept: "text/csv,text/plain,*/*" },
        cache: "force-cache",
      });
      if (!res.ok) throw new Error(`LRT CSV ${res.status}`);
      const text = await res.text();
      const table = parseCsv(text);
      const head = (table[0] || []).map((h) =>
        String(h).trim().toLowerCase().replace(/\s+/g, " "),
      );
      // Flexible header match
      const idx = (names) => {
        for (const n of names) {
          const i = head.indexOf(n);
          if (i >= 0) return i;
        }
        // fallback: substring
        for (const n of names) {
          const i = head.findIndex((h) => h.includes(n));
          if (i >= 0) return i;
        }
        return -1;
      };
      const iRoute = idx(["line code", "linecode", "route"]);
      const iDir = idx(["direction"]);
      const iCode = idx(["stop code", "stopcode"]);
      const iId = idx(["stop id", "stopid"]);
      const iZh = idx(["chinese name", "chinese"]);
      const iEn = idx(["english name", "english"]);
      const iSeq = idx(["sequence", "seq"]);

      /** @type {LrtRouteStopRow[]} */
      const rows = [];
      for (const cols of table.slice(1)) {
        const route = String(cols[iRoute >= 0 ? iRoute : 0] || "")
          .trim()
          .toUpperCase();
        if (!route) continue;
        rows.push({
          route,
          direction: String(cols[iDir >= 0 ? iDir : 1] || "").trim(),
          stopCode: String(cols[iCode >= 0 ? iCode : 2] || "")
            .trim()
            .toUpperCase(),
          stopId: String(cols[iId >= 0 ? iId : 3] || "").trim(),
          nameZh: String(cols[iZh >= 0 ? iZh : 4] || "").trim(),
          nameEn: String(cols[iEn >= 0 ? iEn : 5] || "").trim(),
          seq: Number(cols[iSeq >= 0 ? iSeq : 6]) || 0,
        });
      }
      rowsCache = rows;
      console.info("[eta] LRT route-stops rows", rows.length);
    } catch (e) {
      console.warn("[eta] LRT route data", e);
      rowsCache = rowsCache || [];
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/**
 * @param {string} routeId
 * @returns {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>}
 */
export function lrtRouteDirections(routeId) {
  const r = String(routeId || "").toUpperCase();
  const rows = (rowsCache || []).filter((x) => x.route === r);
  if (!rows.length) return [{ dest: `Light Rail ${r}`, bound: "lrt" }];

  /** @type {Map<string, LrtRouteStopRow[]>} */
  const byDir = new Map();
  for (const row of rows) {
    const d = String(row.direction || "1");
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(row);
  }
  /** @type {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>} */
  const out = [];
  // Map CSV direction 1 → O, 2 → I
  for (const [csvDir, bound] of [
    ["1", "O"],
    ["2", "I"],
  ]) {
    const arr = (byDir.get(csvDir) || []).slice().sort((a, b) => a.seq - b.seq);
    if (!arr.length) continue;
    const first = arr[0];
    const last = arr[arr.length - 1];
    out.push({
      bound,
      dest: last.nameEn || last.nameZh || "—",
      destZh: last.nameZh || "",
      orig: first.nameEn || first.nameZh || "",
    });
  }
  // Any other direction codes
  for (const [csvDir, arr0] of byDir) {
    if (csvDir === "1" || csvDir === "2") continue;
    const arr = arr0.slice().sort((a, b) => a.seq - b.seq);
    if (!arr.length) continue;
    const last = arr[arr.length - 1];
    const first = arr[0];
    out.push({
      bound: csvDir,
      dest: last.nameEn || last.nameZh || "—",
      destZh: last.nameZh || "",
      orig: first.nameEn || first.nameZh || "",
    });
  }
  return out.length ? out : [{ dest: `Light Rail ${r}`, bound: "lrt" }];
}

/**
 * Resolve coords for a CSV stop row via LRT_STOPS directory.
 * @param {LrtRouteStopRow} row
 */
function resolveCoords(row) {
  const byCode = LRT_STOPS.find(
    (s) => s.code && String(s.code).toUpperCase() === row.stopCode,
  );
  if (byCode && Number.isFinite(byCode.lat)) return byCode;
  const byId = LRT_STOPS.find(
    (s) => s.stop_id && String(s.stop_id) === String(row.stopId),
  );
  if (byId && Number.isFinite(byId.lat)) return byId;
  const byName = LRT_STOPS.find(
    (s) =>
      String(s.name_en || "").toLowerCase() ===
      String(row.nameEn || "").toLowerCase(),
  );
  if (byName && Number.isFinite(byName.lat)) return byName;
  return null;
}

/**
 * @param {string} routeId
 * @param {string} [bound] O|I|1|2
 * @returns {Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>}
 */
export function lrtStopSequence(routeId, bound = "O") {
  const r = String(routeId || "").toUpperCase();
  const b = String(bound || "O").toUpperCase();
  // Map O/I ↔ 1/2
  let csvDir = b;
  if (b === "O" || b === "OUTBOUND" || b === "1" || b === "UP") csvDir = "1";
  else if (b === "I" || b === "INBOUND" || b === "2" || b === "DOWN")
    csvDir = "2";
  else if (b === "LRT" || b === "LINE") csvDir = "1";

  let list = (rowsCache || []).filter(
    (x) => x.route === r && String(x.direction) === csvDir,
  );
  if (!list.length) {
    // fallback any direction for this route
    list = (rowsCache || []).filter((x) => x.route === r);
    // Prefer dir 1
    const d1 = list.filter((x) => String(x.direction) === "1");
    if (d1.length) list = d1;
  }
  list = list.slice().sort((a, b2) => a.seq - b2.seq);

  /** @type {Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>} */
  const out = [];
  for (const row of list) {
    const hit = resolveCoords(row);
    if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) continue;
    // Live ETA needs raw numeric Stop ID from open data
    const sid = row.stopId || hit.stop_id || "";
    out.push({
      seq: row.seq || out.length + 1,
      name: row.nameZh
        ? `${row.nameZh} ${row.nameEn || hit.name_en || ""}`.trim()
        : row.nameEn || hit.name_en || row.stopCode,
      nameEn: row.nameEn || hit.name_en || "",
      nameTc: row.nameZh || hit.name_zh || "",
      stopId: String(sid),
      lon: hit.lon,
      lat: hit.lat,
    });
  }
  return out;
}
