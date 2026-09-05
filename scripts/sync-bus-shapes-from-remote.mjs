#!/usr/bin/env node
/**
 * Pull published bus-shapes.json from the overrides GitHub repo and
 * split into public/overrides/bus-shapes/<id>.json (offline bundle).
 *
 * Usage:
 *   OVERRIDES_BUS_SHAPES_URL=https://raw.githubusercontent.com/…/main/bus-shapes.json \
 *     node scripts/sync-bus-shapes-from-remote.mjs
 *
 * Or set VITE_OVERRIDES_BUS_SHAPES_URL in .env (loaded if present as plain KEY=val).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncPublicBusShapes } from "./bus-shapes-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1];
    let v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const url =
  process.env.OVERRIDES_BUS_SHAPES_URL ||
  process.env.VITE_OVERRIDES_BUS_SHAPES_URL ||
  "https://raw.githubusercontent.com/UNGemini/morgan-travelers-overrides/main/bus-shapes.json";

const res = await fetch(url, { headers: { Accept: "application/json" } });
if (!res.ok) {
  console.error("Fetch failed", res.status, url);
  process.exit(1);
}
const data = await res.json();
if (!Array.isArray(data?.routes)) {
  console.error("Invalid bus-shapes.json (no routes array)");
  process.exit(1);
}
const index = syncPublicBusShapes(data);
console.info(
  "Wrote",
  index.files.length,
  "route files under public/overrides/bus-shapes/ · from",
  url,
);
