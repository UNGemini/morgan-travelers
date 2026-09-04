/**
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 UNLOOP MORGAN
 *
 * Live Position Engine — licensed under the GNU General Public License v3.0
 * only. See licenses/GPL-3.0.txt. The rest of MORGAN Travelers is Apache-2.0.
 *
 * Lazy GTFS schedule index (built by scripts/build-bus-schedules.mjs).
 *
 * Powers the schedule-based bus position engine (PRD 4.2 v2): instead of
 * stitching ETA chains into tracks, the engine derives whole-route positions
 * from the operator timetable (Speed + Time = Position, with traffic speed)
 * and uses the 3 live ETAs at the selected stop only as re-anchors.
 *
 * Loading is lazy + cached: only the agency file for a drawn route is
 * fetched, once per session. Any failure resolves to null — the engine
 * degrades to ETA-anchored synthetic buses instead of throwing.
 *
 * File layout (public/data/bus-schedules/<agency>.json):
 *   { v, updated_at, stops: [[lonE5, latE5], ...], svc: [...], routes }
 *   svc row: [dayMask, [addedDayNums], [removedDayNums], startDayNum, endDayNum]
 *     dayMask bit k = JS weekday k (0=Sun..6=Sat); dayNum = days since epoch;
 *     start/end day bounds from the calendar.txt validity window.
 *   pattern row: [[stopIdx, offsetSec, dirNum], ...] — offsets in seconds from
 *     the trip's first departure; dirNum is the GTFS direction_id (0|1).
 *   fixed trips: [patIdx, startSec, svcIdx] — startSec = first-departure
 *     seconds-of-day (may exceed 86400 for overnight trips).
 *   frequency trips: [patIdx, startSec, endSec, headwaySec, svcIdx] —
 *     departures at startSec + k·headwaySec ≤ endSec (exact headways).
 */

const HKT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400000;

const BASE = () =>
  new URL(`${import.meta.env.BASE_URL}data/bus-schedules/`, window.location.href)
    .href;

/** @type {Map<string, Promise<any>>} */
const cache = new Map();

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal, cache: "no-cache" });
  if (!res.ok) throw new Error(`bus-schedules ${res.status} ${url}`);
  try {
    return await res.json();
  } catch (e) {
    // Truncated/corrupt cached body (HTTP cache or SW) — retry once uncached.
    console.warn("[bus-schedules] json parse failed, retrying uncached", url, e);
    const res2 = await fetch(url, { signal, cache: "reload" });
    if (!res2.ok) throw new Error(`bus-schedules ${res2.status} ${url}`);
    return res2.json();
  }
}

/**
 * Load one operator's schedule file, cached per session.
 * @param {string} co "kmb" | "ctb" | "nlb"
 * @param {AbortSignal} [signal]
 * @returns {Promise<any|null>} null on any failure (engine degrades).
 */
export async function loadOperatorSchedules(co, signal) {
  const url = `${BASE()}${String(co || "").toLowerCase()}.json`;
  if (!cache.has(url)) {
    cache.set(
      url,
      fetchJson(url, signal).catch((e) => {
        cache.delete(url);
        console.warn("[bus-schedules] load failed", url, e?.message || e);
        return null;
      }),
    );
  }
  return cache.get(url);
}

/**
 * Current time in Hong Kong (fixed UTC+8 — no DST). dayNum = days since
 * epoch, weekday = JS convention (0=Sun..6=Sat).
 * @param {number} [now] epoch ms
 */
export function hktNow(now = Date.now()) {
  const hktMs = now + HKT_OFFSET_MS;
  const dayNum = Math.floor(hktMs / DAY_MS);
  const secOfDay = Math.floor((hktMs % DAY_MS) / 1000);
  const date = new Date(dayNum * DAY_MS);
  return {
    dayNum,
    secOfDay,
    dateStr: `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`,
    weekday: (dayNum + 4) % 7, // 1970-01-01 was a Thursday (JS day 4)
  };
}

/** Binary search for a day in a sorted dayNum array. */
function hasDay(sortedDays, dayNum) {
  if (!sortedDays?.length) return false;
  let lo = 0;
  let hi = sortedDays.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDays[mid] === dayNum) return true;
    if (sortedDays[mid] < dayNum) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Is the service active on the given day? Day-mask bit (Sun..Sat), calendar
 * validity window, plus added/removed exceptions (added wins over a cleared
 * mask bit; removed wins over a set one).
 * @param {Array} svc [dayMask, added, removed, startDay, endDay]
 * @param {number} dayNum days since epoch
 * @param {number} weekday JS weekday (0=Sun..6=Sat)
 */
export function serviceActive(svc, dayNum, weekday) {
  if (!Array.isArray(svc)) return false;
  const start = svc[3];
  const end = svc[4];
  if (Number.isFinite(start) && dayNum < start) return false;
  if (Number.isFinite(end) && dayNum > end) return false;
  const inAdded = hasDay(svc[1], dayNum);
  if (inAdded && !hasDay(svc[2], dayNum)) return true;
  return (svc[0] & (1 << weekday)) !== 0 && !hasDay(svc[2], dayNum);
}

/**
 * All trips of a route/direction that are running right now, enumerated for
 * today AND yesterday (yesterday covers trips that departed before midnight
 * and are still on the road). A trip is active iff
 * startEpoch ≤ now ≤ startEpoch + tripLenSec.
 * @param {any} schedules loaded agency file
 * @param {string} routeId raw GTFS route id, e.g. "KMB-1"
 * @param {string|number} dir GTFS direction_id "0" | "1"
 * @param {number} [nowEpoch] epoch ms
 * @returns {Array<{ id: string, patIdx: number, startEpoch: number, lenSec: number, offsetsSec: Array<Array<number>> }>}
 *   sorted by startEpoch ascending (soonest first); id is stable per trip/day.
 */
export function enumerateTrips(schedules, routeId, dir, nowEpoch = Date.now()) {
  const route = schedules?.routes?.[String(routeId)];
  if (!route?.p?.length) return [];
  const dirNum = dir == null ? null : Number(dir);
  const h = hktNow(nowEpoch);
  /** @type {Array<{ id: string, patIdx: number, startEpoch: number, lenSec: number, offsetsSec: any }>} */
  const out = [];
  const active = (patIdx, startEpoch, lenSec, id) => {
    if (nowEpoch < startEpoch || nowEpoch > startEpoch + lenSec * 1000) return;
    out.push({ id, patIdx, startEpoch, lenSec, offsetsSec: route.p[patIdx] });
  };
  for (const dayOffset of [0, -1]) {
    const dayNum = h.dayNum + dayOffset;
    const weekday = (dayNum + 4) % 7;
    for (let ti = 0; ti < (route.t?.length || 0); ti++) {
      const t = route.t[ti];
      const pat = route.p[t[0]];
      if (!pat?.length) continue;
      if (dirNum != null && Number(pat[0][2]) !== dirNum) continue;
      if (!serviceActive(schedules.svc?.[t[2]], dayNum, weekday)) continue;
      const startEpoch = dayNum * DAY_MS - HKT_OFFSET_MS + t[1] * 1000;
      active(
        t[0],
        startEpoch,
        pat[pat.length - 1][1],
        `t:${t[0]}:${t[1]}:${t[2]}:${dayNum}`,
      );
    }
    for (let fi = 0; fi < (route.f?.length || 0); fi++) {
      const f = route.f[fi];
      const pat = route.p[f[0]];
      if (!pat?.length) continue;
      if (dirNum != null && Number(pat[0][2]) !== dirNum) continue;
      if (!serviceActive(schedules.svc?.[f[4]], dayNum, weekday)) continue;
      const lenSec = pat[pat.length - 1][1];
      // Exact headways: departures at start + k·headway ≤ end.
      const kMax = Math.floor((f[2] - f[1]) / Math.max(1, f[3]));
      for (let k = 0; k <= kMax; k++) {
        const startSec = f[1] + k * f[3];
        const startEpoch = dayNum * DAY_MS - HKT_OFFSET_MS + startSec * 1000;
        active(
          f[0],
          startEpoch,
          lenSec,
          `f:${f[0]}:${f[1]}:${f[4]}:${k}:${dayNum}`,
        );
      }
    }
  }
  out.sort((a, b) => a.startEpoch - b.startEpoch);
  return out;
}

/** Last departure in a frequency band (GTFS: last start ≤ end). */
function lastDepartSec(startSec, endSec, headwaySec) {
  const hw = Math.max(1, Number(headwaySec) || 1);
  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return start;
  return start + Math.floor((end - start) / hw) * hw;
}

function patternKind(pat) {
  if (!pat?.length) return "oneway";
  return Number(pat[0][0]) === Number(pat[pat.length - 1][0]) ? "loop" : "oneway";
}

/**
 * Frequency + hourly cap + last departure for timetable predictions.
 * `hint.kind` "loop" | "oneway" picks S64C-style AM circular vs PM inbound
 * when both GTFS patterns share direction_id 0.
 *
 * @param {any} schedules
 * @param {string} routeId e.g. "KMB-S64C"
 * @param {string|number|null} dir "0"|"1"|"O"|"I"|null
 * @param {number} [nowEpoch]
 * @param {{ kind?: "loop"|"oneway" }} [hint]
 * @returns {{
 *   firstMins: number,
 *   lastMins: number,
 *   headwayMins: number,
 *   maxPerHour: number,
 *   inService: boolean,
 *   overnight: boolean,
 * } | null}
 */
export function scheduleServiceWindow(
  schedules,
  routeId,
  dir,
  nowEpoch = Date.now(),
  hint = {},
) {
  const route = schedules?.routes?.[String(routeId)];
  if (!route?.p?.length) return null;
  const rawDir = dir == null || dir === "" ? null : String(dir).toUpperCase();
  const dirNum =
    rawDir == null
      ? null
      : rawDir === "I" || rawDir === "1" || rawDir === "INBOUND"
        ? 1
        : rawDir === "O" || rawDir === "0" || rawDir === "OUTBOUND"
          ? 0
          : Number.isFinite(Number(rawDir))
            ? Number(rawDir)
            : null;
  const wantKind = hint.kind === "loop" || hint.kind === "oneway" ? hint.kind : null;
  const h = hktNow(nowEpoch);
  const hasDir =
    dirNum != null &&
    (route.p || []).some((p) => p?.length && Number(p[0][2]) === dirNum);

  const keepPat = (pat) => {
    if (!pat?.length) return false;
    const pDir = Number(pat[0][2]);
    const kind = patternKind(pat);
    if (wantKind === "loop") return kind === "loop";
    if (wantKind === "oneway" && kind === "loop") return false;
    if (hasDir && dirNum != null && pDir !== dirNum) return false;
    return true;
  };

  /** @type {Array<{ start: number, last: number, hw: number }>} */
  const bands = [];
  for (const f of route.f || []) {
    const pat = route.p[f[0]];
    if (!keepPat(pat)) continue;
    if (!serviceActive(schedules.svc?.[f[4]], h.dayNum, h.weekday)) continue;
    const hw = Math.max(1, Number(f[3]) || 1);
    bands.push({
      start: Number(f[1]),
      last: lastDepartSec(f[1], f[2], hw),
      hw,
    });
  }
  for (const t of route.t || []) {
    const pat = route.p[t[0]];
    if (!keepPat(pat)) continue;
    if (!serviceActive(schedules.svc?.[t[2]], h.dayNum, h.weekday)) continue;
    const start = Number(t[1]);
    if (!Number.isFinite(start)) continue;
    bands.push({ start, last: start, hw: 0 });
  }
  if (!bands.length) return null;
  bands.sort((a, b) => a.start - b.start);
  const firstSec = bands[0].start;
  const lastSec = Math.max(...bands.map((b) => b.last));
  const nowSec = h.secOfDay;
  // Current band, else the next one later today (for headway of upcoming trips).
  let cur =
    bands.find((b) => nowSec >= b.start - 60 && nowSec <= b.last + 120) ||
    bands.find((b) => b.start >= nowSec) ||
    bands[bands.length - 1];
  const hw = cur.hw > 0 ? cur.hw : (() => {
    const withHw = bands.filter((b) => b.hw > 0);
    return withHw.length ? Math.min(...withHw.map((b) => b.hw)) : 12 * 60;
  })();
  const maxPerHour = Math.max(1, Math.round(3600 / hw));
  const inService = bands.some(
    (b) => nowSec >= b.start - 60 && nowSec <= b.last + 120,
  );
  return {
    firstMins: firstSec / 60,
    lastMins: lastSec / 60,
    headwayMins: Math.max(2, Math.round(hw / 60)),
    maxPerHour,
    inService,
    overnight: lastSec >= 24 * 3600 || firstSec >= 22 * 3600,
  };
}

function scheduleDirNum(dir) {
  const rawDir = dir == null || dir === "" ? null : String(dir).toUpperCase();
  if (rawDir == null) return null;
  if (rawDir === "I" || rawDir === "1" || rawDir === "INBOUND") return 1;
  if (rawDir === "O" || rawDir === "0" || rawDir === "OUTBOUND") return 0;
  return Number.isFinite(Number(rawDir)) ? Number(rawDir) : null;
}

/**
 * Stop coordinates for one schedule pattern (AM loop vs PM inbound).
 * The shapes pack only stores one `st` sequence (S64C circular); this reads
 * the matching GTFS pattern so Switch Departure can swap the stop list.
 *
 * @param {any} schedules
 * @param {string} routeId e.g. "KMB-S64C"
 * @param {string|number|null} dir
 * @param {{ kind?: "loop"|"oneway" }} [hint]
 * @returns {Array<{ seq: number, lon: number, lat: number }>}
 */
export function schedulePatternStops(schedules, routeId, dir, hint = {}) {
  const route = schedules?.routes?.[String(routeId)];
  if (!route?.p?.length) return [];
  const dirNum = scheduleDirNum(dir);
  const wantKind = hint.kind === "loop" || hint.kind === "oneway" ? hint.kind : null;
  const hasDir =
    dirNum != null &&
    (route.p || []).some((p) => p?.length && Number(p[0][2]) === dirNum);

  let best = null;
  for (const pat of route.p) {
    if (!pat?.length) continue;
    const pDir = Number(pat[0][2]);
    const kind = patternKind(pat);
    if (wantKind === "loop") {
      if (kind !== "loop") continue;
    } else if (wantKind === "oneway") {
      if (kind === "loop") continue;
      if (hasDir && dirNum != null && pDir !== dirNum) continue;
    } else if (hasDir && dirNum != null && pDir !== dirNum) {
      continue;
    }
    if (!best || pat.length > best.length) best = pat;
  }
  if (!best) return [];
  const out = [];
  for (let i = 0; i < best.length; i++) {
    const st = schedules.stops?.[best[i][0]];
    if (!st || st.length < 2) continue;
    const lon = Number(st[0]) / 1e5;
    const lat = Number(st[1]) / 1e5;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({ seq: i + 1, lon, lat });
  }
  return out;
}
