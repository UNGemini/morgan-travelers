#!/usr/bin/env node
/**
 * Pull published bus-shapes.json from the overrides GitHub repo into
 * public/overrides/bus-shapes.json (for offline / deploy bundling).
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

const out = path.join(root, "public", "overrides", "bus-shapes.json");

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
fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
console.info(
  "Wrote",
  out,
  "·",
  data.routes.length,
  "routes · from",
  url,
);
