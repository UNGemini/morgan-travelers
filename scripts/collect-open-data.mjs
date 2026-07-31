#!/usr/bin/env node
/**
 * Download all MORGAN Travelers open-data sources that may change over time.
 *
 * Usage:
 *   node scripts/collect-open-data.mjs [output-dir]
 *
 * Default output-dir: ./artifacts/open-data
 *
 * Writes:
 *   <out>/<group>/<filename>
 *   <out>/manifest.json  — urls, sizes, sha256, http status, fetched_at
 */
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = resolve(process.argv[2] || join(ROOT, "artifacts/open-data"));

/** Sources that change (fares, TD routes, edge routing graph, etc.) */
const SOURCES = [
  // ── MTR open fare CSVs ─────────────────────────────────────────────
  {
    group: "mtr-fares",
    name: "mtr_lines_fares.csv",
    url: "https://opendata.mtr.com.hk/data/mtr_lines_fares.csv",
    required: true,
  },
  {
    group: "mtr-fares",
    name: "airport_express_fares.csv",
    url: "https://opendata.mtr.com.hk/data/airport_express_fares.csv",
    required: true,
  },
  {
    group: "mtr-fares",
    name: "light_rail_fares.csv",
    url: "https://opendata.mtr.com.hk/data/light_rail_fares.csv",
    required: true,
  },
  {
    group: "mtr-fares",
    name: "light_rail_routes_and_stops.csv",
    url: "https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv",
    required: true,
  },
  {
    group: "mtr-fares",
    name: "mtr_bus_fares.csv",
    url: "https://opendata.mtr.com.hk/data/mtr_bus_fares.csv",
    required: true,
  },

  // ── TD franchised bus section fares (FARE_BUS) ──────────────────────
  {
    group: "td-bus",
    name: "FARE_BUS.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/FARE_BUS.mdb",
    required: true,
  },
  {
    group: "td-bus",
    name: "ROUTE_BUS.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/ROUTE_BUS.mdb",
    required: true,
  },
  {
    group: "td-bus",
    name: "RSTOP_BUS.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/RSTOP_BUS.mdb",
    required: true,
  },
  {
    group: "td-bus",
    name: "STOP_BUS.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/STOP_BUS.mdb",
    required: false,
  },
  {
    group: "td-bus",
    name: "COMPANY_CODE.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/COMPANY_CODE.mdb",
    required: false,
  },

  // ── TD green minibus (separate from FARE_BUS) ──────────────────────
  {
    group: "td-gmb",
    name: "FARE_GMB.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/FARE_GMB.mdb",
    required: false,
  },
  {
    group: "td-gmb",
    name: "ROUTE_GMB.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/ROUTE_GMB.mdb",
    required: false,
  },
  {
    group: "td-gmb",
    name: "RSTOP_GMB.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/RSTOP_GMB.mdb",
    required: false,
  },
  {
    group: "td-gmb",
    name: "STOP_GMB.mdb",
    url: "https://static.data.gov.hk/td/routes-and-fares/STOP_GMB.mdb",
    required: false,
  },

  // ── Aggregated bus/ferry fares (hk-bus-crawling) ────────────────────
  {
    group: "hkbus",
    name: "routeFareList.min.json",
    url: "https://hkbus.github.io/hk-bus-crawling/routeFareList.min.json",
    required: false,
  },

  // ── Edge routing / basemap assets (published data plane) ───────────
  {
    group: "edge",
    name: "metadata.json",
    url: `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}/metadata.json`,
    required: false,
  },
  {
    group: "edge",
    name: "hk.gtfs.zip",
    url: `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}/hk.gtfs.zip`,
    required: false,
    large: true,
  },
  {
    group: "edge",
    name: "hongkong.pmtiles",
    url: `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}/hongkong.pmtiles`,
    required: false,
    large: true,
  },
  {
    group: "edge",
    name: "hk.wheelsrouter",
    url: `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}/hk.wheelsrouter`,
    required: false,
    large: true,
  },
  {
    group: "edge",
    name: "hk.wheelsrouter.gz",
    url: `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}/hk.wheelsrouter.gz`,
    required: false,
    large: true,
  },
];

const SKIP_LARGE = process.env.COLLECT_SKIP_LARGE === "1";

async function downloadOne(src) {
  const dir = join(OUT, src.group);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, src.name);
  const started = Date.now();

  const entry = {
    group: src.group,
    name: src.name,
    url: src.url,
    required: !!src.required,
    large: !!src.large,
    ok: false,
    status: null,
    bytes: null,
    sha256: null,
    path: dest.replace(ROOT + "/", ""),
    error: null,
    ms: null,
  };

  if (src.large && SKIP_LARGE) {
    entry.error = "skipped (COLLECT_SKIP_LARGE=1)";
    console.log(`[skip large] ${src.group}/${src.name}`);
    return entry;
  }

  try {
    console.log(`[get] ${src.group}/${src.name}`);
    const res = await fetch(src.url, {
      headers: {
        "User-Agent": "MORGAN-Travelers/0.4 (collect-open-data)",
        Accept: "*/*",
      },
      redirect: "follow",
    });
    entry.status = res.status;
    if (!res.ok) {
      entry.error = `HTTP ${res.status}`;
      console.warn(`  FAIL ${entry.error}`);
      return entry;
    }

    const hash = createHash("sha256");
    // Prefer streaming when body is a web stream
    if (res.body) {
      const nodeStream = Readable.fromWeb(res.body);
      nodeStream.on("data", (chunk) => hash.update(chunk));
      await pipeline(nodeStream, createWriteStream(dest));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      hash.update(buf);
      writeFileSync(dest, buf);
    }

    const st = statSync(dest);
    entry.bytes = st.size;
    entry.sha256 = hash.digest("hex");
    entry.ok = true;
    entry.ms = Date.now() - started;
    console.log(
      `  OK ${entry.bytes.toLocaleString()} bytes  sha256=${entry.sha256.slice(0, 12)}…  ${entry.ms}ms`,
    );
  } catch (err) {
    entry.error = err?.message || String(err);
    console.warn(`  ERR ${entry.error}`);
  }
  return entry;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`[collect-open-data] → ${OUT}`);
  console.log(`[collect-open-data] skip large = ${SKIP_LARGE}`);

  const results = [];
  // Sequential for large files to avoid memory spikes; small ones could parallelize
  for (const src of SOURCES) {
    results.push(await downloadOne(src));
  }

  const failedRequired = results.filter((r) => r.required && !r.ok);
  const manifest = {
    collected_at: new Date().toISOString(),
    data_public_base_url:
      process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc",
    skip_large: SKIP_LARGE,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok && !String(r.error || "").includes("skipped"))
        .length,
      skipped: results.filter((r) => String(r.error || "").includes("skipped"))
        .length,
      bytes: results.reduce((s, r) => s + (r.bytes || 0), 0),
    },
    sources: results,
  };

  const manifestPath = join(OUT, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[collect-open-data] wrote ${manifestPath}`);
  console.log(
    `[collect-open-data] summary: ${manifest.summary.ok}/${manifest.summary.total} ok, ${(manifest.summary.bytes / 1024 / 1024).toFixed(1)} MB`,
  );

  if (failedRequired.length) {
    console.error(
      "[collect-open-data] required sources failed:",
      failedRequired.map((r) => r.name).join(", "),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
