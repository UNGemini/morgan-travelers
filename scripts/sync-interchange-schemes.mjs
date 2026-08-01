#!/usr/bin/env node
/**
 * Refresh interchange scheme indexes into src/data/interchange-schemes.json
 * (+ large dumps under artifacts/).
 *
 * Citybus SPA: https://www.citybus.com.hk/concession/en/scheme
 *   GET …/concessionApi/public/bbi/api/v1/scheme/{lang}
 *   GET …/concessionApi/public/bbi/api/v1/scheme/{lang}/{packageId}
 *
 * KMB/LWB search UI: https://www.kmb.hk/interchange_bbi.html
 *   (no public package list — only a route search box)
 *   Static matrices loaded by the page:
 *     /storage/en.BBI_routeF1.js  (~12MB, first-leg forward)
 *     /storage/en.BBI_routeF2.js
 *     /storage/en.BBI_routeB1.js
 *     /storage/en.BBI_routeB2.js
 *   Optional PHP (often unused when static hit):
 *     /ajax/BBI/get_BBI2-en.php?routeno=&buscompany=&bound=F|B
 *
 * Validity symbols on KMB rows: ^ 30m · # 60m · * 90m · @ 120m · default 150m
 *
 * Usage:
 *   npm run schemes:sync
 *   node scripts/sync-interchange-schemes.mjs --detail 2          # Citybus package
 *   node scripts/sync-interchange-schemes.mjs --kmb-route 33      # one KMB first-leg dump
 *   node scripts/sync-interchange-schemes.mjs --skip-kmb
 *   node scripts/sync-interchange-schemes.mjs --skip-citybus
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCHEMES = path.join(ROOT, "src", "data", "interchange-schemes.json");
const ART = path.join(ROOT, "artifacts");
const CTB_API =
  "https://www.citybus.com.hk/concessionApi/public/bbi/api/v1/scheme";
const KMB_F1 = "https://www.kmb.hk/storage/en.BBI_routeF1.js";

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (compatible; MORGAN-Travelers-schemes-sync/0.4)",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function parseArgs(argv) {
  /** @type {{ detail: string | null, kmbRoute: string | null, skipKmb: boolean, skipCitybus: boolean }} */
  const out = {
    detail: null,
    kmbRoute: null,
    skipKmb: false,
    skipCitybus: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--detail" && argv[i + 1]) out.detail = String(argv[++i]);
    else if (argv[i] === "--kmb-route" && argv[i + 1])
      out.kmbRoute = String(argv[++i]).toUpperCase();
    else if (argv[i] === "--skip-kmb") out.skipKmb = true;
    else if (argv[i] === "--skip-citybus") out.skipCitybus = true;
  }
  return out;
}

function loadSchemes() {
  if (!fs.existsSync(SCHEMES)) return { schema: "morgan.travelers.interchange-schemes.v1" };
  return JSON.parse(fs.readFileSync(SCHEMES, "utf8"));
}

function saveSchemes(schemes) {
  schemes.updated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(SCHEMES, JSON.stringify(schemes, null, 2) + "\n");
}

async function syncCitybus(schemes, args) {
  console.log("Citybus package list…", `${CTB_API}/en`);
  const packages = await fetchJson(`${CTB_API}/en`, {
    Origin: "https://www.citybus.com.hk",
    Referer: "https://www.citybus.com.hk/concession/en/scheme",
  });
  const list = Array.isArray(packages) ? packages : packages?.data || [];
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(
    path.join(ART, "citybus-scheme-packages.json"),
    JSON.stringify(packages, null, 2) + "\n",
  );
  const index = list.map((p) => ({
    id: String(p.packageId ?? p.id ?? ""),
    title: String(p.scheme ?? p.title ?? p.name ?? "").trim(),
  }));
  if (!schemes.bus_bus) schemes.bus_bus = { enabled: false, rules: [] };
  schemes.bus_bus.citybus_packages = index;
  schemes.bus_bus.citybus_synced_at = new Date().toISOString().slice(0, 10);
  console.log(`  ${index.length} Citybus packages`);

  if (args.detail) {
    const url = `${CTB_API}/en/${encodeURIComponent(args.detail)}`;
    console.log("  package detail…", url);
    const detail = await fetchJson(url, {
      Origin: "https://www.citybus.com.hk",
      Referer: "https://www.citybus.com.hk/concession/en/scheme",
    });
    const out = path.join(ART, `citybus-pkg-${args.detail}.json`);
    fs.writeFileSync(out, JSON.stringify(detail, null, 2) + "\n");
    console.log(
      `  wrote ${out} (${Array.isArray(detail) ? detail.length : 0} pairs)`,
    );
  }
}

async function syncKmb(schemes, args) {
  console.log("KMB/LWB static F1 matrix (search-UI backend)…", KMB_F1);
  console.log("  downloading ~12MB…");
  const f1 = await fetchJson(KMB_F1, {
    Referer: "https://www.kmb.hk/interchange_bbi.html",
  });
  const routes = Object.keys(f1).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const index = routes.map((r) => ({
    route: r,
    dest: f1[r]?.bus_arr?.[0]?.dest || "",
    pairs: Array.isArray(f1[r]?.Records) ? f1[r].Records.length : 0,
  }));
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(
    path.join(ART, "kmb-bbi-route-index.json"),
    JSON.stringify(
      {
        source: KMB_F1,
        page: "https://www.kmb.hk/interchange_bbi.html",
        synced_at: new Date().toISOString().slice(0, 10),
        route_count: index.length,
        note: "F1 = first-leg forward only. Full UI also loads F2/B1/B2 (~12MB each).",
        routes: index,
      },
      null,
      2,
    ) + "\n",
  );
  if (!schemes.bus_bus) schemes.bus_bus = { enabled: false, rules: [] };
  schemes.bus_bus.kmb_route_count = index.length;
  schemes.bus_bus.kmb_synced_at = new Date().toISOString().slice(0, 10);
  schemes.bus_bus.kmb_index_artifact = "artifacts/kmb-bbi-route-index.json";
  schemes.bus_bus.kmb_note =
    "Search UI only (https://www.kmb.hk/interchange_bbi.html). Data: storage/en.BBI_route{F1,F2,B1,B2}.js. Index: artifacts/kmb-bbi-route-index.json";
  // Do not embed full route list in client JSON (keeps bundle small)
  delete schemes.bus_bus.kmb_routes;
  console.log(`  ${index.length} first-leg routes indexed → artifacts/kmb-bbi-route-index.json`);

  if (args.kmbRoute) {
    const block = f1[args.kmbRoute];
    if (!block) {
      console.warn(`  route ${args.kmbRoute} not in F1`);
    } else {
      const out = path.join(ART, `kmb-bbi-${args.kmbRoute}.json`);
      fs.writeFileSync(out, JSON.stringify(block, null, 2) + "\n");
      console.log(
        `  wrote ${out} (${block.Records?.length || 0} second-leg pairs)`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("Schemes file:", SCHEMES);
  const schemes = loadSchemes();

  if (!args.skipCitybus) {
    try {
      await syncCitybus(schemes, args);
    } catch (e) {
      console.warn("Citybus sync failed:", e?.message || e);
    }
  }

  if (!args.skipKmb) {
    try {
      await syncKmb(schemes, args);
    } catch (e) {
      console.warn("KMB sync failed:", e?.message || e);
    }
  }

  saveSchemes(schemes);
  console.log(`
Sources:
  Citybus BBI UI  https://www.citybus.com.hk/concession/en/scheme
  KMB/LWB BBI UI  https://www.kmb.hk/interchange_bbi.html  (search box only)
  MTR–PT rules    src/data/interchange-schemes.json → mtr_pt.rules (applied)
  Bus–bus         bus_bus.enabled=false until rules[] filled
`);
}

main();
