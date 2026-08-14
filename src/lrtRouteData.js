/**
 * LRT route stop sequences from MTR open data:
 * https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv
 *
 * Live ETA: GET /eta/mtr/lrt/getSchedule?station_id={Stop ID}
 */

import { LRT_STOPS } from "./lrtStops.js";
import { fetchDataText } from "./offlineCache.js";

/** Same-origin static bundle (COEP-safe, no proxy required) */
function lrtCsvStaticUrl() {
  try {
    const base =
      (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "./";
    if (typeof window !== "undefined" && window.location?.href) {
      return new URL(`${base}data/light_rail_routes_and_stops.csv`, window.location.href)
        .href;
    }
  } catch {
    /* ignore */
  }
  return "/data/light_rail_routes_and_stops.csv";
}
/** Dev/prod proxy → opendata.mtr.com.hk */
const CSV_PROXY = "/eta/mtr-open/data/light_rail_routes_and_stops.csv";
/** Direct open data (only works without COEP require-corp) */
const CSV_DIRECT =
  "https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv";

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

/** null = not loaded yet; array (possibly empty) = finished attempt */
/** @type {LrtRouteStopRow[] | null} */
let rowsCache = null;
/** @type {Promise<void> | null} */
let loadPromise = null;

/**
 * Peak-hour / short-working routes missing from MTR open-data CSV.
 * 751P: Tin Shui Wai ↔ Tin Yat (subset of 751 TSW section).
 * Sources: MTR schedule notes, stop order matches 751 seq 15–23.
 * @type {LrtRouteStopRow[]}
 */
const LRT_ROUTE_OVERRIDES = (() => {
  /** @type {Array<[string, string, string, string, string]>} code, stopId, zh, en */
  const stops = [
    ["TSL", "430", "天水圍", "Tin Shui Wai"],
    ["TIT", "435", "天慈", "Tin Tsz"],
    ["TWU", "450", "天湖", "Tin Wu"],
    ["GIN", "455", "銀座", "Ginza"],
    ["TWI", "500", "天榮", "Tin Wing"],
    ["CHE", "490", "翠湖", "Chestwood"],
    ["CHF", "468", "頌富", "Chung Fu"],
    ["TFU", "480", "天富", "Tin Fu"],
    ["TYA", "550", "天逸", "Tin Yat"],
  ];
  /** @type {LrtRouteStopRow[]} */
  const rows = [];
  // Dir 1 = O: Tin Shui Wai → Tin Yat
  stops.forEach(([code, id, zh, en], i) => {
    rows.push({
      route: "751P",
      direction: "1",
      stopCode: code,
      stopId: id,
      nameZh: zh,
      nameEn: en,
      seq: i + 1,
    });
  });
  // Dir 2 = I: Tin Yat → Tin Shui Wai
  [...stops].reverse().forEach(([code, id, zh, en], i) => {
    rows.push({
      route: "751P",
      direction: "2",
      stopCode: code,
      stopId: id,
      nameZh: zh,
      nameEn: en,
      seq: i + 1,
    });
  });
  return rows;
})();

/**
 * Merge open-data rows with local overrides (overrides win for same route+dir+seq).
 * @param {LrtRouteStopRow[]} rows
 */
function mergeLrtOverrides(rows) {
  const has = new Set(rows.map((r) => r.route));
  const out = rows.slice();
  for (const o of LRT_ROUTE_OVERRIDES) {
    if (!has.has(o.route)) {
      // Whole route missing from open data — inject all override rows for that route once
      const all = LRT_ROUTE_OVERRIDES.filter((x) => x.route === o.route);
      out.push(...all);
      has.add(o.route);
    }
  }
  return out;
}

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

/**
 * Load Light Rail route–stop CSV once.
 * @param {{ force?: boolean }} [opts] force — clear cache and reload
 */
export async function ensureLrtRouteData(opts = {}) {
  if (opts.force) {
    rowsCache = null;
    loadPromise = null;
  }
  // null = not loaded / last load failed (retry allowed)
  // array = successfully loaded
  if (rowsCache !== null) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      // 1) Bundled static file (always same-origin / COEP-safe)
      // 2) /eta/mtr-open proxy
      // 3) Direct MTR open data (may fail under COEP)
      let text = "";
      let lastErr = null;
      let used = "";
      const staticUrl = lrtCsvStaticUrl();
      for (const url of [staticUrl, CSV_PROXY, CSV_DIRECT]) {
        try {
          const body =
            url === staticUrl
              ? await fetchDataText(url)
              : await (async () => {
                  const res = await fetch(url, {
                    headers: { Accept: "text/csv,text/plain,*/*" },
                  });
                  if (!res.ok) throw new Error(`LRT CSV ${res.status} @ ${url}`);
                  return res.text();
                })();
          if (body && /line\s*code|sequence/i.test(body) && body.length > 40) {
            text = body;
            used = url;
            break;
          }
          throw new Error(`LRT CSV unusable @ ${url} (len=${body?.length || 0})`);
        } catch (e) {
          lastErr = e;
        }
      }
      if (!text) throw lastErr || new Error("LRT CSV empty");
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
      if (!rows.length) {
        throw new Error(`LRT CSV parsed 0 rows (from ${used || "?"})`);
      }
      rowsCache = mergeLrtOverrides(rows);
      const extra = rowsCache.length - rows.length;
      console.info(
        "[eta] LRT route-stops rows",
        rowsCache.length,
        "via",
        used,
        extra > 0 ? `(+${extra} peak-route overrides)` : "",
      );
    } catch (e) {
      console.warn("[eta] LRT route data", e);
      // Still ship overrides so 751P etc. work offline / after CSV failure
      if (LRT_ROUTE_OVERRIDES.length) {
        rowsCache = LRT_ROUTE_OVERRIDES.slice();
        console.info(
          "[eta] LRT using peak-route overrides only",
          rowsCache.length,
        );
      } else {
        // Leave null so a later open can retry (do not stick empty forever)
        rowsCache = null;
      }
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
  const code = String(row.stopCode || "").toUpperCase();
  const sid = String(row.stopId || "").trim();
  const en = String(row.nameEn || "").trim().toLowerCase();
  const byCode = code
    ? LRT_STOPS.find((s) => s.code && String(s.code).toUpperCase() === code)
    : null;
  if (byCode && Number.isFinite(byCode.lat)) return byCode;
  const byId = sid
    ? LRT_STOPS.find(
        (s) => s.stop_id != null && String(s.stop_id).trim() === sid,
      )
    : null;
  if (byId && Number.isFinite(byId.lat)) return byId;
  const byName = en
    ? LRT_STOPS.find(
        (s) => String(s.name_en || "").toLowerCase() === en,
      )
    : null;
  if (byName && Number.isFinite(byName.lat)) return byName;
  // Partial EN (e.g. "Town Centre" vs "Tuen Mun Town Centre")
  if (en && en.length >= 4) {
    const soft = LRT_STOPS.find((s) => {
      const n = String(s.name_en || "").toLowerCase();
      return n === en || n.includes(en) || en.includes(n);
    });
    if (soft && Number.isFinite(soft.lat)) return soft;
  }
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

  /** @type {Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number, code?: string }>} */
  const out = [];
  for (const row of list) {
    const hit = resolveCoords(row);
    // Live ETA needs raw numeric Stop ID from open data
    const sid = row.stopId || hit?.stop_id || "";
    const nameEn = row.nameEn || hit?.name_en || "";
    const nameTc = row.nameZh || hit?.name_zh || "";
    // Keep stops even without coords so the list / destination still show;
    // map painting skips non-finite points.
    const lat = hit && Number.isFinite(hit.lat) ? hit.lat : NaN;
    const lon = hit && Number.isFinite(hit.lon) ? hit.lon : NaN;
    out.push({
      seq: row.seq || out.length + 1,
      name: nameTc
        ? `${nameTc} ${nameEn}`.trim()
        : nameEn || row.stopCode || sid,
      nameEn,
      nameTc,
      stopId: String(sid),
      code: row.stopCode || hit?.code || "",
      lon,
      lat,
    });
  }
  return out;
}
