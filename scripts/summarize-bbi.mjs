#!/usr/bin/env node
/**
 * Offline summarizer for operator BBI dumps → compact pair discounts.
 *
 * KMB/LWB (search UI backends, ~50MB raw):
 *   artifacts/bbi/en.BBI_route{F1,F2,B1,B2}.js
 *   or download from https://www.kmb.hk/storage/…
 *
 * Citybus (optional, many packages):
 *   artifacts/citybus-scheme-packages.json + artifacts/citybus-pkg-*.json
 *
 * Output:
 *   artifacts/bbi/kmb-bbi-summary.json     human-readable stats
 *   public/fares/bbi-compact.json          compact pair map for the app
 *   updates bus_bus meta in interchange-schemes.json
 *
 * Usage:
 *   node scripts/summarize-bbi.mjs
 *   node scripts/summarize-bbi.mjs --download   # fetch KMB files first
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BBI_DIR = path.join(ROOT, "artifacts", "bbi");
const SCHEMES = path.join(ROOT, "src", "data", "interchange-schemes.json");
const COMPACT_OUT = path.join(ROOT, "public", "fares", "bbi-compact.json");
const SUMMARY_OUT = path.join(BBI_DIR, "kmb-bbi-summary.json");

const KMB_FILES = [
  { file: "en.BBI_routeF1.js", url: "https://www.kmb.hk/storage/en.BBI_routeF1.js", leg: "F1" },
  { file: "en.BBI_routeF2.js", url: "https://www.kmb.hk/storage/en.BBI_routeF2.js", leg: "F2" },
  { file: "en.BBI_routeB1.js", url: "https://www.kmb.hk/storage/en.BBI_routeB1.js", leg: "B1" },
  { file: "en.BBI_routeB2.js", url: "https://www.kmb.hk/storage/en.BBI_routeB2.js", leg: "B2" },
];

const WIN = { "^": 30, "#": 60, "*": 90, "@": 120, "": 150, "!": 150 };

function parseDiscount(text) {
  const s = String(text || "");
  // "Discount $4.2" / "Discount $1.0 / $0.5" → take max number
  const nums = [...s.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  return Math.max(...nums);
}

function normRoute(r) {
  return String(r || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isMtrLabel(sec) {
  return /^MTR\b/i.test(String(sec || "").trim());
}

async function downloadKmb() {
  fs.mkdirSync(BBI_DIR, { recursive: true });
  for (const { file, url } of KMB_FILES) {
    const dest = path.join(BBI_DIR, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
      console.log("have", file, fs.statSync(dest).size);
      continue;
    }
    console.log("download", url);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MORGAN-Travelers-bbi-summary/0.4)",
        Referer: "https://www.kmb.hk/interchange_bbi.html",
        Accept: "application/json,*/*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log("  wrote", dest, buf.length);
  }
}

/**
 * @param {Map<string, number>} pairMax  key "FROM>TO" → max HKD save
 * @param {object} stats
 */
function ingestKmbFile(filePath, leg, pairMax, stats) {
  const j = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const routes = Object.keys(j);
  stats.files[leg] = {
    first_legs: routes.length,
    raw_pairs: 0,
    with_discount: 0,
    mtr_rows: 0,
  };
  for (const fromRaw of routes) {
    const from = normRoute(fromRaw);
    if (!from) continue;
    const block = j[fromRaw];
    const recs = Array.isArray(block?.Records) ? block.Records : [];
    stats.files[leg].raw_pairs += recs.length;
    for (const rec of recs) {
      const toRaw = rec.sec_routeno;
      if (isMtrLabel(toRaw)) {
        stats.files[leg].mtr_rows += 1;
        continue; // MTR rail rows handled via mtr_pt
      }
      const to = normRoute(toRaw);
      if (!to || to === from) continue;
      const save = parseDiscount(rec.discount_max);
      if (save == null || save <= 0) continue;
      stats.files[leg].with_discount += 1;
      const key = `${from}>${to}`;
      const prev = pairMax.get(key) || 0;
      if (save > prev) pairMax.set(key, Math.round(save * 10) / 10);

      // also track undirected max for summary
      const u =
        from < to ? `${from}|${to}` : `${to}|${from}`;
      const up = stats.undirectedMax.get(u) || 0;
      if (save > up) stats.undirectedMax.set(u, Math.round(save * 10) / 10);

      const win = WIN[String(rec.validity || "").trim()] ?? 150;
      if (win < (stats.minWin.get(key) ?? 9999)) stats.minWin.set(key, win);
    }
  }
}

function hist(values) {
  /** @type {Record<string, number>} */
  const h = {};
  for (const v of values) {
    const k = v.toFixed(1);
    h[k] = (h[k] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(h).sort((a, b) => Number(a[0]) - Number(b[0])),
  );
}

function summarizeCitybus(pairMax, stats) {
  const pkgListPath = path.join(ROOT, "artifacts", "citybus-scheme-packages.json");
  if (!fs.existsSync(pkgListPath)) {
    stats.citybus = { note: "no package list; run schemes:sync first" };
    return;
  }
  const packages = JSON.parse(fs.readFileSync(pkgListPath, "utf8"));
  const list = Array.isArray(packages) ? packages : packages.data || [];
  let files = 0;
  let pairs = 0;
  for (const p of list) {
    const id = p.packageId ?? p.id;
    const f = path.join(ROOT, "artifacts", `citybus-pkg-${id}.json`);
    if (!fs.existsSync(f)) continue;
    files += 1;
    const rows = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      pairs += 1;
      const from = normRoute(row.firstRoute);
      const to = normRoute(row.secondRoute);
      if (!from || !to) continue;
      // discountAmount may be { adult: 1.0 } or nested
      let save = null;
      const da = row.discountAmount;
      if (da && typeof da === "object") {
        const a = da.adult ?? da.Adult ?? da.ADULT;
        if (a != null) save = Number(a);
      }
      if (save == null) save = parseDiscount(row.discount);
      if (save == null || !(save > 0)) continue;
      // Citybus often uses "L2" free-second-leg style — skip non-numeric
      if (!Number.isFinite(save)) continue;
      const key = `${from}>${to}`;
      const prev = pairMax.get(key) || 0;
      // tag company slightly higher priority? keep max across operators
      if (save > prev) pairMax.set(key, Math.round(save * 10) / 10);
    }
  }
  stats.citybus = {
    packages_listed: list.length,
    packages_loaded: files,
    rows_seen: pairs,
    note:
      files === 0
        ? "No citybus-pkg-*.json dumps — only package list. Use schemes:sync --detail <id> per package or a bulk dump later."
        : "Merged numeric adult discounts from dumped packages",
  };
}

async function main() {
  const download = process.argv.includes("--download");
  if (download) await downloadKmb();

  fs.mkdirSync(BBI_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "public", "fares"), { recursive: true });

  /** @type {Map<string, number>} */
  const pairMax = new Map();
  const stats = {
    generated_at: new Date().toISOString(),
    files: {},
    undirectedMax: new Map(),
    minWin: new Map(),
  };

  for (const { file, leg } of KMB_FILES) {
    const fp = path.join(BBI_DIR, file);
    if (!fs.existsSync(fp)) {
      console.warn("missing", fp, "— run with --download");
      continue;
    }
    console.log("ingest", file);
    ingestKmbFile(fp, leg, pairMax, stats);
  }

  summarizeCitybus(pairMax, stats);

  const saves = [...pairMax.values()];
  const undirected = [...stats.undirectedMax.entries()]
    .map(([k, v]) => ({ pair: k, save: v }))
    .sort((a, b) => b.save - a.save);

  const topPairs = [...pairMax.entries()]
    .map(([k, v]) => {
      const [from, to] = k.split(">");
      return { from, to, save: v, window_min: stats.minWin.get(k) ?? 150 };
    })
    .sort((a, b) => b.save - a.save)
    .slice(0, 40);

  // Compact: ordered pairs as object (smaller than array of objects)
  /** @type {Record<string, number>} */
  const pairsObj = {};
  for (const [k, v] of pairMax) pairsObj[k] = v;

  const compact = {
    schema: "morgan.travelers.bbi-compact.v1",
    updated_at: new Date().toISOString().slice(0, 10),
    sources: [
      "https://www.kmb.hk/interchange_bbi.html",
      "https://www.kmb.hk/storage/en.BBI_routeF1.js",
      "https://www.citybus.com.hk/concession/en/scheme",
    ],
    note: "Max HKD discount per ordered first>second bus route (Octopus/e-pay BBI). MTR rows excluded. Same-itinerary model only.",
    pair_count: pairMax.size,
    // cos hint for client: treat unknown as kmb/lwb/ctb
    pairs: pairsObj,
  };

  fs.writeFileSync(COMPACT_OUT, JSON.stringify(compact) + "\n");
  const compactBytes = fs.statSync(COMPACT_OUT).size;

  const summary = {
    generated_at: stats.generated_at,
    kmb_files: stats.files,
    citybus: stats.citybus,
    ordered_pairs: pairMax.size,
    undirected_pairs: stats.undirectedMax.size,
    discount_histogram: hist(saves),
    max_discount: saves.length ? Math.max(...saves) : 0,
    min_discount: saves.length ? Math.min(...saves) : 0,
    top_pairs: topPairs,
    top_undirected: undirected.slice(0, 30),
    compact_path: "public/fares/bbi-compact.json",
    compact_bytes: compactBytes,
  };
  // Maps not JSON-serializable
  fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2) + "\n");

  // Touch schemes meta
  if (fs.existsSync(SCHEMES)) {
    const schemes = JSON.parse(fs.readFileSync(SCHEMES, "utf8"));
    if (!schemes.bus_bus) schemes.bus_bus = {};
    schemes.bus_bus.compact_file = "fares/bbi-compact.json";
    schemes.bus_bus.compact_pairs = pairMax.size;
    schemes.bus_bus.compact_bytes = compactBytes;
    schemes.bus_bus.compact_updated_at = compact.updated_at;
    schemes.bus_bus.enabled = true; // enable lookup via compact file
    schemes.bus_bus.note =
      "BBI discounts from offline summarize-bbi.mjs (KMB/LWB static JSON + optional Citybus dumps). Applied when consecutive bus legs match pairs in public/fares/bbi-compact.json.";
    schemes.updated_at = compact.updated_at;
    fs.writeFileSync(SCHEMES, JSON.stringify(schemes, null, 2) + "\n");
  }

  console.log("\n=== BBI offline summary ===");
  console.log("Ordered pairs:", pairMax.size);
  console.log("Undirected pairs:", stats.undirectedMax.size);
  console.log("Discount hist:", summary.discount_histogram);
  console.log("Top 10:");
  for (const p of topPairs.slice(0, 10)) {
    console.log(`  ${p.from} → ${p.to}  −$${p.save}  (${p.window_min}m)`);
  }
  console.log("Compact:", COMPACT_OUT, `(${(compactBytes / 1024).toFixed(0)} KB)`);
  console.log("Summary:", SUMMARY_OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
