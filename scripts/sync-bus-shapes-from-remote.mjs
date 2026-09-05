#!/usr/bin/env node
/**
 * Pull published bus-shape overrides from the overrides GitHub repo and
 * split into public/overrides/bus-shapes/<id>.json (offline bundle).
 *
 * Prefers the split store (bus-shapes/index.json + per-route files) and
 * falls back to the legacy assembled bus-shapes.json blob.
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

/** @param {string} u */
async function fetchJson(u) {
  const res = await fetch(u, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
  return res.json();
}

/** Derive the sibling bus-shapes/index.json URL from a blob URL. */
function splitIndexUrl(u) {
  if (/index\.json(\?|$)/.test(u)) return u;
  if (/bus-shapes\.json(\?|$)/.test(u)) {
    return u.replace(/bus-shapes\.json.*$/, "bus-shapes/index.json");
  }
  return null;
}

/** @param {string} indexUrl @returns {Promise<{updated_at: string, note: string, routes: object[]} | null>} */
async function fetchSplit(indexUrl) {
  const index = await fetchJson(indexUrl);
  const files = Array.isArray(index?.files) ? index.files : [];
  if (!files.length) return null;
  const base = indexUrl.replace(/index\.json.*$/, "");
  const routes = [];
  for (const f of files) {
    try {
      const rec = await fetchJson(base + String(f).replace(/^.*\//, ""));
      if (rec && typeof rec === "object" && Array.isArray(rec.coordinates)) {
        routes.push(rec);
      }
    } catch {
      /* skip missing/bad route file */
    }
  }
  if (!routes.length) return null;
  return {
    updated_at: index.updated_at || "",
    note: index.note || "",
    routes,
  };
}

let data = null;
let source = url;

const idxUrl = splitIndexUrl(url);
if (idxUrl) {
  try {
    data = await fetchSplit(idxUrl);
    if (data) source = idxUrl;
  } catch (e) {
    console.warn("Split store unavailable, falling back to blob:", e?.message || e);
  }
}

if (!data) {
  try {
    const blob = await fetchJson(url);
    if (!Array.isArray(blob?.routes)) {
      console.error("Invalid bus-shapes.json (no routes array)");
      process.exit(1);
    }
    data = blob;
  } catch (e) {
    console.error("Fetch failed", e?.message || e);
    process.exit(1);
  }
}

const index = syncPublicBusShapes(data);
console.info(
  "Wrote",
  index.files.length,
  "route files under public/overrides/bus-shapes/ · from",
  source,
);
