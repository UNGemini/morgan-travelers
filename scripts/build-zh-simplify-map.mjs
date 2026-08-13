/**
 * Build the Traditional → Simplified character map used for zh-cn station
 * names at runtime. Sources: MTR station names, LRT stop names, MTR Bus CSV
 * Chinese column, and the zh dictionaries themselves (so UI strings
 * simplify correctly too). Only characters that actually differ are emitted.
 *
 * Output: public/data/zh-simplify-map.json (committed artifact; runtime loads
 * it lazily). Unknown characters pass through unchanged at runtime.
 *
 * Usage: node scripts/build-zh-simplify-map.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Converter } from "opencc-js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Unique CJK characters from a string (Traditional first-pass extraction). */
function uniqueChars(texts) {
  const set = new Set();
  for (const t of texts) {
    for (const ch of String(t || "")) {
      if (/[\u3400-\u9fff]/.test(ch)) set.add(ch);
    }
  }
  return [...set];
}

function load(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ── MTR stations (src/mtrStations.js: name_zh strings) ──
const mtrStations = load(`${root}src/mtrStations.js`);
const mtrZh = [...mtrStations.matchAll(/name_zh:\s*"([^"]+)"/g)].map((m) => m[1]);

// ── LRT stops (src/lrtStops.js: name_zh strings) ──
const lrtStops = load(`${root}src/lrtStops.js`);
const lrtZh = [...lrtStops.matchAll(/name_zh:\s*"([^"]+)"/g)].map((m) => m[1]);

// ── MTR Bus CSV Chinese column (STATION_NAME_CHI) ──
const mtrBusCsv = load(`${root}public/data/mtr_bus_stops.csv`);
const mtrBusZh = [];
for (const line of mtrBusCsv.split("\n").slice(1)) {
  const cols = line.split(",");
  if (cols.length > 4 && /[\u3400-\u9fff]/.test(cols[3])) mtrBusZh.push(cols[3]);
}

// ── zh dictionaries (zh-hk / zh-tw values are Traditional) ──
const dictTexts = [];
for (const f of ["zh-hk.js", "zh-tw.js"]) {
  const src = load(`${root}src/i18n/${f}`);
  for (const m of src.matchAll(/:\s*"([^"]*)"/g)) dictTexts.push(m[1]);
}

const t2s = Converter({ from: "tw", to: "cn" });
const chars = uniqueChars([...mtrZh, ...lrtZh, ...mtrBusZh, ...dictTexts]);
const map = {};
for (const ch of chars) {
  const converted = t2s(ch);
  if (converted && converted !== ch) map[ch] = converted;
}

const out = `${root}public/data/zh-simplify-map.json`;
writeFileSync(out, JSON.stringify(map));
console.log(
  `zh-simplify-map: ${Object.keys(map).length} chars (from ${chars.length} unique) → ${out}`,
);
