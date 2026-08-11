/**
 * Build compact Residents' Bus Services (RBS) route data from the TD headway GTFS.
 *
 * Source: https://static.data.gov.hk/td/pt-headway-en/gtfs.zip (agencies PI,
 * DB + CTB-operated NR routes). RBS has no live ETA feed, so this feed's stop
 * sequences + frequency headways are folded into the app's ETA
 * browse/search/detail as "Timetable" cards.
 *
 * Feed quirks handled here:
 *  · trips.txt has no direction_id / trip_headsign — direction is inferred by
 *    comparing first/last stop ids between trip patterns.
 *  · one route_short_name maps to several route_id rows (variant routings:
 *    "VIA TUNG CHUNG", "SPECIAL DEPARTURE" …) — merged into one entry, the
 *    longest stop sequence wins, headways/service windows aggregate.
 *  · stop names are operator-variant strings ("[CTB] X |[KMB+CTB] X/<BR>X")
 *    with no Chinese — cleaned to the first variant, "[..] " prefixes and
 *    tags stripped, title-cased.
 *
 * Output:
 *   public/data/rbs-routes.json — route id → per-direction { dest/orig,
 *     headwayMins (time-weighted from frequencies.txt), first/last (service
 *     window in minutes after midnight, may exceed 1440), overnight, stops }.
 *   public/data/rbs-stops.json — eta-nearby-stops.json rows (RBS- prefixed
 *     stop ids) so Nearby browse finds NR/DB routes geographically.
 *
 * Usage:
 *   node scripts/build-rbs-data.mjs            # download + build
 *   node scripts/build-rbs-data.mjs --zip out/gtfs.zip
 * Env: RBS_GTFS_URL (default https://static.data.gov.hk/td/pt-headway-en/gtfs.zip)
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "data");
const DEFAULT_URL =
  process.env.RBS_GTFS_URL ||
  "https://static.data.gov.hk/td/pt-headway-en/gtfs.zip";
const TMP_ZIP = join(ROOT, "artifacts", "rbs", "td-headway.gtfs.zip");

/** RBS routes: NR/DB route codes, or agencies PI (Park Island) / DB (Discovery Bay). */
function isRbsRoute(short, agencyId) {
  if (/^(NR|DB)\d/i.test(String(short || "").trim())) return true;
  return ["pi", "db"].includes(String(agencyId || "").toLowerCase());
}

/** "HH:MM:SS" (may exceed 24:00) → minutes after midnight. */
function clockToMins(raw) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(raw || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * "青衣站 Tsing Yi Station" → { zh, en }. TD bilingual fields put Chinese
 * first; names without CJK are treated as English only.
 */
function splitBilingual(raw) {
  const s = String(raw || "").trim();
  if (!s) return { zh: "", en: "" };
  const m = /^([\u3400-\u9fff][\u3400-\u9fff·（）()、,-]*?)\s+(.+)$/.exec(s);
  if (m) return { zh: m[1].trim(), en: m[2].trim() };
  return { zh: "", en: s };
}

/**
 * "[CTB] HIU TSUI STREET, SIU SAI WAN ROAD|[KMB+CTB] X/<BR>X" → "Hiu Tsui
 * Street, Siu Sai Wan Road": first variant only, "[..] " prefixes and tags
 * stripped, title-cased with real operator/place acronyms kept uppercase.
 */
const ACRONYMS = new Set(["DB", "PI", "NLB", "KMB", "CTB", "GMB", "LWB", "MTR", "HZMB", "HK"]);
function cleanName(raw) {
  let s = String(raw || "").split("|")[0] || "";
  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/\[[^\]]*\]\s*/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  const acro = [];
  s = s.replace(/\b[A-Z]{2,4}\b/g, (m) => {
    if (ACRONYMS.has(m)) {
      acro.push(m);
      return `\u0000${acro.length - 1}\u0000`;
    }
    return m.toLowerCase();
  });
  s = s
    .toLowerCase()
    .replace(/(^|[\s(/'-])([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => acro[Number(i)] || "");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const zipArg = args.find((a) => a.startsWith("--zip="))?.slice(6);
const zipPath = zipArg || (existsSync(TMP_ZIP) ? TMP_ZIP : null);

// ── helpers (same streaming pattern as build-bus-shapes-index.mjs) ──────────

function checkUnzip() {
  const r = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(
      "[rbs] `unzip` not found — install it (macOS: bundled; CI: apt-get install unzip)",
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

/** Stream one table out of the zip as { headers, row } batches. */
async function* zipCsv(zipPath, member) {
  const child = spawn("unzip", ["-p", zipPath, member], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    let headers = null;
    for await (const row of csvRows(child.stdout)) {
      if (!headers) {
        headers = row.map((h) => String(h).trim());
        continue;
      }
      yield { headers, row };
    }
  } finally {
    child.kill();
  }
}

/** Column lookup by any of the candidate header names (case-insensitive). */
function col(row, headers, ...cands) {
  const want = new Set(cands.map((c) => String(c).toLowerCase()));
  for (let i = 0; i < headers.length; i++) {
    if (want.has(String(headers[i]).toLowerCase())) return row[i];
  }
  return "";
}

async function downloadZip() {
  if (existsSync(TMP_ZIP)) {
    console.log(`[rbs] using cached ${TMP_ZIP} (${statSync(TMP_ZIP).size} bytes)`);
    return TMP_ZIP;
  }
  console.log(`[rbs] downloading ${DEFAULT_URL} …`);
  mkdirSync(dirname(TMP_ZIP), { recursive: true });
  const res = await fetch(DEFAULT_URL, {
    headers: { "User-Agent": "MORGAN-Travelers/0.4 (rbs-data-build)" },
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
        `\r[rbs] ${Math.round((got / total) * 100)}% (${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)`,
      );
    }
  }
  process.stdout.write("\n");
  writeFileSync(TMP_ZIP, Buffer.concat(out));
  console.log(`[rbs] saved ${TMP_ZIP} (${got} bytes)`);
  return TMP_ZIP;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  checkUnzip();
  const zip = zipPath || (await downloadZip());
  console.log(`[rbs] parsing ${zip}`);

  // routes.txt → keep RBS routes
  /** @type {Map<string, { agency: string, short: string, nameEn: string, nameZh: string }>} */
  const routes = new Map();
  for await (const { headers, row } of zipCsv(zip, "routes.txt")) {
    const routeId = col(row, headers, "route_id");
    if (!routeId) continue;
    const short = col(row, headers, "route_short_name");
    const agency = col(row, headers, "agency_id");
    if (!isRbsRoute(short, agency)) continue;
    const longName = splitBilingual(col(row, headers, "route_long_name"));
    routes.set(routeId, {
      agency: String(agency || "").toUpperCase(),
      short: String(short || "").trim().toUpperCase(),
      nameEn: cleanName(longName.en) || longName.en,
      nameZh: longName.zh,
    });
  }
  console.log(`[rbs] routes.txt: ${routes.size} RBS routes`);

  // stops.txt
  /** @type {Map<string, { name: string, nameEn: string, nameTc: string, lat: number, lon: number }>} */
  const stops = new Map();
  for await (const { headers, row } of zipCsv(zip, "stops.txt")) {
    const stopId = col(row, headers, "stop_id");
    if (!stopId) continue;
    const lat = Number(col(row, headers, "stop_lat", "latitude", "lat"));
    const lon = Number(col(row, headers, "stop_lon", "longitude", "long", "lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const nameEn = cleanName(
      col(row, headers, "stop_name_en", "stop_name_e", "name_en", "stop_name"),
    );
    const nameTc = String(
      col(row, headers, "stop_name_tc", "stop_name_c", "name_tc", "name_zh") ||
        "",
    ).trim();
    stops.set(stopId, {
      name: nameTc ? `${nameTc} ${nameEn}`.trim() : nameEn || stopId,
      nameEn,
      nameTc,
      lat,
      lon,
    });
  }
  console.log(`[rbs] stops.txt: ${stops.size} stops`);

  // trips.txt → trip meta; frequencies.txt → trip headways
  /** @type {Map<string, { routeId: string }>} */
  const tripMeta = new Map();
  /** @type {Map<string, Array<{ start: number, end: number, headway: number }>>} */
  const freq = new Map();
  for await (const { headers, row } of zipCsv(zip, "trips.txt")) {
    const tripId = col(row, headers, "trip_id");
    const routeId = col(row, headers, "route_id");
    if (!tripId || !routeId) continue;
    tripMeta.set(tripId, { routeId });
  }
  for await (const { headers, row } of zipCsv(zip, "frequencies.txt")) {
    const tripId = col(row, headers, "trip_id");
    if (!tripId) continue;
    const start = clockToMins(col(row, headers, "start_time"));
    const end = clockToMins(col(row, headers, "end_time"));
    const headway = Number(col(row, headers, "headway_secs")) / 60;
    if (start == null || end == null || !Number.isFinite(headway)) continue;
    let arr = freq.get(tripId);
    if (!arr) {
      arr = [];
      freq.set(tripId, arr);
    }
    arr.push({ start, end, headway });
  }
  console.log(`[rbs] trips.txt: ${tripMeta.size} trips, frequencies: ${freq.size}`);

  // stop_times.txt → trip sequences (also first/last departures without freq)
  /** @type {Map<string, Array<{ seq: number, stopId: string, dep: number | null }>>} */
  const tripStops = new Map();
  for await (const { headers, row } of zipCsv(zip, "stop_times.txt")) {
    const tripId = col(row, headers, "trip_id");
    const stopId = col(row, headers, "stop_id");
    if (!tripId || !stopId) continue;
    let arr = tripStops.get(tripId);
    if (!arr) {
      arr = [];
      tripStops.set(tripId, arr);
    }
    const seq = Number(col(row, headers, "stop_sequence"));
    const dep = clockToMins(col(row, headers, "departure_time"));
    arr.push({
      seq: Number.isFinite(seq) ? seq : arr.length + 1,
      stopId,
      dep,
    });
  }
  console.log(`[rbs] stop_times.txt: ${tripStops.size} trips`);

  // Aggregate per route_short_name: trips from every variant route_id merge;
  // direction is inferred from the first/last stop ids of the trip patterns.
  /** @type {Map<string, { agency: string, nameEn: string, nameZh: string, groups: Map<string, { trips: string[] }> }>} */
  const byShort = new Map();
  for (const [tripId, meta] of tripMeta) {
    const route = routes.get(meta.routeId);
    if (!route) continue;
    const arr = tripStops.get(tripId);
    if (!arr || arr.length < 2) continue;
    arr.sort((a, b) => a.seq - b.seq);
    const key = `${arr[0].stopId}>${arr[arr.length - 1].stopId}`;
    let entry = byShort.get(route.short);
    if (!entry) {
      entry = { agency: route.agency, nameEn: route.nameEn, nameZh: route.nameZh, groups: new Map() };
      byShort.set(route.short, entry);
    }
    let g = entry.groups.get(key);
    if (!g) {
      g = { trips: [] };
      entry.groups.set(key, g);
    }
    g.trips.push(tripId);
  }
  console.log(`[rbs] route groups: ${byShort.size} short names`);

  /** @type {Record<string, object>} route short → compact entry */
  const outRoutes = {};
  /** @type {Map<string, { lat: number, lon: number, name: string, routes: string[] }>} */
  const stopIndex = new Map();

  for (const [short, entry] of byShort) {
    /** @type {Record<string, object>} bound → dir entry */
    const dirEntries = {};
    let boundIdx = 0;
    for (const group of entry.groups.values()) {
      // Winning pattern = trip with the most stops
      let bestTrip = null;
      let bestLen = 0;
      /** @type {number[]} */
      const headways = [];
      // Discrete (no frequencies.txt) trips: first-stop departures + last-stop
      // arrivals, used for an estimated headway + a continuity-checked window.
      /** @type {number[]} */
      const deps = [];
      /** @type {number[]} */
      const arrivals = [];
      let anyFreq = false;
      let first = null;
      let last = null;
      for (const tripId of group.trips) {
        const arr = tripStops.get(tripId);
        const len = arr?.length || 0;
        if (len > bestLen) {
          bestLen = len;
          bestTrip = tripId;
        }
        const fs = freq.get(tripId);
        if (fs?.length) {
          anyFreq = true;
          // Time-weighted mean headway across the trip's frequency windows
          let span = 0;
          let weighted = 0;
          for (const f of fs) {
            const d = Math.max(0, f.end - f.start);
            span += d;
            weighted += d * f.headway;
          }
          if (span > 0) headways.push(weighted / span);
          for (const f of fs) {
            first = first == null ? f.start : Math.min(first, f.start);
            last = last == null ? f.end : Math.max(last, f.end);
          }
        } else {
          const d0 = arr[0].dep;
          const d1 = arr[arr.length - 1].dep;
          if (d0 != null) deps.push(d0);
          if (d1 != null) arrivals.push(d1);
        }
      }
      const seqArr = bestTrip ? tripStops.get(bestTrip) : null;
      if (!seqArr || seqArr.length < 2) continue;
      seqArr.sort((a, b) => a.seq - b.seq);
      const stopList = [];
      for (const s of seqArr) {
        const m = stops.get(s.stopId);
        if (!m) continue;
        stopList.push({
          id: s.stopId,
          name: m.name,
          nameEn: m.nameEn,
          nameTc: m.nameTc,
          lat: m.lat,
          lon: m.lon,
        });
        let idx = stopIndex.get(s.stopId);
        if (!idx) {
          idx = { lat: m.lat, lon: m.lon, name: m.name, routes: [] };
          stopIndex.set(s.stopId, idx);
        }
        if (!idx.routes.includes(short)) idx.routes.push(short);
      }
      if (stopList.length < 2) continue;

      /** @type {object} */
      const dirEntry = {
        dest: stopList[stopList.length - 1].nameEn || stopList[stopList.length - 1].name,
        destZh: stopList[stopList.length - 1].nameTc || "",
        orig: stopList[0].nameEn || stopList[0].name,
        origZh: stopList[0].nameTc || "",
        stops: stopList,
      };
      if (headways.length) {
        const sorted = headways.slice().sort((a, b) => a - b);
        const median =
          sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        dirEntry.headwayMins = Math.max(2, Math.min(60, Math.round(median)));
      } else if (deps.length >= 2) {
        // No frequencies — estimate headway from median gap between trips.
        const ordered = deps.slice().sort((a, b) => a - b);
        const gaps = [];
        for (let i = 1; i < ordered.length; i++) gaps.push(ordered[i] - ordered[i - 1]);
        gaps.sort((a, b) => a - b);
        const med =
          gaps.length % 2
            ? gaps[(gaps.length - 1) / 2]
            : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
        dirEntry.headwayMins = Math.max(2, Math.min(60, Math.round(med)));
      }
      if (anyFreq) {
        // frequencies.txt windows are the operator-published continuous spans
        if (first != null && last != null) {
          dirEntry.first = first;
          dirEntry.last = last;
          dirEntry.overnight = last > 24 * 60;
        }
      } else {
        // Discrete trips: first = earliest departure, last = latest arrival —
        // but only if the departures are reasonably continuous. Sparse routes
        // (e.g. NR338, one 23:50 trip then 01:05–06:00) must not claim a
        // day-long window; flag overnight and let the UI use the standard
        // 23:00–06:30 overnight window instead.
        const d0 = deps.length ? Math.min(...deps) : null;
        const d1 = arrivals.length ? Math.max(...arrivals) : null;
        const sortedDeps = deps.slice().sort((a, b) => a - b);
        let maxGap = 0;
        for (let i = 1; i < sortedDeps.length; i++) {
          maxGap = Math.max(maxGap, sortedDeps[i] - sortedDeps[i - 1]);
        }
        const continuous = deps.length < 3 || maxGap <= 6 * 60;
        if (d0 != null && d1 != null && d0 <= d1 && continuous) {
          dirEntry.first = d0;
          dirEntry.last = d1;
          dirEntry.overnight = d1 > 24 * 60;
        } else if (arrivals.some((a) => a > 24 * 60)) {
          dirEntry.overnight = true;
        }
      }
      dirEntries[boundIdx === 0 ? "O" : "I"] = dirEntry;
      boundIdx++;
      if (boundIdx > 1) break; // at most O + I
    }
    if (!Object.keys(dirEntries).length) continue;
    outRoutes[short] = {
      agency: entry.agency,
      nameEn: entry.nameEn,
      nameZh: entry.nameZh,
      dirs: dirEntries,
    };
  }

  // rbs-stops.json — eta-nearby-stops.json rows [lat, lon, name, id, pairs]
  const nearbyStops = [...stopIndex.entries()]
    .map(([rawId, s]) => [
      s.lat,
      s.lon,
      s.name,
      `RBS-${rawId}`,
      s.routes.map((r) => ["rbs", r]),
    ])
    .sort((a, b) => String(a[3]).localeCompare(String(b[3])));

  const updatedAt = new Date().toISOString();
  writeFileSync(
    join(OUT_DIR, "rbs-routes.json"),
    JSON.stringify({ v: 1, updated_at: updatedAt, routes: outRoutes }),
  );
  writeFileSync(
    join(OUT_DIR, "rbs-stops.json"),
    JSON.stringify({ v: 1, updated_at: updatedAt, stops: nearbyStops }),
  );

  const routeCount = Object.keys(outRoutes).length;
  console.log(
    `\n[rbs] done: ${routeCount} routes, ${nearbyStops.length} nearby stops ` +
      `(${(statSync(join(OUT_DIR, "rbs-routes.json")).size / 1e3).toFixed(0)} KB + ` +
      `${(statSync(join(OUT_DIR, "rbs-stops.json")).size / 1e3).toFixed(0)} KB) → ${OUT_DIR}`,
  );
  if (routeCount === 0) {
    console.error("[rbs] no RBS routes found — feed format changed?");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[rbs] failed:", e?.message || e);
  process.exit(1);
});
