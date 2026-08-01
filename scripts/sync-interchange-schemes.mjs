#!/usr/bin/env node
/**
 * Refresh Citybus BBI package index into src/data/interchange-schemes.json
 * (and optional full package dumps under artifacts/).
 *
 * Citybus SPA: https://www.citybus.com.hk/concession/en/scheme
 * API list:    GET …/concessionApi/public/bbi/api/v1/scheme/{lang}
 * API detail:  GET …/concessionApi/public/bbi/api/v1/scheme/{lang}/{packageId}
 *
 * Pair matrices are large (100–200KB+ per package). This script only stores the
 * package index in interchange-schemes.json. Set bus_bus.enabled + rules[] by hand
 * (or extend this script) when you want live BBI estimates.
 *
 * Usage:
 *   npm run schemes:sync
 *   node scripts/sync-interchange-schemes.mjs --detail 2   # dump one package JSON
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCHEMES = path.join(ROOT, "src", "data", "interchange-schemes.json");
const ART = path.join(ROOT, "artifacts");
const API = "https://www.citybus.com.hk/concessionApi/public/bbi/api/v1/scheme";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (compatible; MORGAN-Travelers-schemes-sync/0.4)",
      Origin: "https://www.citybus.com.hk",
      Referer: "https://www.citybus.com.hk/concession/en/scheme",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function parseArgs(argv) {
  /** @type {{ detail: string | null }} */
  const out = { detail: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--detail" && argv[i + 1]) {
      out.detail = String(argv[++i]);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log("Schemes file:", SCHEMES);

  let schemes = {};
  if (fs.existsSync(SCHEMES)) {
    schemes = JSON.parse(fs.readFileSync(SCHEMES, "utf8"));
  }

  console.log("Fetching Citybus package list…", `${API}/en`);
  try {
    const packages = await fetchJson(`${API}/en`);
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

    if (!schemes.bus_bus) schemes.bus_bus = {};
    schemes.bus_bus.citybus_packages = index;
    schemes.bus_bus.citybus_synced_at = new Date().toISOString().slice(0, 10);
    schemes.updated_at = schemes.bus_bus.citybus_synced_at;
    if (!Array.isArray(schemes.bus_bus.rules)) schemes.bus_bus.rules = [];

    fs.writeFileSync(SCHEMES, JSON.stringify(schemes, null, 2) + "\n");
    console.log(
      `Updated schemes: bus_bus.citybus_packages = ${index.length} packages`,
    );
    console.log(
      `mtr_pt rules: ${schemes.mtr_pt?.rules?.length ?? 0} (unchanged by sync)`,
    );

    if (args.detail) {
      const url = `${API}/en/${encodeURIComponent(args.detail)}`;
      console.log("Fetching package detail…", url);
      const detail = await fetchJson(url);
      const out = path.join(ART, `citybus-pkg-${args.detail}.json`);
      fs.writeFileSync(out, JSON.stringify(detail, null, 2) + "\n");
      const n = Array.isArray(detail) ? detail.length : 0;
      console.log(`Wrote ${out} (${n} pairs)`);
      if (n && Array.isArray(detail)) {
        const sample = detail[0];
        console.log("Sample pair keys:", Object.keys(sample).join(", "));
        console.log(
          "  first",
          sample.firstRoute?.trim?.(),
          "→ second",
          sample.secondRoute?.trim?.(),
          "discount",
          sample.discount,
          sample.discountAmount,
        );
      }
    }

    console.log(`
Citybus UI: https://www.citybus.com.hk/concession/en/scheme
MTR–Citybus (in mtr_pt): railway_e_txt + MTR intermodal page
Edit discounts: ${SCHEMES}
`);
  } catch (e) {
    console.warn("Citybus API not reachable:", e?.message || e);
    console.warn("Keep editing mtr_pt.rules in interchange-schemes.json by hand.");
    process.exitCode = 0;
  }
}

main();
