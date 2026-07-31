#!/usr/bin/env node
/**
 * CLI helpers for local overrides testing (no dev server required for merge).
 *
 *   npm run overrides:status
 *   npm run overrides:pending
 *   npm run overrides:merge -- pending/foo.json
 *   npm run overrides:help
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");

function overridesRoot() {
  if (process.env.OVERRIDES_REPO_PATH && fs.existsSync(process.env.OVERRIDES_REPO_PATH)) {
    return path.resolve(process.env.OVERRIDES_REPO_PATH);
  }
  const sibling = path.join(appRoot, "..", "morgan-travelers-overrides");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

const cmd = process.argv[2] || "help";
const root = overridesRoot();

if (cmd === "help") {
  console.log(`
Local overrides testing
=======================

  npm run dev                    # Vite + /api/overrides/*
  npm run overrides:status       # paths + route count
  npm run overrides:pending      # list pending/*.json
  npm run overrides:merge -- pending/<id>.json

  curl http://127.0.0.1:5173/api/overrides/status
  curl -X POST http://127.0.0.1:5173/api/overrides/merge \\
    -H 'Content-Type: application/json' \\
    -d '{"file":"pending/<id>.json"}'

Docs: docs/local-overrides.md
Repo: ${root || "(sibling morgan-travelers-overrides not found)"}
`);
  process.exit(0);
}

if (!root) {
  console.error(
    "Overrides repo not found. Clone to ../morgan-travelers-overrides or set OVERRIDES_REPO_PATH",
  );
  process.exit(1);
}

const shapes = path.join(root, "bus-shapes.json");
const pendingDir = path.join(root, "pending");
const mergeScript = path.join(root, "scripts", "merge-pending.mjs");
const publicShapes = path.join(appRoot, "public", "overrides", "bus-shapes.json");

if (cmd === "status") {
  let n = 0;
  let updated = "";
  if (fs.existsSync(shapes)) {
    const j = JSON.parse(fs.readFileSync(shapes, "utf8"));
    n = j.routes?.length || 0;
    updated = j.updated_at || "";
  }
  const pending = fs.existsSync(pendingDir)
    ? fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"))
    : [];
  console.log(
    JSON.stringify(
      {
        overrides_repo: root,
        bus_shapes: shapes,
        published_routes: n,
        updated_at: updated,
        pending,
        public_bundle: publicShapes,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (cmd === "pending") {
  const files = fs.existsSync(pendingDir)
    ? fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"))
    : [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8"));
    console.log(
      `${f}\t${j.agency || "?"} ${j.route_short_name || "?"} pts=${(j.coordinates || []).length} ${j.status || ""}`,
    );
  }
  if (!files.length) console.log("(no pending json files)");
  process.exit(0);
}

if (cmd === "merge") {
  const file = process.argv[3];
  if (!file) {
    console.error("Usage: npm run overrides:merge -- pending/<id>.json");
    process.exit(1);
  }
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(abs)) {
    console.error("Not found:", abs);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [mergeScript, abs, ...process.argv.slice(4)], {
    encoding: "utf8",
    cwd: root,
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status === 0 && fs.existsSync(shapes)) {
    fs.copyFileSync(shapes, publicShapes);
    console.log("Synced →", publicShapes);
  }
  process.exit(r.status ?? 1);
}

console.error("Unknown command:", cmd, "— try: help | status | pending | merge");
process.exit(1);
