#!/usr/bin/env node
/**
 * Project-owned validation route — mechanical pass/fail signal before review.
 *
 * 1. Syntax-checks every JS/MJS/CJS file under functions/, scripts/, and src/
 *    (node --check). TypeScript is compiled by the Vite build below.
 * 2. Runs the production build (npm run build) as the final gate.
 *
 * Exit code 0 = pass. Any failure exits nonzero so CI/review can gate on it.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_DIRS = ["functions", "scripts", "src"];
const JS_EXTS = new Set([".js", ".mjs", ".cjs"]);

/** Recursively collect JS files under a directory. */
function collectJsFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      collectJsFiles(full, files);
    } else if (JS_EXTS.has(path.extname(name))) {
      files.push(full);
    }
  }
  return files;
}

const files = CHECK_DIRS.flatMap((dir) => collectJsFiles(path.join(ROOT, dir)));
let failed = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`[check] FAIL ${rel}\n${String(result.stderr ?? "").trim()}`);
  }
}

if (failed > 0) {
  console.error(`[check] ${failed}/${files.length} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`[check] syntax ok (${files.length} files)`);

const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
process.exit(build.status ?? 1);
