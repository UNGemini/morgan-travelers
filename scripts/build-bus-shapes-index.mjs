/**
 * Build a compact per-agency bus shape index from the published GTFS.
 *
 * Source: hk.gtfs.zip on the edge data plane (DATA_PUBLIC_BASE_URL).
 * Output: public/data/bus-shapes/ (index.json + one compact JSON per agency).
 *
 * Why: the WASM routing graph drops geometry, so bus legs were previously
 * densified with OSRM (car profile) — which misses bus-only terminal roads,
 * snaps terminal stops to the wrong adjacent terminal, or picks a parallel
 * wrong road. The GTFS shapes.txt contains the real operator polylines
 * (incl. terminal loops) and is served lazily to the frontend instead.
 *
 * Encoding (keeps the index small enough to commit + lazy-fetch):
 *   coordinates → flat int array: [lon0e5, lat0e5, dLon1, dLat1, ...]
 *   (absolute first point at 1e-5 deg ≈ 1.1 m, then integer deltas).
 *   stop sequences → per-route st { dir: [stopIndex, ...] } into the shared
 *   stops.json directory (s: [[id, lonE5, latE5, nameIdx], ...], n: names).
 *   Sequences use the longest trip per (route, direction); KMB/CTB/NLB/GMB
 *   are shipped, others (MTR, LR, MTRB) keep their own local data.
 *
 * Usage:
 *   node scripts/build-bus-shapes-index.mjs            # download + build
 *   node scripts/build-bus-shapes-index.mjs --zip out/hk.gtfs.zip
 * Env: DATA_PUBLIC_BASE_URL (default https://hk-gtfsdata.morgandev.cc)
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data", "bus-shapes");
const DEFAULT_URL =
  `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}` +
  "/hk.gtfs.zip";
const TMP_ZIP = join(ROOT, "artifacts", "bus-shapes", "hk.gtfs.zip");

/** Max entries kept per (route, direction) — branching variants */
const MAX_SHAPES_PER_DIR = 3;
/**
 * Safety cap for one shape's point count AFTER decimation. Long trunk routes
 * (cross-harbour / airport) exceed the old 20k cap and were dropped whole,
 * losing exactly the popular routes. At 3 m decimation a 45 km route stays
 * under 20k points, so 100k only catches pathological traces.
 */
const MAX_POINTS_PER_SHAPE = 100_000;
/**
 * Streamed decimation spacing in metres — feed shapes are 1-2 m dense.
 * Skipping points < 3 m apart bounds memory; the 6 m Douglas-Peucker pass
 * downstream is unaffected for display geometry.
 */
const DECIMATE_EPS_M = Number(process.env.SHAPE_DECIMATE_M || 3);
/** 1e-5 deg ≈ 1.1 m — plenty for display geometry */
const SCALE = 1e5;
/** Douglas-Peucker tolerance in metres (feed shapes are 2-3 m dense) */
const SIMPLIFY_M = Number(process.env.SHAPE_SIMPLIFY_M || 6);
/** Agencies whose stop sequences we ship (others have local CSVs/static). */
const STOP_AGENCIES = new Set(["kmb", "ctb", "nlb", "gmb"]);

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const zipArg = args.find((a) => a.startsWith("--zip="))?.slice(6);
const outArg = args.find((a) => a.startsWith("--out="))?.slice(6);
const stopsZhOnly = args.includes("--stops-zh");
const zipPath = zipArg || (existsSync(TMP_ZIP) ? TMP_ZIP : null);
const outDir = outArg || OUT_DIR;

// ── helpers ─────────────────────────────────────────────────────────────────

function checkUnzip() {
  const r = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(
      "[bus-shapes] `unzip` not found — install it (macOS: bundled; CI: apt-get install unzip)",
    );
    process.exit(1);
  }
}

/** Minimal GTFS CSV row parser (handles quoted fields + CRLF). */
async function* csvRows(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const row = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else cur += ch;
    }
    row.push(cur);
    yield row;
  }
}

/** Stream one table out of the zip as parsed rows. */
async function* zipCsvRows(zipPath, member) {
  const child = spawn("unzip", ["-p", zipPath, member], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    yield* csvRows(child.stdout);
  } finally {
    child.kill();
  }
}

/**
 * zh-Hant stop_name translations from GTFS translations.txt.
 * @param {string} zip
 * @returns {Promise<Map<string, string>>} stop_id → Traditional Chinese name
 */
async function loadZhStopNames(zip) {
  /** @type {Map<string, string>} */
  const zh = new Map();
  let head = true;
  let iTable = 0;
  let iField = 1;
  let iLang = 2;
  let iRec = 3;
  let iText = 4;
  try {
    for await (const row of zipCsvRows(zip, "translations.txt")) {
      if (head) {
        head = false;
        const lower = row.map((c) => String(c || "").trim().toLowerCase());
        iTable = Math.max(0, lower.indexOf("table_name"));
        iField = Math.max(1, lower.indexOf("field_name"));
        iLang = Math.max(2, lower.indexOf("language"));
        iRec = Math.max(3, lower.indexOf("record_id"));
        iText = Math.max(4, lower.indexOf("translation"));
        continue;
      }
      if (row[iTable] !== "stops.txt" || row[iField] !== "stop_name") continue;
      const lang = String(row[iLang] || "");
      if (lang !== "zh-Hant" && lang !== "zh" && lang !== "zh-HK") continue;
      const id = String(row[iRec] || "").trim();
      const text = String(row[iText] || "").trim();
      if (id && text) zh.set(id, text);
    }
  } catch (e) {
    console.warn("[bus-shapes] translations.txt", e?.message || e);
  }
  console.log(`[bus-shapes] zh-Hant stop names: ${zh.size}`);
  return zh;
}

/**
 * Pack English + Chinese name tables onto stop rows.
 * s: [id, lonE5, latE5, enIdx, zhIdx]
 * @param {string[]} ids
 * @param {Map<string, { name?: string }>} meta
 * @param {Map<string, string>} zhById
 */
function packStopNames(ids, meta, zhById) {
  const nameIndex = new Map();
  const names = [];
  const zhIndex = new Map();
  const zNames = [];
  const indexOf = (table, map, value) => {
    const key = value || "";
    let idx = map.get(key);
    if (idx === undefined) {
      idx = table.length;
      map.set(key, idx);
      table.push(key);
    }
    return idx;
  };
  const stopList = [];
  for (const id of ids) {
    const m = meta.get(id);
    const en = String(m?.name || "").trim();
    const zh = String(zhById.get(id) || "").trim();
    stopList.push([
      id,
      Math.round((m?.lon || 0) * SCALE),
      Math.round((m?.lat || 0) * SCALE),
      indexOf(names, nameIndex, en),
      indexOf(zNames, zhIndex, zh),
    ]);
  }
  return { names, zNames, stopList };
}

/** Sanitize an agency id to a safe file name. */
function agencyKey(id) {
  const k = String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  return k || "default";
}

/**
 * Douglas-Peucker simplification in metres (equirectangular local approx).
 * Keeps terminal loops (they turn sharply) while dropping dense straight runs.
 * @param {number[][]} pts [lon, lat] pairs
 * @param {number} tolM
 * @returns {number[][]}
 */
function simplifyPathM(pts, tolM) {
  if (pts.length < 3) return pts;
  const cosLat = Math.cos(
    (((pts[0][1] + pts[pts.length - 1][1]) / 2) * Math.PI) / 180,
  );
  const mLat = 111320;
  const mLon = 111320 * cosLat;
  /** @type {Uint8Array} */
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  /** @type {Array<[number, number]>} */
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0];
    const ay = pts[a][1];
    const dx = (pts[b][0] - ax) * mLon;
    const dy = (pts[b][1] - ay) * mLat;
    const len2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (pts[i][0] - ax) * mLon;
      const py = (pts[i][1] - ay) * mLat;
      let t = len2 < 1e-9 ? 0 : (px * dx + py * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolM && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

async function downloadZip() {
  if (existsSync(TMP_ZIP)) {
    console.log(`[bus-shapes] using cached ${TMP_ZIP} (${statSync(TMP_ZIP).size} bytes)`);
    return TMP_ZIP;
  }
  console.log(`[bus-shapes] downloading ${DEFAULT_URL} …`);
  mkdirSync(dirname(TMP_ZIP), { recursive: true });
  const res = await fetch(DEFAULT_URL, {
    headers: { "User-Agent": "MORGAN-Travelers/0.4 (bus-shapes-build)" },
  });
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const out = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
    got += value.length;
    if (total) {
      process.stdout.write(
        `\r[bus-shapes] ${Math.round((got / total) * 100)}% (${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)`,
      );
    }
  }
  process.stdout.write("\n");
  writeFileSync(TMP_ZIP, Buffer.concat(out));
  console.log(`[bus-shapes] saved ${TMP_ZIP} (${got} bytes)`);
  return TMP_ZIP;
}

/** Patch existing stops.json with zh-Hant names (no shape rebuild). */
async function patchStopsZh(zip) {
  const stopsPath = join(outDir, "stops.json");
  if (!existsSync(stopsPath)) {
    console.error("[bus-shapes] missing", stopsPath);
    process.exit(1);
  }
  const zhById = await loadZhStopNames(zip);
  const cur = JSON.parse(readFileSync(stopsPath, "utf8"));
  const rows = Array.isArray(cur.s) ? cur.s : [];
  const enTable = Array.isArray(cur.n) ? cur.n : [];
  const zhIndex = new Map();
  const zNames = [];
  const indexOfZh = (value) => {
    const key = value || "";
    let idx = zhIndex.get(key);
    if (idx === undefined) {
      idx = zNames.length;
      zhIndex.set(key, idx);
      zNames.push(key);
    }
    return idx;
  };
  let hit = 0;
  const next = rows.map((row) => {
    const id = String(row[0] || "");
    const zh = String(zhById.get(id) || "").trim();
    if (zh) hit += 1;
    return [row[0], row[1], row[2], row[3], indexOfZh(zh)];
  });
  const updatedAt = new Date().toISOString();
  writeFileSync(
    stopsPath,
    JSON.stringify({
      v: 2,
      updated_at: updatedAt,
      n: enTable,
      z: zNames,
      s: next,
    }),
  );
  console.log(
    `[bus-shapes] patched stops.json: ${hit}/${rows.length} with zh-Hant (${zNames.length} unique)`,
  );
}

async function main() {
  checkUnzip();
  const zip = zipPath || (await downloadZip());
  console.log(`[bus-shapes] parsing ${zip}`);
  if (stopsZhOnly) {
    await patchStopsZh(zip);
    return;
  }

  // routes.txt: route_id → { agency, short }
  /** @type {Map<string, { agency: string, short: string }>} */
  const routes = new Map();
  let head = true;
  for await (const row of zipCsvRows(zip, "routes.txt")) {
    if (head) {
      head = false;
      continue;
    }
    if (!row[0]) continue;
    routes.set(row[0], {
      agency: agencyKey(row[1] ?? ""),
      short: String(row[2] ?? "").trim(),
    });
  }
  console.log(`[bus-shapes] routes.txt: ${routes.size} routes`);

  // trips.txt: (route_id, direction, shape_id) → headsigns, trip count.
  // Also records trip_id → route/direction for the stop-sequence pass.
  /** @type {Map<string, { headsigns: Set<string>, trips: number }>} */
  const tripGroups = new Map();
  /** @type {Map<string, { routeId: string, dir: string }>} */
  const tripMeta = new Map();
  head = true;
  for await (const row of zipCsvRows(zip, "trips.txt")) {
    if (head) {
      head = false;
      continue;
    }
    // Columns: route_id, service_id, trip_id, trip_headsign, direction_id, shape_id
    const [routeId, , tripId, headsign, dirRaw, shapeId] = row;
    const dir = String(dirRaw ?? "0");
    if (tripId) tripMeta.set(tripId, { routeId, dir });
    if (!routeId || !shapeId) continue;
    const key = `${routeId}\u0000${dir}\u0000${shapeId}`;
    let g = tripGroups.get(key);
    if (!g) {
      g = { headsigns: new Set(), trips: 0 };
      tripGroups.set(key, g);
    }
    g.trips++;
    if (headsign) g.headsigns.add(String(headsign).trim());
  }
  console.log(`[bus-shapes] trips.txt: ${tripGroups.size} shape groups`);

  // shapes.txt: shape_id → points (streamed; could be 10M+ rows)
  /** @type {Map<string, number[][]>} */
  const shapes = new Map();
  head = true;
  for await (const row of zipCsvRows(zip, "shapes.txt")) {
    if (head) {
      head = false;
      continue;
    }
    const [shapeId, latRaw, lonRaw] = row;
    if (!shapeId) continue;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let pts = shapes.get(shapeId);
    if (!pts) {
      pts = [];
      shapes.set(shapeId, pts);
    }
    // Streamed decimation: the feed samples shapes at 1-2 m, so long trunk
    // routes previously blew the point cap and were dropped whole (losing
    // their terminal loops). Keeping points ≥ DECIMATE_EPS_M apart bounds
    // memory and the 6 m DP pass still produces identical display geometry.
    if (pts.length) {
      const last = pts[pts.length - 1];
      const cosLat = Math.cos((((last[1] + lat) / 2) * Math.PI) / 180);
      const dLon = (lon - last[0]) * 111320 * cosLat;
      const dLat = (lat - last[1]) * 111320;
      if (dLon * dLon + dLat * dLat < DECIMATE_EPS_M * DECIMATE_EPS_M) {
        continue;
      }
    }
    if (pts.length >= MAX_POINTS_PER_SHAPE) continue;
    pts.push([lon, lat]);
  }
  console.log(`[bus-shapes] shapes.txt: ${shapes.size} shapes (simplify ${SIMPLIFY_M} m)`);

  // stop_times.txt: trip_id → (seq, stop_id) rows, file-ordered per trip.
  /** @type {Map<string, Array<{ seq: number, stopId: string }>>} */
  const tripStops = new Map();
  head = true;
  for await (const row of zipCsvRows(zip, "stop_times.txt")) {
    if (head) {
      head = false;
      continue;
    }
    const tripId = row[0];
    const stopId = row[3];
    if (!tripId || !stopId) continue;
    let arr = tripStops.get(tripId);
    if (!arr) {
      arr = [];
      tripStops.set(tripId, arr);
    }
    const seq = Number(row[4]);
    arr.push({ seq: Number.isFinite(seq) ? seq : arr.length + 1, stopId });
  }
  console.log(`[bus-shapes] stop_times.txt: ${tripStops.size} trips`);

  // stops.txt: stop_id → name + coordinates (for the shared directory).
  /** @type {Map<string, { name: string, lat: number, lon: number }>} */
  const stopMeta = new Map();
  head = true;
  for await (const row of zipCsvRows(zip, "stops.txt")) {
    if (head) {
      head = false;
      continue;
    }
    const [stopId, name, latRaw, lonRaw] = row;
    if (!stopId) continue;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    stopMeta.set(stopId, {
      name: String(name || "").trim() || stopId,
      lat,
      lon,
    });
  }
  console.log(`[bus-shapes] stops.txt: ${stopMeta.size} stops`);

  // Group per (route, direction), keep representative shapes (most trips)
  /** @type {Map<string, Map<string, Array<{ shapeId: string, pts: number[][], headsigns: string[], trips: number }>>>> */
  const byRouteDir = new Map();
  for (const [key, g] of tripGroups) {
    const [routeId, dir, shapeId] = key.split("\u0000");
    const pts = shapes.get(shapeId);
    // Drop shapes that hit the point cap — they were truncated mid-route and
    // would lose their terminal loop; better to fall back to OSRM for them.
    if (!pts || pts.length < 3 || pts.length >= MAX_POINTS_PER_SHAPE) continue;
    let dirs = byRouteDir.get(routeId);
    if (!dirs) {
      dirs = new Map();
      byRouteDir.set(routeId, dirs);
    }
    let list = dirs.get(dir);
    if (!list) {
      list = [];
      dirs.set(dir, list);
    }
    list.push({
      shapeId,
      pts,
      headsigns: [...g.headsigns],
      trips: g.trips,
    });
  }

  // Stop sequences per (route, direction): keep the longest trip so
  // short-working variants never truncate the list; sort by stop_sequence.
  /** @type {Map<string, Map<string, string[]>>} routeId → dir → stopIds */
  const stopSeqByRouteDir = new Map();
  for (const [tripId, meta] of tripMeta) {
    const agency = routes.get(meta.routeId)?.agency;
    if (!STOP_AGENCIES.has(agency)) continue;
    const arr = tripStops.get(tripId);
    if (!arr || arr.length < 2) continue;
    arr.sort((a, b) => a.seq - b.seq);
    let dirs = stopSeqByRouteDir.get(meta.routeId);
    if (!dirs) {
      dirs = new Map();
      stopSeqByRouteDir.set(meta.routeId, dirs);
    }
    const cur = dirs.get(meta.dir);
    if (!cur || arr.length > cur.length) {
      dirs.set(meta.dir, arr.map((s) => s.stopId));
    }
  }
  console.log(
    `[bus-shapes] stop sequences: ${stopSeqByRouteDir.size} routes`,
  );

  // Shared stop directory: index every referenced stop (sorted, stable),
  // dedupe names into a string table.
  const referenced = new Set();
  for (const dirs of stopSeqByRouteDir.values()) {
    for (const ids of dirs.values()) {
      for (const id of ids) referenced.add(id);
    }
  }
  const stopIds = [...referenced].sort();
  const stopIndex = new Map(stopIds.map((id, i) => [id, i]));
  const zhById = await loadZhStopNames(zip);
  const packed = packStopNames(stopIds, stopMeta, zhById);
  const names = packed.names;
  const zNames = packed.zNames;
  const stopList = packed.stopList;

  /** @type {Map<string, object>} agency → file payload */
  const agencies = new Map();
  let routesIndexed = 0;
  let shapesIndexed = 0;

  const allRouteIds = new Set([
    ...byRouteDir.keys(),
    ...stopSeqByRouteDir.keys(),
  ]);
  for (const routeId of allRouteIds) {
    const meta = routes.get(routeId);
    const agency = meta?.agency || agencyKey(routeId.split("_")[0] || "");
    const short = meta?.short || routeId;
    let payload = agencies.get(agency);
    if (!payload) {
      payload = { routes: {} };
      agencies.set(agency, payload);
    }
    const dirEntries = [];
    const shapeDirs = byRouteDir.get(routeId);
    if (shapeDirs) {
      for (const [dir, list] of shapeDirs) {
        const sorted = [...list]
          .sort((a, b) => b.trips - a.trips)
          .slice(0, MAX_SHAPES_PER_DIR);
        for (const s of sorted) {
          const pts = simplifyPathM(s.pts, SIMPLIFY_M);
          if (pts.length < 3) continue;
          const ints = [
            Math.round(pts[0][0] * SCALE),
            Math.round(pts[0][1] * SCALE),
          ];
          for (let i = 1; i < pts.length; i++) {
            ints.push(
              Math.round((pts[i][0] - pts[i - 1][0]) * SCALE),
              Math.round((pts[i][1] - pts[i - 1][1]) * SCALE),
            );
          }
          dirEntries.push({
            d: String(dir),
            h: s.headsigns.slice(0, 6),
            c: ints,
          });
          shapesIndexed++;
        }
      }
    }
    const stEntries = {};
    const seqDirs = stopSeqByRouteDir.get(routeId);
    if (seqDirs) {
      for (const [dir, ids] of seqDirs) {
        stEntries[dir] = ids.map((id) => stopIndex.get(id));
      }
    }
    if (!dirEntries.length && !Object.keys(stEntries).length) continue;
    const routeEntry = { sn: short };
    if (dirEntries.length) routeEntry.shapes = dirEntries;
    if (Object.keys(stEntries).length) routeEntry.st = stEntries;
    payload.routes[routeId] = routeEntry;
    routesIndexed++;
  }

  // Write per-agency files + index + shared stop directory
  mkdirSync(outDir, { recursive: true });
  const updatedAt = new Date().toISOString();
  /** @type {Record<string, string>} */
  const files = {};
  /** @type {Record<string, string>} */
  const routeFile = {};

  for (const [agency, payload] of agencies) {
    const file = `${agency}.json`;
    writeFileSync(
      join(outDir, file),
      JSON.stringify({ v: 1, updated_at: updatedAt, routes: payload.routes }),
    );
    files[agency] = file;
    for (const routeId of Object.keys(payload.routes)) {
      routeFile[routeId.toUpperCase().replace(/\s+/g, "")] = agency;
    }
    console.log(
      `[bus-shapes] ${file}: ${Object.keys(payload.routes).length} routes`,
    );
  }

  writeFileSync(
    join(outDir, "stops.json"),
    JSON.stringify({
      v: 2,
      updated_at: updatedAt,
      n: names,
      z: zNames,
      s: stopList,
    }),
  );
  console.log(
    `[bus-shapes] stops.json: ${stopList.length} stops, ${names.length} en names, ${zNames.length} zh names`,
  );

  writeFileSync(
    join(outDir, "index.json"),
    JSON.stringify({ v: 1, updated_at: updatedAt, files, route_file: routeFile }),
  );

  // Sanity + report
  const totalBytes = [...agencies.keys()].reduce(
    (acc, a) => acc + statSync(join(outDir, files[a])).size,
    statSync(join(outDir, "stops.json")).size,
  );

  console.log(
    `\n[bus-shapes] done: ${routesIndexed} routes, ${shapesIndexed} shapes, ` +
      `${stopList.length} stops, ${agencies.size} agencies, ` +
      `${(totalBytes / 1e6).toFixed(1)} MB → ${outDir}`,
  );
  if (routesIndexed === 0 || (stopSeqByRouteDir.size > 0 && stopList.length === 0)) {
    console.error(
      "[bus-shapes] no routes indexed or stops missing — feed format changed?",
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[bus-shapes] failed:", e?.message || e);
  process.exit(1);
});
