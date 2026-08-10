#!/usr/bin/env node
/**
 * Pack official + open fare tables for client-side estimates.
 *
 * Sources:
 *  - MTR open data: heavy rail, AEL, LRT, MTR Bus (multi ticket type)
 *  - TD FARE_BUS.mdb: franchised bus / GMB section fares (ON_SEQ→OFF_SEQ)
 *  - hk-bus-crawling routeFareList: full-journey fallback + ferry
 *
 * Usage: node scripts/build-fares.mjs
 * Requires: mdbtools (`mdb-export`) for TD bus section fares; when the binary
 * is missing (e.g. the Cloudflare Pages build image) the busSection already
 * in the output file is reused, so a deploy never silently drops section fares.
 * Output: public/fares/hk-fares.json
 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../public/fares/hk-fares.json");

/**
 * Pack matrix keys (client maps UI ticket types → these).
 * @typedef {
 *   | "octopus_adult"
 *   | "octopus_student"
 *   | "octopus_child"
 *   | "octopus_elderly"
 *   | "octopus_joyyou_60"
 *   | "single_adult"
 *   | "single_child"
 *   | "contactless"
 * } PackFareType
 */

const FARE_TYPES = [
  "octopus_adult",
  "octopus_student",
  "octopus_child",
  "octopus_elderly",
  "octopus_joyyou_60",
  "single_adult",
  "single_child",
  "contactless",
];

const SOURCES = {
  mtr: "https://opendata.mtr.com.hk/data/mtr_lines_fares.csv",
  ael: "https://opendata.mtr.com.hk/data/airport_express_fares.csv",
  lrt: "https://opendata.mtr.com.hk/data/light_rail_fares.csv",
  lrtStops: "https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv",
  mtrBus: "https://opendata.mtr.com.hk/data/mtr_bus_fares.csv",
  hkbus: "https://hkbus.github.io/hk-bus-crawling/routeFareList.min.json",
  /** TD routes-and-fares (section fare of bus route) */
  tdFareBus: "https://static.data.gov.hk/td/routes-and-fares/FARE_BUS.mdb",
  tdRouteBus: "https://static.data.gov.hk/td/routes-and-fares/ROUTE_BUS.mdb",
  tdRstopBus: "https://static.data.gov.hk/td/routes-and-fares/RSTOP_BUS.mdb",
};

/** TD COMPANY_CODE → client agency key (matches hkbus / GTFS heuristics) */
const TD_CO_MAP = {
  KMB: "kmb",
  LWB: "kmb",
  CTB: "ctb",
  NLB: "nlb",
  "KMB+CTB": "kmb",
  "LWB+CTB": "kmb",
  LRTFeeder: "lrtfeeder",
  GMB: "gmb",
  DB: "db",
  PI: "pi",
  XB: "xb",
};

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "MORGAN-Travelers/0.4 (fare-build)" },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "MORGAN-Travelers/0.4 (fare-build)" },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/** Minimal CSV parser (handles quoted fields). */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const row = [];
    while (i < len) {
      let cell = "";
      if (text[i] === '"') {
        i += 1;
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          cell += text[i++];
        }
      } else {
        while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          cell += text[i++];
        }
      }
      row.push(cell.trim());
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "\r") i += 1;
      if (text[i] === "\n") i += 1;
      break;
    }
    if (row.length === 1 && row[0] === "") continue;
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.replace(/^\uFEFF/, ""));
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, idx) => {
      o[h] = r[idx] ?? "";
    });
    return o;
  });
}

function money(s) {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function emptyTypeMaps() {
  /** @type {Record<string, { byId: Record<string, number>, byName: Record<string, number> }>} */
  const o = {};
  for (const t of FARE_TYPES) o[t] = { byId: {}, byName: {} };
  return o;
}

const MTR_COLS = {
  octopus_adult: "OCT_ADT_FARE",
  octopus_student: "OCT_STD_FARE",
  octopus_child: "OCT_CON_CHILD_FARE",
  // JoyYou 65+ / elderly concession (excl. AEL / Lo Wu / LMC enforced client-side)
  octopus_elderly: "OCT_CON_ELDERLY_FARE",
  // JoyYou 60–64 published column (client may also apply $2/20% formula)
  octopus_joyyou_60: "OCT_JOYYOU_SIXTY_FARE",
  single_adult: "SINGLE_ADT_FARE",
  single_child: "SINGLE_CON_CHILD_FARE",
  contactless: "OCT_ADT_FARE",
};

const AEL_COLS = {
  octopus_adult: "OCT_ADT_FARE",
  octopus_student: "OCT_ADT_FARE",
  octopus_child: "OCT_CHD_FARE",
  // No JoyYou / elderly concession on AEL
  octopus_elderly: "OCT_ADT_FARE",
  octopus_joyyou_60: "OCT_ADT_FARE",
  single_adult: "SINGLE_ADT_FARE",
  single_child: "SINGLE_CHD_FARE",
  contactless: "OCT_ADT_FARE",
};

const LRT_COLS = {
  octopus_adult: "fare_octo_adult",
  octopus_student: "fare_octo_student",
  octopus_child: "fare_octo_child",
  octopus_elderly: "fare_octo_elderly",
  octopus_joyyou_60: "fare_octo_joyyou_sixty",
  single_adult: "fare_single_adult",
  single_child: "fare_single_child",
  contactless: "fare_octo_adult",
};

const BUS_COLS = {
  octopus_adult: "FARE_OCTO_ADULT",
  octopus_student: "FARE_OCTO_STUDENT",
  octopus_child: "FARE_OCTO_CHILD",
  octopus_elderly: "FARE_OCTO_ELDERLY",
  octopus_joyyou_60: "FARE_OCTO_JOYU",
  single_adult: "FARE_SINGLE_ADULT",
  single_child: "FARE_SINGLE_CHILD",
  contactless: "FARE_OCTO_ADULT",
};

function packMtr(rows) {
  const byType = emptyTypeMaps();
  const idToName = {};
  for (const r of rows) {
    const sid = r.SRC_STATION_ID;
    const did = r.DEST_STATION_ID;
    const sn = r.SRC_STATION_NAME;
    const dn = r.DEST_STATION_NAME;
    if (sid && sn) idToName[sid] = sn;
    if (did && dn) idToName[did] = dn;
    for (const t of FARE_TYPES) {
      const fare = money(r[MTR_COLS[t]]);
      if (fare == null) continue;
      if (sid && did) byType[t].byId[`${sid}>${did}`] = fare;
      if (sn && dn) byType[t].byName[`${sn}|${dn}`] = fare;
    }
  }
  return {
    idToName,
    byType,
    byId: byType.octopus_adult.byId,
    byName: byType.octopus_adult.byName,
  };
}

function packAel(rows) {
  const byType = emptyTypeMaps();
  for (const r of rows) {
    for (const t of FARE_TYPES) {
      const fare = money(r[AEL_COLS[t]]);
      if (fare == null) continue;
      if (r.ST_FROM_ID && r.ST_TO_ID) byType[t].byId[`${r.ST_FROM_ID}>${r.ST_TO_ID}`] = fare;
      if (r.ST_FROM && r.ST_TO) byType[t].byName[`${r.ST_FROM}|${r.ST_TO}`] = fare;
    }
  }
  return {
    byType,
    byId: byType.octopus_adult.byId,
    byName: byType.octopus_adult.byName,
  };
}

function packLrt(fareRows, stopRows) {
  /** @type {Record<string, { byId: Record<string, number> }>} */
  const byType = {};
  for (const t of FARE_TYPES) byType[t] = { byId: {} };

  const idToName = {};
  const nameToId = {};
  const codeToId = {};
  for (const r of stopRows) {
    const id = String(r["Stop ID"] || r.Stop_ID || r.stop_id || "").trim();
    const en = String(r["English Name"] || r.English_Name || r.english_name || "").trim();
    const zh = String(r["Chinese Name"] || r.Chinese_Name || r.chinese_name || "").trim();
    const code = String(r["Stop Code"] || r.Stop_Code || r.stop_code || "").trim().toUpperCase();
    if (!id) continue;
    if (en) {
      idToName[id] = en;
      nameToId[en.toLowerCase()] = id;
      nameToId[en.toLowerCase().replace(/\s+/g, "")] = id;
    }
    if (zh) nameToId[zh] = id;
    if (code) codeToId[code] = id;
  }

  for (const r of fareRows) {
    const a = String(r.from_station_id || "").trim();
    const b = String(r.to_station_id || "").trim();
    if (!a || !b) continue;
    for (const t of FARE_TYPES) {
      const fare = money(r[LRT_COLS[t]]);
      if (fare == null) continue;
      byType[t].byId[`${a}>${b}`] = fare;
    }
  }
  return {
    byType,
    byId: byType.octopus_adult.byId,
    idToName,
    nameToId,
    codeToId,
  };
}

function packMtrBus(rows) {
  /** @type {Record<string, Record<string, number>>} */
  const byType = {};
  for (const t of FARE_TYPES) byType[t] = {};
  for (const r of rows) {
    const id = (r.ROUTE_ID || "").trim().toUpperCase();
    if (!id) continue;
    for (const t of FARE_TYPES) {
      const fare = money(r[BUS_COLS[t]]);
      if (fare == null) continue;
      if (byType[t][id] == null || fare < byType[t][id]) byType[t][id] = fare;
    }
  }
  return { byType, ...byType.octopus_adult };
}

/**
 * Full-journey adult fares for franchised bus / GMB / ferry from hkbus crawl.
 * Key: "co|ROUTE" lowercase co, upper route → HKD
 * Also "ROUTE" fallback when unique.
 */
function packHkBus(routeList) {
  /** @type {Record<string, number>} */
  const byCoRoute = {};
  /** @type {Record<string, number[]>} */
  const byRouteOnly = {};

  for (const [key, v] of Object.entries(routeList || {})) {
    if (!v || !Array.isArray(v.fares) || !v.fares.length) continue;
    // Full journey = board at first stop (fares[0]); section OD not packed
    let full = null;
    for (const f of v.fares) {
      const n = money(f);
      if (n != null) {
        full = n;
        break;
      }
    }
    if (full == null) continue;

    const route = String(key.split("+")[0] || "")
      .trim()
      .toUpperCase();
    if (!route) continue;
    const cos = Array.isArray(v.co) ? v.co : [];
    for (const c of cos) {
      const co = String(c || "")
        .trim()
        .toLowerCase();
      if (!co) continue;
      const k = `${co}|${route}`;
      // Prefer lower (section start) full fare when variants differ
      if (byCoRoute[k] == null || full < byCoRoute[k]) byCoRoute[k] = full;
    }
    if (!byRouteOnly[route]) byRouteOnly[route] = [];
    byRouteOnly[route].push(full);
  }

  /** Unique route short → fare only when all operators agree within $0.5 */
  /** @type {Record<string, number>} */
  const byRoute = {};
  for (const [route, list] of Object.entries(byRouteOnly)) {
    const min = Math.min(...list);
    const max = Math.max(...list);
    if (max - min <= 0.5) byRoute[route] = min;
  }

  return { byCoRoute, byRoute };
}

/**
 * Download TD Access MDB and export a table to CSV via mdb-export.
 * @param {string} mdbUrl
 * @param {string} table
 * @param {string} dir
 * @param {string} basename
 */
async function mdbToCsv(mdbUrl, table, dir, basename) {
  const mdbPath = join(dir, `${basename}.mdb`);
  const csvPath = join(dir, `${basename}.csv`);
  const buf = Buffer.from(await (await fetch(mdbUrl)).arrayBuffer());
  writeFileSync(mdbPath, buf);
  const csv = execFileSync("mdb-export", [mdbPath, table], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(csvPath, csv);
  return csvPath;
}

/**
 * TD FARE_BUS.mdb section fares → compact client index.
 * Key: "co|ROUTE" → variants[] with ordered stop names + triangular price matrix (HKD×10).
 *
 * FARE columns: ROUTE_ID, ROUTE_SEQ, ON_SEQ, OFF_SEQ, PRICE
 * @see https://static.data.gov.hk/td/routes-and-fares/FARE_BUS.mdb
 */
async function packTdBusSection() {
  let mdbExport;
  try {
    execFileSync("mdb-export", ["--version"], { stdio: "ignore" });
    mdbExport = true;
  } catch {
    mdbExport = false;
  }
  if (!mdbExport) {
    console.warn(
      "[build-fares] mdb-export not found — skip TD bus section fares (brew install mdbtools)",
    );
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "td-bus-fares-"));
  try {
    console.log("[build-fares] downloading TD FARE_BUS.mdb / ROUTE / RSTOP…");
    const [fareCsv, routeCsv, rstopCsv] = await Promise.all([
      mdbToCsv(SOURCES.tdFareBus, "FARE", dir, "fare"),
      mdbToCsv(SOURCES.tdRouteBus, "ROUTE", dir, "route"),
      mdbToCsv(SOURCES.tdRstopBus, "RSTOP", dir, "rstop"),
    ]);

    const routes = parseCsv(readFileSync(routeCsv, "utf8"));
    const rstops = parseCsv(readFileSync(rstopCsv, "utf8"));
    const fares = parseCsv(readFileSync(fareCsv, "utf8"));

    /** @type {Map<string, object>} */
    const routeById = new Map();
    for (const r of routes) {
      routeById.set(String(r.ROUTE_ID), r);
    }

    /** (rid|seq) → Map stopSeq → name */
    const stopNames = new Map();
    for (const r of rstops) {
      const key = `${r.ROUTE_ID}|${r.ROUTE_SEQ}`;
      if (!stopNames.has(key)) stopNames.set(key, new Map());
      // TD sometimes embeds <br> bilingual labels
      const nm = String(r.STOP_NAMEE || "")
        .replace(/<br\s*\/?>/gi, " / ")
        .replace(/<[^>]+>/g, "")
        .trim();
      stopNames.get(key).set(Number(r.STOP_SEQ), nm);
    }

    /** (rid|seq) → Map "on>off" → cents (×10) */
    const fareTri = new Map();
    for (const r of fares) {
      const key = `${r.ROUTE_ID}|${r.ROUTE_SEQ}`;
      if (!fareTri.has(key)) fareTri.set(key, new Map());
      const on = Number(r.ON_SEQ);
      const off = Number(r.OFF_SEQ);
      const price = money(r.PRICE);
      if (!Number.isFinite(on) || !Number.isFinite(off) || price == null) continue;
      if (off <= on) continue;
      fareTri.get(key).set(`${on}>${off}`, Math.round(price * 10));
    }

    /** @type {Record<string, Array<object>>} */
    const out = {};
    let boundCount = 0;

    for (const [boundKey, fmap] of fareTri) {
      const [rid, seq] = boundKey.split("|");
      const meta = routeById.get(rid);
      if (!meta) continue;
      const coRaw = String(meta.COMPANY_CODE || "").trim();
      const co = TD_CO_MAP[coRaw] || coRaw.toLowerCase();
      const rname = String(meta.ROUTE_NAMEE || "")
        .trim()
        .toUpperCase();
      if (!co || !rname) continue;

      const namesMap = stopNames.get(boundKey) || new Map();
      const maxSeq = Math.max(
        0,
        ...namesMap.keys(),
        ...[...fmap.keys()].flatMap((k) => k.split(">").map(Number)),
      );
      if (maxSeq < 2) continue;

      const stops = [];
      for (let i = 1; i <= maxSeq; i++) {
        stops.push(namesMap.get(i) || "");
      }

      // Triangular matrix: for on=1..n-1, off=on+1..n (1-based)
      const tri = [];
      for (let on = 1; on < maxSeq; on++) {
        for (let off = on + 1; off <= maxSeq; off++) {
          const c = fmap.get(`${on}>${off}`);
          tri.push(c != null ? c : -1);
        }
      }

      const full =
        money(meta.FULL_FARE) != null
          ? Math.round(money(meta.FULL_FARE) * 10)
          : null;
      const routeKey = `${co}|${rname}`;
      if (!out[routeKey]) out[routeKey] = [];

      // Find or create variant for this ROUTE_ID
      let variant = out[routeKey].find((v) => v.id === Number(rid));
      if (!variant) {
        variant = {
          id: Number(rid),
          full,
          start: String(meta.LOC_START_NAMEE || "").trim(),
          end: String(meta.LOC_END_NAMEE || "").trim(),
          mode: String(meta.SERVICE_MODE || "").trim(),
          b: {},
        };
        out[routeKey].push(variant);
      }
      variant.b[String(seq)] = { s: stops, t: tri };
      boundCount += 1;
    }

    console.log(
      `[build-fares] TD bus section: ${Object.keys(out).length} co|route, ${boundCount} bounds`,
    );
    return out;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Reuse the busSection already present in the output file. The TD .mdb pack
 * needs mdbtools (`mdb-export`), which the Cloudflare Pages build image does
 * not have — without this, a deploy silently overwrites the committed pack
 * with one that has no section fares at all.
 * @returns {object | null}
 */
function committedBusSection() {
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    const s = prev.busSection;
    if (s && Object.keys(s).length) return s;
  } catch {
    /* no previous file yet */
  }
  return null;
}

console.log("[build-fares] downloading…");
const [mtrText, aelText, lrtText, lrtStopsText, mtrBusText, hkbus, busSection] =
  await Promise.all([
    fetchText(SOURCES.mtr),
    fetchText(SOURCES.ael),
    fetchText(SOURCES.lrt),
    fetchText(SOURCES.lrtStops),
    fetchText(SOURCES.mtrBus),
    fetchJson(SOURCES.hkbus).catch((err) => {
      console.warn("[build-fares] hkbus fare list unavailable:", err.message);
      return { routeList: {} };
    }),
    packTdBusSection().catch((err) => {
      console.warn("[build-fares] TD bus section failed:", err.message);
      return null;
    }),
  ]);

// Keep section fares on environments without mdbtools instead of dropping them.
const busSectionFinal = busSection ?? committedBusSection();
if (busSectionFinal && !busSection) {
  console.log(
    `[build-fares] mdb-export unavailable — reused committed busSection (${Object.keys(busSectionFinal).length} keys)`,
  );
}

const mtr = packMtr(parseCsv(mtrText));
const ael = packAel(parseCsv(aelText));
const lrt = packLrt(parseCsv(lrtText), parseCsv(lrtStopsText));
const mtrBus = packMtrBus(parseCsv(mtrBusText));
const bus = packHkBus(hkbus.routeList || {});

const pack = {
  version: 4,
  currency: "HKD",
  fare_types: FARE_TYPES,
  default_fare_type: "octopus_adult",
  fare_type: "octopus_adult",
  updated_at: new Date().toISOString(),
  sources: SOURCES,
  mtr,
  ael,
  lrt,
  mtrBus,
  bus,
  /** TD section fares: co|ROUTE → variants with stop lists + triangular matrices (HKD×10) */
  busSection: busSectionFinal || undefined,
  note:
    "MTR open data multi-type. TD FARE_BUS.mdb section fares for franchised bus/GMB. hk-bus-crawling full-journey fallback + ferry. Child bus ≈ half adult when no child column.",
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(pack));
const kb = (Buffer.byteLength(JSON.stringify(pack)) / 1024).toFixed(1);
console.log(`[build-fares] wrote ${OUT} (${kb} KB)`);
console.log(
  `  mtr adult pairs=${Object.keys(mtr.byType.octopus_adult.byId).length} stations=${Object.keys(mtr.idToName).length}`,
);
console.log(`  ael pairs=${Object.keys(ael.byType.octopus_adult.byId).length}`);
console.log(
  `  lrt pairs=${Object.keys(lrt.byType.octopus_adult.byId).length} stops=${Object.keys(lrt.idToName).length}`,
);
console.log(`  mtrBus routes=${Object.keys(mtrBus.byType.octopus_adult).length}`);
console.log(
  `  bus co|route=${Object.keys(bus.byCoRoute).length} unique-route=${Object.keys(bus.byRoute).length}`,
);
console.log(
  `  busSection keys=${busSectionFinal ? Object.keys(busSectionFinal).length : 0}`,
);
