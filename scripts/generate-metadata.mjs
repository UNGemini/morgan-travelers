#!/usr/bin/env node
/**
 * Generate metadata.json for MORGAN Travelers data assets.
 *
 * Usage:
 *   node scripts/generate-metadata.mjs [artifacts-dir] [output-path] [public-base-url]
 *
 * Defaults:
 *   artifacts-dir  = ./artifacts
 *   output-path    = ./artifacts/metadata.json
 *   public-base-url = https://hk-gtfsdata.morgandev.cc
 */

import { statSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DATA_BASE =
  process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc";

const artifactsDir = resolve(process.argv[2] || "./artifacts");
const outputPath = resolve(process.argv[3] || join(artifactsDir, "metadata.json"));
const publicBase = (process.argv[4] || DATA_BASE).replace(/\/$/, "");

const ASSETS = [
  { key: "gtfs", filename: "hk.gtfs.zip" },
  { key: "pmtiles", filename: "hongkong.pmtiles" },
  { key: "wheelsrouter", filename: "hk.wheelsrouter", optional: true },
  { key: "wheelsrouter_gz", filename: "hk.wheelsrouter.gz", optional: true },
  { key: "graph", filename: "mtravelers-graph.dense", optional: true },
];

function fileSize(path) {
  if (!existsSync(path)) return null;
  return statSync(path).size;
}

const metadata = {
  updated_at: new Date().toISOString(),
};

let missingRequired = false;

for (const asset of ASSETS) {
  const path = join(artifactsDir, asset.filename);
  const size = fileSize(path);

  if (size === null) {
    if (asset.optional) {
      console.warn(`[metadata] optional asset missing: ${asset.filename}`);
      continue;
    }
    console.error(`[metadata] required asset missing: ${path}`);
    missingRequired = true;
    continue;
  }

  metadata[asset.key] = {
    filename: asset.filename,
    size_bytes: size,
    url: `${publicBase}/${asset.filename}`,
  };

  console.log(
    `[metadata] ${asset.filename}: ${size.toLocaleString()} bytes → ${metadata[asset.key].url}`,
  );
}

if (missingRequired) {
  console.error("[metadata] aborting: required artifacts not found");
  process.exit(1);
}

writeFileSync(outputPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
console.log(`[metadata] wrote ${outputPath}`);
