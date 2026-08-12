/**
 * Build a compact per-agency bus schedule index from the published GTFS.
 *
 * Source: hk.gtfs.zip on the edge data plane (DATA_PUBLIC_BASE_URL) — the same
 * feed artifacts/bus-shapes/hk.gtfs.zip was built from.
 * Output: public/data/bus-schedules/ (index.json + one compact JSON per agency).
 *
 * Why: the live bus position engine (PRD 4.2 v2) computes whole-route bus
 * positions from GTFS schedules (Speed + Time = Position, traffic speed
 * applied), with the 3 ETAs at the selected stop re-anchoring the next 3
 * buses. The shape index only stores geometry; this index stores timing.
 *
 * File layout (per agency, e.g. kmb.json):
 *   { v: 1, updated_at,
 *     stops: [[lonE5, latE5], ...],                 // file-level deduped stop table
 *     svc:   [[dayMask, [addedDayNums], [removedDayNums], startDayNum, endDayNum], ...],
 *       dayMask bit k = JS weekday k (0=Sun..6=Sat); dayNum = days since epoch.
 *       start/end day bounds are the calendar.txt validity window (appended
 *       beyond the plan sketch so expired services stop matching after the
 *       calendar ends instead of running forever).
 *     routes: { "KMB-1": {
 *       p: [ [[stopIdx, offsetSec, dirNum], ...], ... ],  // patterns: seq-ordered
 *         (stop, offset s from the trip's 1st departure; dirNum 0|1 so the
 *         runtime can filter patterns by the ETA bound direction)
 *       t: [ [patIdx, startSec, svcIdx], ... ],           // fixed trips
 *       f: [ [patIdx, startSec, endSec, headwaySec, svcIdx], ... ] } } }
 *       // frequency trips: departures at start + k·headway ≤ end
 *
 * Rules (honest + graceful): pattern offsets = median across the trips of the
 * same (stop sequence, direction) — robust to outlier running times; trips
 * with <2 stops, unparseable/non-increasing offsets, or stops missing from
 * stops.txt are skipped with a count log.
 *
 * Usage:
 *   node scripts/build-bus-schedules.mjs            # build from cached zip
 *   node scripts/build-bus-schedules.mjs --zip out/hk.gtfs.zip
 * Env: DATA_PUBLIC_BASE_URL (default https://hk-gtfsdata.morgandev.cc)
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data", "bus-schedules");
const DEFAULT_URL =
  `${process.env.DATA_PUBLIC_BASE_URL || "https://hk-gtfsdata.morgandev.cc"}` +
  "/hk.gtfs.zip";
const TMP_ZIP = join(ROOT, "artifacts", "bus-shapes", "hk.gtfs.zip");
/** Agencies whose schedules we ship (matches the engine's ETA operators). */
const AGENCIES = new Set(["kmb", "ctb", "nlb"]);
const DAY_MS = 86400000;
const SCALE = 1e5;

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const zipArg = args.find((a) => a.startsWith("--zip="))?.slice(6);
const outArg = args.find((a) => a.startsWith("--out="))?.slice(6);
const zipPath = zipArg || (existsSync(TMP_ZIP) ? TMP_ZIP : null);
const outDir = outArg || OUT_DIR;

// ── helpers (copied from build-bus-shapes-index.mjs) ────────────────────────

function checkUnzip() {
  const r = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(
      "[bus-schedules] `unzip` not found — install it (macOS: bundled; CI: apt-get install unzip)",
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

/** Yield { cols } for the header row, then plain rows (positional via cols). */
async function* csvTable(zipPath, member) {
  const it = zipCsvRows(zipPath, member);
  const first = await it.next();
  if (first.done) return;
  const cols = new Map(first.value.map((h, i) => [h, i]));
  for await (const row of it) yield { cols, row };
}

/** Sanitize an agency id to a safe file name. */
function agencyKey(id) {
  const k = String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  return k || "default";
}

/** "HH:MM:SS" → seconds (times may exceed 24:00:00 for overnight trips). */
function parseHMS(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(String(s || "").trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** "YYYYMMDD" → days since epoch (UTC). */
function dateToDayNum(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || "").trim());
  if (!m) return NaN;
  return Math.round(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS,
  );
}

async function downloadZip() {
  if (existsSync(TMP_ZIP)) {
    console.log(
      `[bus-schedules] using cached ${TMP_ZIP} (${statSync(TMP_ZIP).size} bytes)`,
    );
    return TMP_ZIP;
  }
  console.log(`[bus-schedules] downloading ${DEFAULT_URL} …`);
  mkdirSync(dirname(TMP_ZIP), { recursive: true });
  const res = await fetch(DEFAULT_URL, {
    headers: { "User-Agent": "MORGAN-Travelers/0.4 (bus-schedules-build)" },
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
        `\r[bus-schedules] ${Math.round((got / total) * 100)}% (${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)`,
      );
    }
  }
  process.stdout.write("\n");
  writeFileSync(TMP_ZIP, Buffer.concat(out));
  console.log(`[bus-schedules] saved ${TMP_ZIP} (${got} bytes)`);
  return TMP_ZIP;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  checkUnzip();
  const zip = zipPath || (await downloadZip());
  console.log(`[bus-schedules] parsing ${zip}`);

  // routes.txt: route_id → agency (filtered) — the raw GTFS route_id is the
  // output key (matches the shape index's route_file keys like "KMB-1").
  /** @type {Map<string, string>} routeId → agency */
  const wantedRoutes = new Map();
  for await (const { cols, row } of csvTable(zip, "routes.txt")) {
    const routeId = row[cols.get("route_id")];
    if (!routeId) continue;
    const agency = agencyKey(row[cols.get("agency_id")]);
    if (AGENCIES.has(agency)) wantedRoutes.set(routeId, agency);
  }
  console.log(`[bus-schedules] routes.txt: ${wantedRoutes.size} wanted routes`);

  // trips.txt: trip_id → { routeId, serviceId, dir } (wanted routes only).
  /** @type {Map<string, { routeId: string, serviceId: string, dir: string }>} */
  const trips = new Map();
  /** @type {Map<string, string[]>} routeId → trip ids */
  const tripsByRoute = new Map();
  const usedServices = new Set();
  for await (const { cols, row } of csvTable(zip, "trips.txt")) {
    const routeId = row[cols.get("route_id")];
    if (!routeId || !wantedRoutes.has(routeId)) continue;
    const tripId = row[cols.get("trip_id")];
    const serviceId = row[cols.get("service_id")];
    if (!tripId || !serviceId) continue;
    const dir = String(row[cols.get("direction_id")] ?? "0");
    trips.set(tripId, { routeId, serviceId, dir });
    usedServices.add(serviceId);
    let list = tripsByRoute.get(routeId);
    if (!list) {
      list = [];
      tripsByRoute.set(routeId, list);
    }
    list.push(tripId);
  }
  console.log(`[bus-schedules] trips.txt: ${trips.size} wanted trips`);

  // calendar.txt: service_id → weekday mask + validity window.
  /** @type {Map<string, { dayMask: number, startDay: number, endDay: number }>} */
  const calendars = new Map();
  for await (const { cols, row } of csvTable(zip, "calendar.txt")) {
    const serviceId = row[cols.get("service_id")];
    if (!serviceId || !usedServices.has(serviceId)) continue;
    const week = [
      "sunday", "monday", "tuesday", "wednesday", "thursday", "friday",
      "saturday",
    ];
    let dayMask = 0;
    for (let w = 0; w < 7; w++) {
      if (String(row[cols.get(week[w])] ?? "").trim() === "1") dayMask |= 1 << w;
    }
    const startDay = dateToDayNum(row[cols.get("start_date")]);
    const endDay = dateToDayNum(row[cols.get("end_date")]);
    if (!Number.isFinite(startDay) || !Number.isFinite(endDay)) continue;
    calendars.set(serviceId, { dayMask, startDay, endDay });
  }

  // calendar_dates.txt: service_id → added/removed day lists (1=added, 2=removed).
  /** @type {Map<string, { added: Set<number>, removed: Set<number> }>} */
  const calDates = new Map();
  for await (const { cols, row } of csvTable(zip, "calendar_dates.txt")) {
    const serviceId = row[cols.get("service_id")];
    if (!serviceId || !usedServices.has(serviceId)) continue;
    const dayNum = dateToDayNum(row[cols.get("date")]);
    const type = Number(row[cols.get("exception_type")]);
    if (!Number.isFinite(dayNum)) continue;
    let e = calDates.get(serviceId);
    if (!e) {
      e = { added: new Set(), removed: new Set() };
      calDates.set(serviceId, e);
    }
    (type === 1 ? e.added : type === 2 ? e.removed : null)?.add(dayNum);
  }
  console.log(
    `[bus-schedules] calendar: ${calendars.size} services, ${calDates.size} with exceptions`,
  );

  // frequencies.txt: trip_id → headway bands.
  /** @type {Map<string, Array<{ startSec: number, endSec: number, headwaySec: number }>>} */
  const freqs = new Map();
  for await (const { cols, row } of csvTable(zip, "frequencies.txt")) {
    const tripId = row[cols.get("trip_id")];
    if (!tripId || !trips.has(tripId)) continue;
    const startSec = parseHMS(row[cols.get("start_time")]);
    const endSec = parseHMS(row[cols.get("end_time")]);
    const headwaySec = Number(row[cols.get("headway_secs")]);
    if (![startSec, endSec, headwaySec].every(Number.isFinite)) continue;
    if (headwaySec <= 0 || endSec < startSec) continue;
    let list = freqs.get(tripId);
    if (!list) {
      list = [];
      freqs.set(tripId, list);
    }
    list.push({ startSec, endSec, headwaySec });
  }

  // stop_times.txt: wanted trip_id → seq-sorted (stopId, depSec). GTFS times
  // are HH:MM:SS and may exceed 24:00; frequency trips use offsets relative to
  // the trip start — normalized below by subtracting the first departure.
  /** @type {Map<string, Array<{ stopId: string, depSec: number }>>} */
  const tripStops = new Map();
  for await (const { cols, row } of csvTable(zip, "stop_times.txt")) {
    const tripId = row[cols.get("trip_id")];
    if (!tripId || !trips.has(tripId)) continue;
    const stopId = row[cols.get("stop_id")];
    const depSec = parseHMS(
      row[cols.get("departure_time")] ?? row[cols.get("arrival_time")],
    );
    if (!stopId) continue;
    let arr = tripStops.get(tripId);
    if (!arr) {
      arr = [];
      tripStops.set(tripId, arr);
    }
    arr.push({ stopId, depSec, seq: Number(row[cols.get("stop_sequence")]) || arr.length + 1 });
  }
  console.log(`[bus-schedules] stop_times.txt: ${tripStops.size} wanted trips`);

  // stops.txt: stop_id → coordinates.
  /** @type {Map<string, { lon: number, lat: number }>} */
  const stopMeta = new Map();
  for await (const { cols, row } of csvTable(zip, "stops.txt")) {
    const stopId = row[cols.get("stop_id")];
    if (!stopId) continue;
    const lat = Number(row[cols.get("stop_lat")]);
    const lon = Number(row[cols.get("stop_lon")]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stopMeta.set(stopId, { lon, lat });
  }

  // ── per-agency build ─────────────────────────────────────────────────────
  const skipped = { len: 0, times: 0, order: 0, stops: 0, svc: 0 };
  let tripsIndexed = 0;
  let freqBandsIndexed = 0;
  let patternsIndexed = 0;

  /** @type {Map<string, { routes: object, stops: number[][], stopIdx: Map<string, number>, svc: Array<any>, svcIdx: Map<string, number> }>} */
  const agencies = new Map();
  const payloadOf = (agency) => {
    let p = agencies.get(agency);
    if (!p) {
      p = { routes: {}, stops: [], stopIdx: new Map(), svc: [], svcIdx: new Map() };
      agencies.set(agency, p);
    }
    return p;
  };

  const svcRowOf = (payload, serviceId) => {
    if (payload.svcIdx.has(serviceId)) return payload.svcIdx.get(serviceId);
    const cal = calendars.get(serviceId);
    const ex = calDates.get(serviceId);
    if (!cal && !ex) return -1;
    const added = [...(ex?.added || [])].sort((a, b) => a - b);
    const removed = [...(ex?.removed || [])].sort((a, b) => a - b);
    const startDay = cal ? cal.startDay : Math.min(...added, ...removed, 0);
    const endDay = cal ? cal.endDay : Math.max(...added, ...removed, 0);
    if (!Number.isFinite(startDay) || !Number.isFinite(endDay)) return -1;
    const row = [cal?.dayMask || 0, added, removed, startDay, endDay];
    const key = JSON.stringify(row);
    for (let i = 0; i < payload.svc.length; i++) {
      if (JSON.stringify(payload.svc[i]) === key) {
        payload.svcIdx.set(serviceId, i);
        return i;
      }
    }
    payload.svcIdx.set(serviceId, payload.svc.length);
    payload.svc.push(row);
    return payload.svc.length - 1;
  };

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  for (const [routeId, agency] of [...wantedRoutes].sort()) {
    const payload = payloadOf(agency);
    const routeTrips = tripsByRoute.get(routeId) || [];
    // Group trips by (direction, stop-id sequence) → per-position offset lists.
    /** @type {Map<string, { dir: string, stopIds: string[], offsets: number[][] }>} */
    const groups = new Map();
    /** @type {Map<string, Array<{ tripId: string, startSec: number, svcIdx: number }>>} fixed trips per group */
    const fixedByGroup = new Map();
    /** @type {Map<string, Array<{ tripId: string, svcIdx: number, bands: Array<{ startSec: number, endSec: number, headwaySec: number }> }>>} freq trips per group */
    const freqByGroup = new Map();

    for (const tripId of routeTrips) {
      const meta = trips.get(tripId);
      const st = tripStops.get(tripId);
      if (!st || st.length < 2) {
        skipped.len++;
        continue;
      }
      st.sort((a, b) => a.seq - b.seq);
      const depSecs = st.map((s) => s.depSec);
      if (depSecs.some((d) => !Number.isFinite(d))) {
        skipped.times++;
        continue;
      }
      // Offsets relative to the 1st departure (also normalizes freq trips).
      const base = depSecs[0];
      const offsets = depSecs.map((d) => Math.max(0, d - base));
      let monotonic = true;
      for (let i = 1; i < offsets.length; i++) {
        if (offsets[i] < offsets[i - 1]) {
          monotonic = false;
          break;
        }
      }
      if (!monotonic) {
        skipped.order++;
        continue;
      }
      const stopIds = st.map((s) => s.stopId);
      let missing = false;
      for (const id of stopIds) {
        if (!stopMeta.has(id)) {
          missing = true;
          break;
        }
      }
      if (missing) {
        skipped.stops++;
        continue;
      }
      const svcIdx = svcRowOf(payload, meta.serviceId);
      if (svcIdx < 0) {
        skipped.svc++;
        continue;
      }
      const key = `${meta.dir}\u0000${stopIds.join("\u0000")}`;
      let g = groups.get(key);
      if (!g) {
        g = { dir: meta.dir, stopIds, offsets: stopIds.map(() => []) };
        groups.set(key, g);
      }
      for (let i = 0; i < offsets.length; i++) g.offsets[i].push(offsets[i]);
      const bands = freqs.get(tripId);
      if (bands?.length) {
        let fl = freqByGroup.get(key);
        if (!fl) {
          fl = [];
          freqByGroup.set(key, fl);
        }
        fl.push({ tripId, svcIdx, bands });
      } else {
        let tl = fixedByGroup.get(key);
        if (!tl) {
          tl = [];
          fixedByGroup.set(key, tl);
        }
        tl.push({ tripId, startSec: base, svcIdx });
      }
    }

    if (!groups.size) continue;
    const routeEntry = { p: [], t: [], f: [] };
    const patIdxOf = new Map();
    for (const [key, g] of groups) {
      const patIdx = routeEntry.p.length;
      patIdxOf.set(key, patIdx);
      // Median offset per position (robust to outlier running times).
      const dirNum = g.dir === "1" ? 1 : 0;
      const pat = g.stopIds.map((stopId, i) => {
        const m = stopMeta.get(stopId);
        let si = payload.stopIdx.get(stopId);
        if (si === undefined) {
          si = payload.stops.length;
          payload.stopIdx.set(stopId, si);
          payload.stops.push([Math.round(m.lon * SCALE), Math.round(m.lat * SCALE)]);
        }
        return [si, median(g.offsets[i]), dirNum];
      });
      routeEntry.p.push(pat);
      patternsIndexed++;
      for (const t of fixedByGroup.get(key) || []) {
        routeEntry.t.push([patIdx, t.startSec, t.svcIdx]);
        tripsIndexed++;
      }
      for (const f of freqByGroup.get(key) || []) {
        for (const b of f.bands) {
          routeEntry.f.push([patIdx, b.startSec, b.endSec, b.headwaySec, f.svcIdx]);
          freqBandsIndexed++;
        }
      }
    }
    // Collapse empty arrays so unused slots don't inflate the file.
    if (!routeEntry.t.length) delete routeEntry.t;
    if (!routeEntry.f.length) delete routeEntry.f;
    payload.routes[routeId] = routeEntry;

    if (routeId === "KMB-1" && agency === "kmb") {
      const p0 = routeEntry.p[0];
      console.log(
        `[bus-schedules] KMB-1 sample: ${routeEntry.p.length} patterns, ` +
          `${routeEntry.t?.length || 0} fixed, ${routeEntry.f?.length || 0} freq; ` +
          `pattern 0 = ${p0?.length || 0} stops, first offsets ` +
          `${(p0 || []).slice(0, 6).map((x) => `${x[1]}s`).join(", ")}`,
      );
    }
  }

  // ── write files ──────────────────────────────────────────────────────────
  mkdirSync(outDir, { recursive: true });
  const updatedAt = new Date().toISOString();
  /** @type {Record<string, string>} */
  const files = {};
  for (const [agency, payload] of [...agencies].sort()) {
    const file = `${agency}.json`;
    writeFileSync(
      join(outDir, file),
      JSON.stringify({
        v: 1,
        updated_at: updatedAt,
        stops: payload.stops,
        svc: payload.svc,
        routes: payload.routes,
      }),
    );
    files[agency] = file;
    console.log(
      `[bus-schedules] ${file}: ${Object.keys(payload.routes).length} routes, ` +
        `${payload.svc.length} services, ${payload.stops.length} stops, ` +
        `${(statSync(join(outDir, file)).size / 1e6).toFixed(2)} MB`,
    );
  }
  writeFileSync(
    join(outDir, "index.json"),
    JSON.stringify({ v: 1, updated_at: updatedAt, files }),
  );

  console.log(
    `\n[bus-schedules] done: ${agencies.size} agencies, ${tripsIndexed} fixed trips, ` +
      `${freqBandsIndexed} freq bands, ${patternsIndexed} patterns → ${outDir}`,
  );
  console.log(
    `[bus-schedules] skipped trips: <2 stops ${skipped.len}, bad times ${skipped.times}, ` +
      `non-increasing ${skipped.order}, missing stops ${skipped.stops}, no service ${skipped.svc}`,
  );
  if (!tripsIndexed && !freqBandsIndexed) {
    console.error("[bus-schedules] no trips indexed — feed format changed?");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[bus-schedules] failed:", e?.message || e);
  process.exit(1);
});
