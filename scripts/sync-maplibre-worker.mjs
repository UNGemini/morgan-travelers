#!/usr/bin/env node
/**
 * MapLibre GL v6 ships a separate module worker + shared chunk.
 * Vite's dep prebundle rewrites import.meta.url so the worker resolves to
 * /.vite/deps/maplibre-gl-worker.mjs (missing → HTML SPA fallback → blank map).
 * Copy the real worker pair into public/ for a stable same-origin URL.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules", "maplibre-gl", "dist");
const out = join(root, "public", "maplibre");

const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

if (!existsSync(join(dist, "maplibre-gl-worker.mjs"))) {
  console.warn("[sync-maplibre-worker] maplibre-gl not installed — skip");
  process.exit(0);
}

mkdirSync(out, { recursive: true });
for (const f of files) {
  copyFileSync(join(dist, f), join(out, f));
  console.log(`[sync-maplibre-worker] ${f}`);
}
