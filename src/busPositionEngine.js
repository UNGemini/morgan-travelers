/**
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 UNLOOP MORGAN
 *
 * Live Position Engine — licensed under the GNU General Public License v3.0
 * only. See licenses/GPL-3.0.txt. The rest of MORGAN Travelers is Apache-2.0.
 *
 * Live Bus Position Engine (PRD 4.2 v2) — schedule-based whole-route tracking.
 * ETA remaining-time walk (Now + 35 s slack, 30 s hop floor) places markers
 * from the board stop; MTR/LRT use the same walk on rail geometry (no GTFS).
 * Bus hops speed up toward natural travel when the floored min-hop sum
 * exceeds remaining ETA, and schedule-only ghosts closer than ~½ the route's
 * max frequency (tightest GTFS/ETA headway) are dropped.
 *
 * Positioning stays Speed + Time = Position: traffic speed (trafficSpeed.js,
 * unchanged) × time from a known reference. The time source is now the GTFS
 * schedule for the whole route (busSchedules.js) instead of stitched ETA
 * chains, with the 3 live ETAs at the selected stop re-anchoring the next 3
 * buses:
 *
 *   1. Schedule pass — every active trip of the route/direction is placed by
 *      bracket interpolation between its pattern's stop offsets, scaled by
 *      the traffic multiplier of the current segment. Trips whose scheduled
 *      arrival at the board stop lies inside the feed's verified horizon but
 *      match no feed row are dropped: TD's headway data is a band model, not
 *      the operators' exact timetable, so an unverified trip is a model
 *      artifact rather than a real bus (a real bus that close would have a
 *      feed row).
 *   2. ETA anchoring — up to 3 future ETAs at the board stop match the trip
 *      whose scheduled arrival there is closest (≤ 15 min); matched trips are
 *      placed at the schedule position shifted by their deviation (ETA −
 *      scheduled arrival at that stop) — the position whose remaining
 *      path-time to the stop equals the ETA, so the marker follows the road
 *      at segment speeds instead of homing in a straight line at one
 *      constant speed (a linear stop − seconds × speed model made markers
 *      zoom/stutter whenever the constraint re-anchored at another stop).
 *      Unmatched ETAs become synthetic vehicles (id synth:{rank}).
 *   3. Arrival — when a matched ETA expires the trip is at the stop: the
 *      engine holds it there while the operator feed still lists the bus
 *      (the ETA card's "Now" lives exactly as long as the row does — the
 *      marker stays at the stop until "Now" expires), at least DWELL_S and
 *      at most DWELL_MAX_S, then continues on the schedule shifted by the
 *      observed deviation + actual dwell, so an arriving bus stops at the
 *      stop instead of snapping past it (minute-rounded ETAs are up to
 *      ±60 s off the scheduled arrival, so a plain revert would skip the
 *      stop on fast segments). The continuation runs until the shifted
 *      clock reaches the terminus, and with fetch-more the trip's own row
 *      at the next stop re-anchors it (stop − seconds × speed) as usual.
 *      With fetch-more the hold also ends early when the next stop's ETA
 *      demands it: the bus departs before its own "Now" expires — right
 *      away when the next stop's ETA already reads "Now", otherwise once
 *      the remaining ETA equals the speed-map travel time to that stop —
 *      and travels the segment at speed-map speeds instead of lingering
 *      at the old stop or teleporting to the new one.
 *   4. Handoff — the anchored set is always the 3 soonest arrivals at the
 *      board stop: ETA-matched trips use their ETA while future, otherwise
 *      the next-soonest trip (the "4th bus", feeds cap at 3 arrivals) is
 *      anchored by its scheduled arrival.
 *
 * Multi-stop anchoring (fetch-more option + passive reuse):
 *   - With ctx.fetchMore the poll also fetches ETA rows for the nearest stops
 *     and every 5th stop ahead and behind the board stop; each stop's rows
 *     match trips by their scheduled arrival AT THAT STOP, and the soonest
 *     constraint per trip anchors it at `stop − seconds × speed`. Extra
 *     anchored trips beyond the board-stop slots cap at EXTRA_ANCHORS.
 *   - With or without fetchMore, cached rows the ETA panel fetched for other
 *     window stops (e.g. the stop selected before a switch) are reused, so
 *     switching the board stop re-anchors the same trips instead of jumping.
 *
 * The engine is purely additive: it imports from existing modules and never
 * modifies them. Kalman1D is gone — the schedule model is deterministic and
 * the eased-glide animation in main.js smooths re-anchors between polls.
 * Diagnostics use the [buspos] tag (AGENTS.md).
 */

import { fetchTrafficSpeed } from "./trafficSpeed.js";
import { projectOntoShape } from "./routeShapes.js";
import {
  loadOperatorSchedules,
  enumerateTrips,
} from "./busSchedules.js";

/** Typical bus speed for synthetic/fallback anchoring (m/s, ~30 km/h). */
const V_TYP = 8.3;
/**
 * Extra seconds after a minute-rounded "Now" before the marker is treated
 * as at the stop (traffic lights). Inside the 25–45 s band.
 */
const NOW_SLACK_S = 35;
const NOW_SLACK_MS = NOW_SLACK_S * 1000;
/** Floor on estimated travel time between consecutive stops (walk-back). */
const MIN_HOP_S = 30;
/**
 * Drop a schedule-only marker if it sits closer than this fraction of the
 * route's tightest headway to a kept vehicle (ghost from a lagging hop).
 */
const GHOST_HEADWAY_FRAC = 0.45;
/** Plausible headway window (s) — below this is bunching, above is a gap. */
const HEADWAY_MIN_S = 90;
const HEADWAY_MAX_S = 40 * 60;
/** Along-track gap between two markers after walkback (metres). */
const CLUMP_MIN_M = 15;
/**
 * Max simultaneously emitted vehicles. Anchored buses and tracked buses
 * (mid-continuation after an arrival dwell) always emit; the cap applies to
 * the untracked schedule buses, so a bus never blinks out after stopping.
 */
const MAX_VEHICLES = 48;
/** ETA anchor slots at the selected stop (operator feeds cap at 3). */
const ANCHOR_SLOTS = 3;
/** Extra anchored trips from other stops' ETAs (ahead/behind the board). */
const EXTRA_ANCHORS = 16;
/** A pattern stop is the "board stop" only within this distance (m). */
const BOARD_MATCH_TOL_M = 300;
/** ETA ↔ scheduled-arrival matching tolerance at the board stop. */
const ETA_MATCH_TOL_MS = 15 * 60_000;
/** Seconds a bus stays at a stop after its ETA expires (arrival simulation). */
/**
 * Stop dwell, seconds. The marker holds at the stop at least this long after
 * a matched ETA expires (the feed drops the row at arrival, so the stop
 * would be skipped without it), and beyond that while the operator feed
 * still lists the bus — see rowStillListed and the DWELL_MAX_S cap.
 */
const DWELL_S = 30;
const DWELL_MS = DWELL_S * 1000;
/**
 * Upper bound for the feed-listed dwell (s): the marker never sits at the
 * stop longer than this, even if the feed keeps the row (stale rows / edge
 * cases). Also bounds the continuation shift used by activeTrips.
 */
const DWELL_MAX_S = 120;
const DWELL_MAX_MS = DWELL_MAX_S * 1000;
/**
 * Rows whose published ETA is up to this far in the past are buses AT the
 * stop (minute-rounded "Now" rows live while the bus stands there). Kept
 * briefly so a "Now" row anchors the marker at the stop instead of dropping
 * the trip to the schedule — or worse, letting a neighboring bus's row at an
 * upstream stop hijack it (fetch-more polls upstream stops first).
 */
const AT_STOP_WINDOW_MS = 2 * 60_000;
/** Max projection distance for a schedule stop onto the drawn shape (m). */
const PROJECT_TOL_M = 400;
/**
 * Slack added to the board feed's latest row when the feed returned fewer
 * than 3 rows (a sparse feed lists every real bus, so the horizon is exact).
 * Covers headway-model jitter — see the phantom guard in computePositions.
 */
const PHANTOM_SLACK_MS = 20 * 60_000;

const CONF_ETA = 1; // ETA-anchored (incl. synthetic)
const CONF_SCHED = 0.85; // schedule + traffic
const CONF_NO_TRAFFIC = 0.75; // schedule, traffic index unavailable

/**
 * Map an along-shape distance back to lon/lat on the polyline.
 * @param {Array<{ lon: number, lat: number }>} coords
 * @param {number[]} cumM
 * @param {number} s metres along shape (clamped to [0, total])
 * @returns {{ lon: number, lat: number } | null}
 */
export function alongToLonLat(coords, cumM, s) {
  if (!coords?.length || !cumM?.length) return null;
  const total = cumM[cumM.length - 1] || 0;
  const target = Math.max(0, Math.min(s, total));
  if (target <= 0) return { lon: coords[0].lon, lat: coords[0].lat };
  if (target >= total) {
    const last = coords[coords.length - 1];
    return { lon: last.lon, lat: last.lat };
  }
  let i = 0;
  while (i < cumM.length - 2 && cumM[i + 1] < target) i += 1;
  const a = coords[i];
  const b = coords[i + 1];
  const segLen = Math.max(1e-6, (cumM[i + 1] ?? cumM[i]) - cumM[i]);
  const f = (target - cumM[i]) / segLen;
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f };
}

/** Stable int32 hash of a vehicle id string (main.js keys DOM entries by number).
 * Exported for the sim harness to map a trip id back to its emitted vehicle. */
export function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

/**
 * Joint KMB+CTB (and LWB 9xx) cross-harbour route numbers. Island vs Kowloon
 * stops flip the operator code; live-pos identity must not.
 */
const JOINT_HARBOUR_ROUTES = new Set(
  [
    101, 102, 103, 104, 106, 107, 109, 110, 111, 112, 113, 115, 116, 117, 118,
    170, 171, 182, 307, 373, 601, 603, 606, 608, 613, 619, 671, 673, 678, 680,
    681, 682, 690, 694, 914, 930, 934, 935, 936, 948, 960, 961, 962, 967, 968,
    969, 978, 980, 981, 982, 985,
  ].flatMap((n) => {
    const s = String(n);
    return [s, `${s}A`, `${s}B`, `${s}P`, `${s}S`, `${s}X`, `N${s}`];
  }),
);

/** @param {string} routeId */
export function isJointHarbourRoute(routeId) {
  const raw = String(routeId || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (raw === "S1" || raw === "NS1") return true;
  if (JOINT_HARBOUR_ROUTES.has(raw)) return true;
  const stripped = raw.replace(/[APXS]$/, "");
  return JOINT_HARBOUR_ROUTES.has(stripped);
}

/**
 * Operator key for engine identity (cheap sig / vehicle ids). Joint harbour
 * routes share one engine across KMB↔CTB stop flips.
 * @param {string} co
 * @param {string} routeId
 */
export function canonicalLivePosOp(co, routeId) {
  const c = String(co || "").toLowerCase();
  if (
    (c === "kmb" || c === "ctb" || c === "lwb") &&
    isJointHarbourRoute(routeId)
  ) {
    return "joint";
  }
  return c || "kmb";
}

/** Seconds still to go until we treat the ETA as physically at the stop. */
function remainingSec(etaT, now) {
  return Math.max(0, (etaT + NOW_SLACK_MS - now) / 1000);
}

/** Default per-operator ETA row fetcher (browser; lazy eta.js import).
 * 1. Reuses the ETA panel's just-fetched rows when fresh (one fetch drives
 *    both panel and engine — the panel strips operator prefixes, so this
 *    also never hits the prefixed-id empty-feed bug).
 * 2. On a cache miss (first poll racing the panel, or stale) fetches itself,
 *    always with the operator prefix STRIPPED — KMB/CTB/NLB APIs reject
 *    prefixed stop ids with empty data, which used to starve the anchors. */
async function defaultFetchRows(ctx, stop) {
  const { fetchJson, getRawEtaRows, stripOperatorStopId } = await import("./eta.js");
  const op = String(ctx.op || "").toLowerCase();
  if (op !== "mtr" && op !== "lrt") {
    const cached = getRawEtaRows(op, ctx.routeShort, ctx.serviceType, stop.stopId);
    if (cached) return cached;
  }
  const sid = stripOperatorStopId(stop.stopId) || String(stop.stopId || "");
  if (!sid && op !== "mtr" && op !== "lrt") return [];
  if (op === "kmb") {
    const data = await fetchJson(
      `/eta/kmb/eta/${encodeURIComponent(sid)}/${encodeURIComponent(ctx.routeShort)}/${encodeURIComponent(ctx.serviceType || 1)}`,
    );
    return Array.isArray(data?.data) ? data.data : [];
  }
  if (op === "ctb") {
    const data = await fetchJson(
      `/eta/ctb/eta/CTB/${encodeURIComponent(sid)}/${encodeURIComponent(ctx.routeShort)}`,
    );
    return Array.isArray(data?.data) ? data.data : [];
  }
  if (op === "nlb") {
    const routeIds = ctx.nlbRouteIds?.length ? ctx.nlbRouteIds : [ctx.routeId];
    for (const rid of routeIds) {
      if (!rid) continue;
      const data = await fetchJson(
        `/eta/nlb/stop.php?action=estimatedArrivals&routeId=${encodeURIComponent(rid)}&stopId=${encodeURIComponent(sid)}&language=en`,
      );
      const rows = Array.isArray(data?.estimatedArrivals)
        ? data.estimatedArrivals
        : Array.isArray(data?.data)
          ? data.data
          : [];
      if (rows.length) return rows;
    }
    return [];
  }
  if (op === "mtr") {
    const line = String(ctx.routeShort || "");
    const sta = sid || stripOperatorStopId(stop.stopId) || "";
    if (!line || !sta) return [];
    const data = await fetchJson(
      `/eta/mtr/getSchedule.php?line=${encodeURIComponent(line)}&sta=${encodeURIComponent(sta)}`,
    );
    const key = `${line}-${sta}`;
    const block = data?.data?.[key] || data?.data?.[sta] || {};
    const bound = String(ctx.bound || "O").toUpperCase();
    const dirKey = bound === "I" ? "DOWN" : "UP";
    const primary = Array.isArray(block[dirKey]) ? block[dirKey] : [];
    const trains = primary.length
      ? primary
      : [...(block.UP || []), ...(block.DOWN || [])];
    const now = Date.now();
    return (trains || []).map((t) => {
      const wait = Number(t.ttnt);
      const etaMs = Number.isFinite(wait)
        ? now + Math.max(0, wait) * 60_000
        : now;
      return { eta: new Date(etaMs).toISOString(), dest_en: t.dest || "" };
    });
  }
  if (op === "lrt") {
    const data = await fetchJson(
      `/eta/mtr/lrt/getSchedule?station_id=${encodeURIComponent(sid)}`,
    );
    const platforms = Array.isArray(data?.platform_list)
      ? data.platform_list
      : [];
    const now = Date.now();
    const route = String(ctx.routeShort || "").toUpperCase();
    const rows = [];
    for (const p of platforms) {
      for (const r of p.route_list || []) {
        const rno = String(r.route_no || r.routeNo || "").toUpperCase();
        if (route && rno && rno !== route && route !== "LRT") continue;
        const timeEn = String(r.time_en || r.time_ch || "").trim();
        let waitMins = null;
        if (/arriving|departing|即將|正在|^-$/i.test(timeEn) || timeEn === "-") {
          waitMins = 0;
        } else {
          const m = /(\d+)\s*min/i.exec(timeEn);
          if (m) waitMins = Number(m[1]);
        }
        if (waitMins == null && r.time_min != null) {
          waitMins = Math.max(0, Number(r.time_min));
        }
        if (waitMins == null) continue;
        rows.push({
          eta: new Date(now + waitMins * 60_000).toISOString(),
          dest_en: r.dest_en || r.dest_ch || "",
          dir: ctx.bound,
        });
      }
    }
    return rows;
  }
  return [];
}

/** Cache-only row lookup for non-board stops (no network; used when the
 * fetch-more option is off — reuse what the ETA panel already fetched). */
async function defaultPeekCached(ctx, stop) {
  const { getRawEtaRows } = await import("./eta.js");
  return getRawEtaRows(ctx.op, ctx.routeShort, ctx.serviceType, stop.stopId);
}

/** Filter + normalize raw operator rows for one stop. */
function normalizeRows(op, rows, bound, now = Date.now()) {
  const out = [];
  for (const r of rows) {
    if (r?.departed === 1 || r?.departed === true) continue;
    const iso = r?.eta || r?.estimatedArrivalTime || r?.estimatedArrival;
    const t = iso ? Date.parse(iso) : NaN;
    // Rows up to AT_STOP_WINDOW_MS in the past are buses standing at the
    // stop (minute-rounded "Now" rows) — kept so the marker holds there;
    // anything older is a stale row.
    if (!Number.isFinite(t) || t <= now - AT_STOP_WINDOW_MS) continue;
    if (bound && r?.dir && String(r.dir).toUpperCase() !== bound) continue;
    out.push({
      t,
      dest: String(r?.dest_en || r?.dest_tc || r?.routeVariantName || ""),
      seq: Number(r?.seq ?? r?.stopSeq ?? r?.routeSeq ?? NaN),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Client-side live bus position engine for one route/direction.
 * main.js owns the timers (Pulse/Baseline/Instant Sync, all visibility-gated);
 * the engine just fetches on demand, computes, and emits marker payloads.
 */
export class BusPositionEngine {
  /**
   * @param {object} opts
   * @param {(evt: { vehicles: Array<{ id: number, lon: number, lat: number, label: string, confidence: number, coasting: boolean }> }) => void} [opts.onUpdate]
   * @param {(ctx: any, stop: { stopId: string, seq: number }) => Promise<any[]>} [opts.fetchRows]
   * @param {(ctx: any, stop: { stopId: string, seq: number }) => Promise<any[]>} [opts.peekCached] harness injection (default: eta.js raw cache)
   * @param {(co: string) => Promise<any|null>} [opts.loadSchedules] harness injection (default: browser fetch)
   * @param {() => Promise<any|null>} [opts.loadTraffic] harness injection (default: fetchTrafficSpeed)
   * @param {() => number} [opts.nowFn] clock injection for the sim harness (default: Date.now)
   */
  constructor(opts = {}) {
    this.onUpdate = opts.onUpdate || (() => {});
    this.fetchRows = opts.fetchRows || defaultFetchRows;
    this.peekCached = opts.peekCached || defaultPeekCached;
    this.loadSchedules = opts.loadSchedules || loadOperatorSchedules;
    this.loadTraffic = opts.loadTraffic || fetchTrafficSpeed;
    this.nowFn = opts.nowFn || Date.now;
    this.ctx = null;
    this.running = false;
    /** @type {Map<string, number>} trip id → ETA time from the last poll */
    this.etaMap = new Map();
    /** @type {Map<string, Array<{ stopIdx: number, etaT: number, d: number }>}>} trip id → every matched row this poll (ascending stop order) — the early-departure rules need the next stop's ETA, not just the soonest constraint */
    this.tripEtas = new Map();
    /** @type {Map<string, { etaT: number, d: number, stopIdx: number }>} trip id → soonest ETA constraint across all anchor stops */
    this.constraints = new Map();
    /** @type {Array<{ rank: number, etaT: number, dest: string, arrD: number, arrAt: number }>} unmatched ETAs (synth buses) */
    this.synth = [];
    /** @type {Map<string, { delaySec: number, arrD: number, arrAt: number, stopIdx: number, dwellEnd?: number }>} trip id → arrival bookkeeping (see updateTripState) */
    this.tripState = new Map();
    /** @type {Map<number, Array<any>>} stop index → raw (unnormalized) feed rows from the last poll — the dwell-release signal */
    this.rawRowsByStop = new Map();
    /** @type {Map<number, { distsM: number[], pat: any, boardIdx: number, boardMatchM: number, boardOffSec: number }>} */
    this.patternDists = new Map();
    this.schedules = null;
    this.trafficIndex = null;
    this.lastEmit = null;
    this.lastTickMs = 0;
    this.initPromise = null;
    this.hasPolled = false;
    /** Latest board-stop feed row's ETA (ms ahead of now) + slack; 0 = unverifiable */
    this.boardHorizonMs = 0;
    /** Tightest GTFS headway for this route/direction (s); 0 = unknown. */
    this.gtfsHeadwaySec = 0;
    /** Effective max frequency (min GTFS / live ETA headway) used for ghosts. */
    this.headwaySec = 0;
  }

  /**
   * @param {{ op: string, routeId: string, routeShort: string, bound: string, serviceType?: number, stops: Array<{ stopId: string, seq: number, lon: number, lat: number }>, boardStopIndex: number, shape: { coords: Array<{ lon: number, lat: number }>, cumM: number[] }, stopDistM: number[], nlbRouteIds?: string[], fetchMore?: boolean }} ctx
   */
  start(ctx) {
    this.stop();
    if (!ctx?.shape?.coords?.length || !ctx.stopDistM?.length) {
      console.warn("[buspos] start skipped: no shape/stop geometry");
      return;
    }
    this.ctx = ctx;
    this.running = true;
    this.hasPolled = false;
    this.lastTickMs = this.nowFn();
    // Schedule lookup key + GTFS direction: same mapping the shape loader uses
    // (ctx.routeId is the short name; bound O/I maps to direction_id 0/1).
    const schedOp =
      canonicalLivePosOp(ctx.op, ctx.routeId) === "joint"
        ? "KMB"
        : String(ctx.op || "").toUpperCase();
    this.routeKey = `${schedOp}-${ctx.routeId}`;
    this.dir =
      ctx.bound === "I" ? "1" : ctx.bound === "O" ? "0" : null;
    console.info(
      "[buspos] engine started",
      ctx.op,
      ctx.routeShort,
      ctx.bound,
      "window → schedule",
      this.routeKey,
    );
    this.initPromise = this.init().catch((e) => {
      console.warn("[buspos] init failed, ETA-synth only", e?.message || e);
      this.schedules = null;
    });
  }

  stop() {
    this.running = false;
    this.ctx = null;
    this.schedules = null;
    this.patternDists.clear();
    this.etaMap.clear();
    this.constraints.clear();
    this.synth = [];
    this.tripState.clear();
    this.trafficIndex = null;
    this.lastEmit = null;
    this.initPromise = null;
    this.boardHorizonMs = 0;
    this.gtfsHeadwaySec = 0;
    this.headwaySec = 0;
    this.rawRowsByStop.clear();
    this.tripEtas.clear();
    this.hasPolled = false;
  }

  /**
   * Switch board stop (and optional fetch prefix) without resetting trips.
   * Joint harbour KMB↔CTB flips pass a new ctx.op here.
   * @param {{ boardStopIndex?: number, op?: string, stops?: any[], stopDistM?: number[], fetchMore?: boolean, nlbRouteIds?: string[] }} patch
   */
  updateBoard(patch = {}) {
    if (!this.ctx || !this.running) return;
    if (patch.op) this.ctx.op = patch.op;
    if (patch.stops) this.ctx.stops = patch.stops;
    if (patch.stopDistM) this.ctx.stopDistM = patch.stopDistM;
    if (patch.nlbRouteIds) this.ctx.nlbRouteIds = patch.nlbRouteIds;
    if (patch.fetchMore != null) this.ctx.fetchMore = patch.fetchMore;
    if (Number.isInteger(patch.boardStopIndex)) {
      this.ctx.boardStopIndex = patch.boardStopIndex;
    }
    if (patch.shape?.coords?.length >= 2) this.ctx.shape = patch.shape;
    this.syncPatternBoard();
  }

  /** Recompute each pattern's board stop after updateBoard. */
  syncPatternBoard() {
    const ctx = this.ctx;
    const boardDist = ctx?.stopDistM?.[ctx.boardStopIndex];
    for (const pd of this.patternDists.values()) {
      let boardIdx = -1;
      let boardMatchM = Infinity;
      if (Number.isFinite(boardDist)) {
        for (let i = 0; i < pd.distsM.length; i++) {
          const d = Math.abs(pd.distsM[i] - boardDist);
          if (d < boardMatchM) {
            boardMatchM = d;
            boardIdx = i;
          }
        }
      }
      pd.boardIdx = boardIdx;
      pd.boardMatchM = boardMatchM;
      pd.boardOffSec = boardIdx >= 0 ? pd.offsRows[boardIdx][1] : 0;
    }
  }

  /** Natural (unfloored) travel time between two along-track distances. */
  hopDurSec(d0, d1, lon, lat) {
    const dist = Math.abs(d1 - d0);
    const mult =
      this.trafficIndex && Number.isFinite(lon)
        ? this.trafficIndex.multiplierAt(lon, lat)
        : 1;
    return dist / Math.max(0.5, V_TYP * (mult || 1));
  }

  /**
   * Walk backward along ctx.stopDistM from `fromDist` for `remainSec`.
   * Default hop is max(MIN_HOP_S, natural) so close stops don't collapse.
   * If that floored sum exceeds remaining ETA, hops scale down toward
   * natural travel (the marker speeds up) instead of lagging near the stop.
   */
  walkBackFromDist(fromDist, remainSec) {
    const dists = this.ctx?.stopDistM;
    if (!dists?.length || !Number.isFinite(fromDist)) return Math.max(0, fromDist || 0);
    const tRemain = Math.max(0, remainSec);
    if (tRemain <= 0) return Math.max(0, fromDist);
    let i = dists.length - 1;
    while (i > 0 && dists[i] > fromDist + 0.5) i -= 1;
    const hops = [];
    let d = fromDist;
    let accFloor = 0;
    while (i > 0 && accFloor < tRemain) {
      const dPrev = dists[i - 1];
      const dCur = dists[i];
      const stop = this.ctx.stops?.[i];
      const natural = this.hopDurSec(dPrev, dCur, stop?.lon, stop?.lat);
      const floored = Math.max(MIN_HOP_S, natural);
      const span = Math.max(1e-3, dCur - dPrev);
      const fromOnHop =
        hops.length === 0
          ? Math.max(0, Math.min(1, (d - dPrev) / span))
          : 1;
      const floorOnHop = floored * fromOnHop;
      hops.push({ dPrev, span, fromOnHop, natural, floored, floorOnHop });
      accFloor += floorOnHop;
      d = dPrev;
      i -= 1;
    }
    // Speed up when min-hop floors would take longer than the remaining ETA.
    const scale = accFloor > tRemain && accFloor > 0 ? tRemain / accFloor : 1;
    d = fromDist;
    let t = tRemain;
    for (const h of hops) {
      const hop = Math.max(h.natural, h.floored * scale);
      if (hop <= 1e-6) {
        d = h.dPrev;
        continue;
      }
      const timeOnHop = hop * h.fromOnHop;
      if (t >= timeOnHop) {
        t -= timeOnHop;
        d = h.dPrev;
      } else {
        d = h.dPrev + h.span * (h.fromOnHop - t / hop);
        t = 0;
        break;
      }
    }
    return Math.max(0, d);
  }

  /**
   * Along-track spacer: rear vehicle is pushed back so the gap is ≥ CLUMP_MIN_M.
   * Also cap a marker so it cannot sit on/past the next stop while still in slack.
   * @param {Array<{ d: number }>} vehicles
   */
  antiClump(vehicles) {
    const ctx = this.ctx;
    const dists = ctx?.stopDistM || [];
    const boardDist = ctx?.stopDistM?.[ctx.boardStopIndex] ?? Infinity;
    const nextStopDist = (() => {
      const b = ctx?.boardStopIndex ?? -1;
      if (b >= 0 && b + 1 < dists.length) return dists[b + 1];
      return Infinity;
    })();
    const sorted = [...vehicles].filter((v) => Number.isFinite(v.d));
    sorted.sort((a, b) => a.d - b.d);
    for (let i = sorted.length - 1; i > 0; i--) {
      const fwd = sorted[i];
      const rear = sorted[i - 1];
      // Forward = closer to (or past) the board stop
      const a = fwd.d >= rear.d ? fwd : rear;
      const b = a === fwd ? rear : fwd;
      if (a.d - b.d >= CLUMP_MIN_M) continue;
      b.d = Math.max(0, a.d - CLUMP_MIN_M);
      if (i >= 2) b.d = Math.max(sorted[i - 2].d + 0.01, b.d);
    }
    for (const v of vehicles) {
      if (!Number.isFinite(v.d)) continue;
      if (Number.isFinite(nextStopDist) && v.d > boardDist - 0.5) {
        /* at/after board: leave */
      } else if (Number.isFinite(nextStopDist) && v.d >= nextStopDist - CLUMP_MIN_M) {
        v.d = Math.max(0, nextStopDist - CLUMP_MIN_M);
      }
    }
  }

  /**
   * Drop schedule-only (unanchored) markers that sit closer than
   * GHOST_HEADWAY_FRAC × tightest headway to a kept vehicle. Lagging hops
   * pile extras on the next real bus; ETA-anchored / dwelling buses stay
   * even when bunched.
   */
  dropGhostsByHeadway(vehicles) {
    const hw = this.headwaySec;
    if (!(hw >= HEADWAY_MIN_S) || vehicles.length < 2) return;
    const minGapM = hw * GHOST_HEADWAY_FRAC * V_TYP;
    const tracked = (v) => this.tripState.get(v.id)?.arrD >= 0;
    const keepPri = (v) => v.anchored || tracked(v);
    const sorted = vehicles.filter((v) => Number.isFinite(v.d)).sort((a, b) => b.d - a.d);
    const kept = sorted.filter(keepPri);
    const drop = new Set();
    for (const v of sorted) {
      if (keepPri(v)) continue;
      let ghost = false;
      for (const k of kept) {
        if (Math.abs(k.d - v.d) < minGapM) {
          ghost = true;
          break;
        }
      }
      if (ghost) drop.add(v);
      else kept.push(v);
    }
    if (!drop.size) return;
    for (let i = vehicles.length - 1; i >= 0; i--) {
      if (drop.has(vehicles[i])) vehicles.splice(i, 1);
    }
  }

  /** Load schedules (async, cached) + traffic index once at start. */
  async init() {
    const ctx = this.ctx;
    if (!this.running) return;
    const loadCo =
      canonicalLivePosOp(ctx.op, ctx.routeId) === "joint"
        ? "kmb"
        : String(ctx.op || "").toLowerCase();
    if (loadCo === "mtr" || loadCo === "lrt") {
      this.schedules = null;
      return;
    }
    this.schedules = await this.loadSchedules(loadCo);
    if (!this.running || this.ctx !== ctx) return;
    if (!this.schedules) {
      console.warn("[buspos] schedules unavailable — ETA-synth only");
      return;
    }
    this.cachePatterns();
    this.gtfsHeadwaySec = this.computeHeadwaySec();
    this.headwaySec = this.gtfsHeadwaySec;
    if (this.headwaySec) {
      console.info("[buspos] headway", this.routeKey, this.headwaySec, "s");
    }
  }

  /** Tightest gap in [HEADWAY_MIN_S, HEADWAY_MAX_S]; 0 if none. */
  tightestHeadway(diffs) {
    const ok = diffs.filter((d) => d >= HEADWAY_MIN_S && d <= HEADWAY_MAX_S);
    return ok.length ? Math.min(...ok) : 0;
  }

  /**
   * Tightest plausible headway (max frequency) for this route/direction.
   * GTFS frequencies first, else the tightest fixed-trip start gap.
   */
  computeHeadwaySec() {
    const route = this.schedules?.routes?.[this.routeKey];
    if (!route) return 0;
    const dirNum = this.dir == null ? null : Number(this.dir);
    const freq = [];
    for (const f of route.f || []) {
      const pat = route.p?.[f[0]];
      if (!pat?.length) continue;
      if (dirNum != null && Number(pat[0][2]) !== dirNum) continue;
      const hw = Number(f[3]);
      if (Number.isFinite(hw)) freq.push(hw);
    }
    const fromFreq = this.tightestHeadway(freq);
    if (fromFreq) return fromFreq;
    const starts = [];
    for (const t of route.t || []) {
      const pat = route.p?.[t[0]];
      if (!pat?.length) continue;
      if (dirNum != null && Number(pat[0][2]) !== dirNum) continue;
      starts.push(Number(t[1]));
    }
    starts.sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < starts.length; i++) {
      diffs.push(starts[i] - starts[i - 1]);
    }
    return this.tightestHeadway(diffs);
  }

  /**
   * Tighten headway from consecutive board-stop ETAs (live max frequency).
   * Never widens the GTFS value — a sparse 3-row feed is not a timetable.
   */
  observeEtaHeadway(etas) {
    if (!etas || etas.length < 2) return;
    const diffs = [];
    for (let i = 1; i < etas.length; i++) {
      diffs.push((etas[i].t - etas[i - 1].t) / 1000);
    }
    const hw = this.tightestHeadway(diffs);
    if (!hw) return;
    this.headwaySec = this.headwaySec ? Math.min(this.headwaySec, hw) : hw;
  }

  /** Baseline refresh of the traffic index (5-min TTL cache inside). */
  async refreshTraffic() {
    try {
      this.trafficIndex = await this.loadTraffic();
    } catch {
      this.trafficIndex = null;
    }
  }

  /**
   * One-time projection of each direction-matching pattern's stops onto the
   * drawn shape (monotonic searchFrom chaining). Drawn polylines often cut
   * corners across the street grid (stops up to ~900 m off the line), so
   * off-shape outlier stops are dropped per pattern instead of rejecting the
   * whole pattern; a pattern survives if ≥ 2 stops project monotonically
   * within PROJECT_TOL_M. All offsets/dists stay index-aligned to the kept
   * rows (pd.offsRows), never the raw pattern.
   */
  cachePatterns() {
    const ctx = this.ctx;
    const route = this.schedules?.routes?.[this.routeKey];
    if (!route?.p?.length) {
      console.warn("[buspos] no schedule patterns for", this.routeKey);
      return;
    }
    const boardDist = ctx.stopDistM?.[ctx.boardStopIndex];
    const dirNum = this.dir == null ? null : Number(this.dir);
    for (let pi = 0; pi < route.p.length; pi++) {
      const pat = route.p[pi];
      if (!pat?.length) continue;
      if (dirNum != null && Number(pat[0][2]) !== dirNum) continue;
      const rows = []; // kept rows (projected within tolerance)
      const distsM = [];
      let searchFrom = 0;
      let dropped = 0;
      for (const stopRow of pat) {
        const st = this.schedules.stops[stopRow[0]];
        if (!st) {
          dropped += 1;
          continue;
        }
        const p = projectOntoShape(
          ctx.shape.coords,
          st[0] / 1e5,
          st[1] / 1e5,
          searchFrom,
        );
        if (!p || p.d > PROJECT_TOL_M) {
          dropped += 1;
          continue;
        }
        rows.push(stopRow);
        distsM.push(p.alongM);
        searchFrom = p.segEnd;
      }
      if (rows.length < 2) continue;
      let monotonic = true;
      for (let i = 1; i < distsM.length; i++) {
        if (distsM[i] < distsM[i - 1] - 1) {
          monotonic = false;
          break;
        }
      }
      if (!monotonic) continue;
      if (dropped) {
        console.info(
          "[buspos] pattern", pi, "dropped", dropped, "off-shape stops (tol", PROJECT_TOL_M, "m)",
        );
      }
      // Board pattern stop: the pattern stop nearest the board stop distance.
      let boardIdx = -1;
      let boardMatchM = Infinity;
      if (Number.isFinite(boardDist)) {
        for (let i = 0; i < distsM.length; i++) {
          const d = Math.abs(distsM[i] - boardDist);
          if (d < boardMatchM) {
            boardMatchM = d;
            boardIdx = i;
          }
        }
      }
      this.patternDists.set(pi, {
        distsM,
        pat: rows,
        offsRows: rows,
        boardIdx,
        boardMatchM,
        boardOffSec: boardIdx >= 0 ? rows[boardIdx][1] : 0,
      });
    }
    console.info(
      "[buspos] schedule patterns",
      this.routeKey,
      this.patternDists.size,
      "of",
      route.p.length,
    );
  }

  /**
   * Stop indices whose ETA rows anchor the estimate. The board stop is always
   * included; with ctx.fetchMore also the nearest stops (±1, ±2) and every
   * 5th stop (±5, ±10, ±15) on both sides — behind (passed) and ahead
   * (future) along the route.
   */
  anchorStopIndices(ctx) {
    const n = ctx.stops?.length || 0;
    const b = ctx.boardStopIndex;
    if (!Number.isInteger(b) || b < 0 || b >= n) return [];
    const set = new Set([b]);
    const rail = ctx.op === "mtr" || ctx.op === "lrt";
    // Always sample stops AHEAD of the board so vehicles that already
    // passed still get an ETA pin (Next Train / stop ETA at later stops).
    const ahead = Math.max(0, n - 1 - b);
    const aheadStep = rail
      ? ahead > 10
        ? 2
        : 1
      : Math.max(1, Math.ceil(ahead / 8) || 5);
    for (let i = b + 1; i < n; i++) {
      if (i === n - 1 || (i - b) % aheadStep === 0) set.add(i);
    }
    if (ctx.fetchMore) {
      for (const dir of [-1, 1]) {
        for (const step of [1, 2, 5, 10, 15]) {
          const idx = b + dir * step;
          if (idx >= 0 && idx < n) set.add(idx);
        }
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  /** Kept pattern stop nearest an along-shape distance, within BOARD_MATCH_TOL_M. */
  patternIdxForDist(pd, d) {
    let best = -1;
    let bestM = Infinity;
    for (let i = 0; i < pd.distsM.length; i++) {
      const dd = Math.abs(pd.distsM[i] - d);
      if (dd < bestM) {
        bestM = dd;
        best = i;
      }
    }
    return best >= 0 && bestM <= BOARD_MATCH_TOL_M ? { idx: best, matchM: bestM } : null;
  }

  /**
   * One poll: fetch board-stop ETAs (+ fetch-more stops) → match anchors →
   * compute → emit.
   */
  async poll() {
    const ctx = this.ctx;
    if (!this.running || !ctx) return;
    const now = this.nowFn();
    try {
      if (this.initPromise) await this.initPromise;
      if (!this.running || this.ctx !== ctx) return;
      const anchorIdx = this.anchorStopIndices(ctx);
      const stopEtas = new Map(); // stop index → normalized rows
      this.rawRowsByStop.clear(); // raw rows per fetched stop, refreshed each poll
      for (const idx of anchorIdx) {
        const stop = ctx.stops?.[idx];
        if (!stop?.stopId || !Number.isFinite(ctx.stopDistM?.[idx])) continue;
        const rows =
          idx === ctx.boardStopIndex || ctx.fetchMore
            ? await this.fetchRows(ctx, stop)
            : await this.peekCached(ctx, stop);
        if (!rows?.length) continue;
        this.rawRowsByStop.set(idx, rows);
        const norm = normalizeRows(ctx.op, rows, ctx.bound, now);
        if (norm.length) stopEtas.set(idx, norm);
      }
      // Passive reuse over the whole window (fetch-more off): cached rows the
      // ETA panel fetched for other stops — e.g. the stop the user had open
      // before switching — still constrain the trips, so switching the board
      // stop keeps their estimates continuous instead of re-anchoring them.
      if (!ctx.fetchMore) {
        for (let i = 0; i < (ctx.stops?.length || 0); i++) {
          if (stopEtas.has(i)) continue;
          const stop = ctx.stops?.[i];
          if (!stop?.stopId || !Number.isFinite(ctx.stopDistM?.[i])) continue;
          const rows = await this.peekCached(ctx, stop);
          if (!rows?.length) continue;
          this.rawRowsByStop.set(i, rows);
          const norm = normalizeRows(ctx.op, rows, ctx.bound, now);
          if (norm.length) stopEtas.set(i, norm);
        }
      }
      // Verified horizon at the board stop: the latest row's ETA (+ slack when
      // the feed is sparse — every real bus inside it would be listed). The
      // schedule pass hides trips arriving within it that no feed row matched
      // (see the phantom guard in computePositions). Zero when the board feed
      // returned nothing or schedules are unavailable — no suppression.
      this.boardHorizonMs = 0;
      const boardRows = stopEtas.get(ctx.boardStopIndex);
      if (boardRows?.length && this.schedules) {
        const maxRowT = boardRows[boardRows.length - 1].t;
        const slack = boardRows.length >= 3 ? 0 : PHANTOM_SLACK_MS;
        this.boardHorizonMs = Math.max(0, maxRowT - now + slack);
      }
      const rail = ctx.op === "mtr" || ctx.op === "lrt";
      if (!rail) {
        this.headwaySec = this.gtfsHeadwaySec || 0;
        this.observeEtaHeadway(boardRows);
      }
      this.matchAnchors(ctx, stopEtas, now);
      this.hasPolled = true;
      this.computePositions(now);
      this.emit(now);
    } catch (e) {
      console.warn("[buspos] poll failed", e?.message || e);
      this.coast(now);
    }
  }

  /**
   * Greedy ETA → trip matching. Rows are processed STOP BY STOP (not merged):
   * rows at one stop are distinct buses (per-stop matched set, so the board
   * stop's 3-arrival feed maps 1:1 as before), while the same trip may be
   * claimed at several stops — its own rows at downstream stops re-match it
   * and the soonest ETA wins, so the constraint sits at the stop nearest the
   * bus. (A global matched set would cascade: trip A's board row would be
   * reassigned to trip B, whose row then steals trip C.) Unmatched board-stop
   * ETAs become synthetic vehicles; unmatched rows at other stops are ignored
   * — they are beyond-horizon buses that would duplicate across stops.
   */
  matchAnchors(ctx, stopEtas, now) {
    // Snapshot before clearing: a constraint that vanishes at this poll means
    // the bus arrived (feeds drop the row) — updateTripState turns it into a
    // dwell at that stop instead of letting the trip snap past it.
    const prevConstraints = new Map(this.constraints);
    this.etaMap.clear();
    this.tripEtas.clear();
    this.constraints.clear();
    const synthRows = [];
    let trips = [];
    if (this.schedules && this.patternDists.size) {
      trips = this.activeTrips(now);
      for (const [stopIdx, etas] of stopEtas) {
        const d = ctx.stopDistM?.[stopIdx];
        if (!Number.isFinite(d)) continue;
        const matched = new Set();
        for (const eta of etas) {
          let best = null;
          let bestD = Infinity;
          for (const trip of trips) {
            if (matched.has(trip.id)) continue;
            const pd = this.patternDists.get(trip.patIdx);
            if (!pd) continue;
            const k = this.patternIdxForDist(pd, d);
            if (!k) continue;
            const arr = trip.startEpoch + (pd.offsRows[k.idx][1]) * 1000;
            const dd = Math.abs(arr - eta.t);
            if (dd <= ETA_MATCH_TOL_MS && dd < bestD) {
              bestD = dd;
              best = trip;
            }
          }
          if (!best) {
            if (stopIdx === ctx.boardStopIndex) {
              synthRows.push({ etaT: eta.t, dest: eta.dest });
            }
            continue;
          }
          matched.add(best.id);
          // Keep every matched row per trip — the constraint holds only the
          // soonest, while the early-departure rules need the next stop's ETA
          // too (rows arrive in ascending stop order).
          const etas = this.tripEtas.get(best.id);
          if (etas) etas.push({ stopIdx, etaT: eta.t, d });
          else this.tripEtas.set(best.id, [{ stopIdx, etaT: eta.t, d }]);
          const prev = this.constraints.get(best.id);
          if (!prev || eta.t < prev.etaT) {
            this.constraints.set(best.id, { etaT: eta.t, d, stopIdx });
          }
          if (stopIdx === ctx.boardStopIndex) this.etaMap.set(best.id, eta.t);
        }
      }
    } else {
      // No schedule (MTR/LRT): every fetched stop's ETAs become synths —
      // board = approaching, later stops = trains that already passed.
      for (const [stopIdx, etas] of stopEtas) {
        const d = ctx.stopDistM?.[stopIdx];
        if (!Number.isFinite(d)) continue;
        for (const eta of etas) {
          synthRows.push({ etaT: eta.t, dest: eta.dest, d });
        }
      }
    }
    this.synth = this.reidentifySynth(synthRows, now);
    this.updateTripState(trips, prevConstraints, now);
  }

  /**
   * Trips on the road right now. The schedule window is extended back by the
   * largest observed delay + dwell, so a late bus's trip does not drop out
   * (and its marker vanish) before it actually reaches the terminus — only
   * trips with an arrival state come from the extended slice.
   */
  activeTrips(now) {
    let trips = this.schedules
      ? enumerateTrips(this.schedules, this.routeKey, this.dir, now)
      : [];
    if (!this.schedules || !this.tripState.size) return trips;
    let maxShiftMs = 0;
    for (const st of this.tripState.values()) {
      maxShiftMs = Math.max(
        maxShiftMs,
        (st.delaySec + (st.arrD >= 0 ? DWELL_MAX_S : 0)) * 1000,
      );
    }
    if (maxShiftMs <= 0) return trips;
    const known = new Set(trips.map((t) => t.id));
    const extra = enumerateTrips(
      this.schedules,
      this.routeKey,
      this.dir,
      now - maxShiftMs,
    );
    for (const t of extra) {
      if (!known.has(t.id) && this.tripState.has(t.id)) {
        known.add(t.id);
        trips.push(t);
      }
    }
    return trips;
  }

  /**
   * Stable identity for synthetic buses across polls. Ranks were positional,
   * so when the soonest synth arrived the next bus inherited its rank and the
   * marker glided onto the wrong bus. Re-matching keeps a rank on the same
   * bus: same destination wins, otherwise the nearest ETA; fresh ranks stay
   * monotonic so a live marker's id is never recycled. Arrived synths are
   * kept through their dwell at the stop, then dropped (the feed dropped
   * their row anyway).
   */
  reidentifySynth(rows, now) {
    const prev = this.synth;
    const out = [];
    const taken = new Set();
    for (const row of rows) {
      let best = null;
      let bestPen = Infinity;
      for (const s of prev) {
        if (s.etaT <= now || taken.has(s.rank)) continue;
        const pen =
          (row.dest && s.dest && row.dest === s.dest ? 0 : 60_000) +
          Math.abs(row.etaT - s.etaT);
        if (pen < bestPen) {
          bestPen = pen;
          best = s;
        }
      }
      if (best) {
        taken.add(best.rank);
        out.push({
          rank: best.rank,
          etaT: row.etaT,
          dest: row.dest,
          arrD: -1,
          arrAt: 0,
          d: row.d,
        });
      } else {
        out.push({
          rank: 0,
          etaT: row.etaT,
          dest: row.dest,
          arrD: -1,
          arrAt: 0,
          d: row.d,
        });
      }
    }
    let nextRank = 1;
    for (const s of prev) nextRank = Math.max(nextRank, s.rank + 1);
    for (const s of out) if (!s.rank) s.rank = nextRank++;
    for (const s of prev) {
      if (taken.has(s.rank)) continue;
      // Arrived synths stay while the feed still lists them (the card's
      // "Now" window), at least the dwell, capped like real trips.
      if (s.arrD >= 0) {
        const held = this.rowStillListed(this.ctx.boardStopIndex, s.etaT);
        if (now < s.arrAt + (held ? DWELL_MAX_MS : DWELL_MS)) out.push(s);
      }
    }
    out.sort((a, b) => a.etaT - b.etaT);
    return out;
  }

  /**
   * Per-trip arrival bookkeeping across polls (the schedule pass consumes
   * it, so it must survive the constraint rebuild here):
   *   - a live constraint stores the deviation (rounded ETA − scheduled
   *     arrival) and no dwell;
   *   - a constraint that vanished between polls means the bus arrived — the
   *     trip dwells at that stop while the operator feed still lists the bus
   *     (the ETA card's "Now" window), at least DWELL_S and at most
   *     DWELL_MAX_S, then continues on the schedule shifted by deviation +
   *     actual dwell (feeds drop the row at arrival, so a plain revert would
   *     snap the marker past the stop);
   *   - a vanished constraint still in the future (feed hiccup) becomes a
   *     delay-only continuation, which equals the anchored estimate.
   *
   * The dwell-release pass runs here (each poll): once the row is gone from
   * the raw feed — or the DWELL_MAX_S cap hits — the dwell end is recorded,
   * and computePositions continues the trip from the stop with the actual
   * dwell.
   */
  updateTripState(trips, prevConstraints, now) {
    const active = new Set(trips.map((t) => t.id));
    for (const id of [...this.tripState.keys()]) {
      if (!active.has(id)) this.tripState.delete(id);
    }
    const schedArrAt = (trip, d) => {
      const pd = this.patternDists.get(trip.patIdx);
      const k = pd ? this.patternIdxForDist(pd, d) : null;
      return k ? trip.startEpoch + (pd.offsRows[k.idx][1]) * 1000 : 0;
    };
    for (const [id, c] of this.constraints) {
      const trip = trips.find((t) => t.id === id);
      if (!trip) continue;
      const held = this.tripState.get(id);
      // fetch-more: a held state survives the rebuild while its own stop's
      // row (or a row at a stop ahead) still constrains the trip — the
      // constraint branch then releases it early per the departure rules
      // instead of rebuilding the arrival from scratch (which would lose the
      // early release and re-pin the marker at the stop).
      if (
        this.ctx.fetchMore &&
        held &&
        held.arrD >= 0 &&
        (held.arrD < c.d || held.stopIdx === c.stopIdx)
      ) {
        continue;
      }
      const schedArr = schedArrAt(trip, c.d);
      this.tripState.set(id, {
        delaySec: schedArr ? (c.etaT - schedArr) / 1000 : 0,
        arrD: -1,
        arrAt: 0,
        stopIdx: c.stopIdx,
      });
    }
    for (const [id, c] of prevConstraints) {
      if (!active.has(id) || this.constraints.has(id)) continue;
      const trip = trips.find((t) => t.id === id);
      if (!trip) continue;
      const held = this.tripState.get(id);
      // A state the departure rules already released keeps its early dwell
      // end — rebuilding here would re-pin the marker at the old stop.
      if (this.ctx.fetchMore && held && held.arrD >= 0 && held.dwellEnd !== undefined) {
        continue;
      }
      const schedArr = schedArrAt(trip, c.d);
      this.tripState.set(id, {
        delaySec: schedArr ? (c.etaT - schedArr) / 1000 : 0,
        arrD: c.etaT <= now ? c.d : -1,
        arrAt: c.etaT <= now ? c.etaT : 0,
        stopIdx: c.stopIdx,
      });
    }
    // Dwell release: a dwelling trip holds while the raw feed still lists
    // the bus (the card's "Now" lives as long as the row does) — the marker
    // stays at the stop until "Now" expires. The cap bounds the hold when
    // the feed never drops the row; the minimum keeps the stop visible.
    for (const st of this.tripState.values()) {
      if (st.arrD < 0 || st.dwellEnd) continue;
      if (now >= st.arrAt + DWELL_MAX_MS) {
        st.dwellEnd = st.arrAt + DWELL_MAX_MS;
      } else if (!this.rowStillListed(st.stopIdx, st.arrAt)) {
        st.dwellEnd = Math.min(
          Math.max(st.arrAt + DWELL_MS, now),
          st.arrAt + DWELL_MAX_MS,
        );
      }
    }
  }

  /**
   * Does the operator feed still list a bus at the given stop? True while
   * the raw row for that arrival survives (not marked departed) — the same
   * signal the ETA card's "Now" label derives from, so the marker holds at
   * the stop exactly as long as the card shows the bus. The ±60 s tolerance
   * covers feeds that bump a dwelling bus's eta to the current minute.
   */
  rowStillListed(stopIdx, etaT) {
    const rows = this.rawRowsByStop.get(stopIdx);
    if (!rows?.length) return false;
    for (const r of rows) {
      if (r?.departed === 1 || r?.departed === true) continue;
      const iso = r?.eta || r?.estimatedArrivalTime || r?.estimatedArrival;
      const t = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(t) && Math.abs(t - etaT) <= 60_000) return true;
    }
    return false;
  }

  /**
   * fetch-more early-departure end: when is the hold at an arrival stop
   * allowed to end? The bus may leave before its own "Now" expires once the
   * next stop's remaining ETA can no longer be made at speed-map speeds —
   * the marker then departs (immediately when that ETA already reads "Now")
   * and travels at segment speeds instead of lingering at the old stop.
   * Returns the departure time, or null to hold to the natural end.
   */
  earlyDepartureEnd(trip, pd, st, now) {
    if (!this.ctx.fetchMore || !st || st.arrD < 0) return null;
    let next = null;
    for (const r of this.tripEtas.get(trip.id) || []) {
      if (r.stopIdx > st.stopIdx) {
        next = r;
        break;
      }
    }
    if (!next) return null;
    const k0 = this.patternIdxForDist(pd, st.arrD);
    const k1 = this.patternIdxForDist(pd, next.d);
    if (!k0 || !k1 || k1.idx <= k0.idx) return null;
    // Speed-map travel time to the next matched stop: each pattern segment at
    // its midpoint's traffic multiplier (the same model schedulePos uses).
    const offs = pd.offsRows;
    let travelMs = 0;
    for (let i = k0.idx; i < k1.idx; i++) {
      const dt = (offs[i + 1][1] - offs[i][1]) * 1000;
      if (dt <= 0) continue;
      const mid = alongToLonLat(
        this.ctx.shape.coords,
        this.ctx.shape.cumM,
        (pd.distsM[i] + pd.distsM[i + 1]) / 2,
      );
      const m = this.trafficIndex && mid ? this.trafficIndex.multiplierAt(mid.lon, mid.lat) : 1;
      travelMs += dt / m;
    }
    const naturalEnd = st.dwellEnd ?? st.arrAt + DWELL_MAX_MS;
    const release = Math.max(now, Math.min(naturalEnd, next.etaT - travelMs));
    return release < naturalEnd ? release : null;
  }

  /**
   * Deterministic position computation (poll and 1 Hz tick share this, so
   * markers advance smoothly at schedule speed between polls):
   * schedule pass → 3-slot anchor pass (ETA first, schedule handoff) → synth.
   */
  computePositions(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    /** @type {Array<{ id: string, d: number, confidence: number, anchored: boolean }>} */
    const out = [];
    const trips = this.activeTrips(now);
    for (const trip of trips) {
      const pd = this.patternDists.get(trip.patIdx);
      if (!pd) continue;
      // Arrival handling: when a trip's constraint expires it is AT the stop.
      // Hold it there while the operator feed still lists the bus (the card's
      // "Now" window), at least the dwell, then continue on the schedule
      // shifted by the observed deviation + actual dwell, so the marker stops
      // at the stop instead of snapping past it (minute-rounded ETAs are up
      // to ±60 s away from the scheduled arrival; a plain revert would skip
      // the stop).
      const c = this.constraints.get(trip.id);
      const st = this.tripState.get(trip.id);
      // Phantom guard — TD headway data is a headway-band model, not the
      // operators' exact timetable, so the schedule pass can synthesize a
      // trip that has no real counterpart today. A bus truly approaching the
      // board stop inside the feed's verified horizon would have a feed row;
      // a trip still AHEAD of the stop with neither a live constraint nor an
      // arrival state is a model artifact — hide it, so a marker never
      // arrives at the stop while the panel shows the next real bus 20+ min
      // away. Trips already past the stop stay: the board feed never lists
      // them (they departed), so they are unverifiable here, not wrong.
      if (!c && !st && this.boardHorizonMs > 0 && pd.boardIdx >= 0) {
        const ahead = trip.startEpoch + pd.boardOffSec * 1000 - now;
        if (ahead > 0 && ahead <= this.boardHorizonMs) continue;
      }
      let d;
      const remain = c ? remainingSec(c.etaT, now) : 0;
      if (c && remain > 0) {
        d = this.walkBackFromDist(c.d, remain);
      } else if (c && remain <= 0) {
        const held = this.tripState.get(trip.id);
        // fetch-more departure rules: the marker is held (or was held) at a
        // stop while a row reads "Now" — the row's stop wins over the hold.
        //   a) the row is at a stop AHEAD — the bus is overdue there per the
        //      feed: release the hold now (depart before "Now" expires) and
        //      continue on the shifted schedule, so the marker travels the
        //      segment at speed-map speeds instead of lingering at the old
        //      stop or teleporting to the new one; once it reaches the stop
        //      the normal arrival hold below takes over.
        //   b) the row is at the SAME stop — hold while the row lists (the
        //      "Now" card), but leave early when the next stop's ETA can't be
        //      made at speed-map speeds (earlyDepartureEnd).
        if (this.ctx.fetchMore && held && held.arrD >= 0) {
          if (held.arrD < c.d) {
            // Release at now, never later — a re-derived dwell would snap the
            // marker back to the held stop on the next poll.
            held.dwellEnd = Math.min(held.dwellEnd ?? Infinity, now);
            const dwellMs = Math.max(0, held.dwellEnd - held.arrAt);
            const shiftMs = (held.delaySec + dwellMs / 1000) * 1000;
            if (now - shiftMs <= trip.startEpoch + trip.lenSec * 1000) {
              const cand = this.schedulePos(pd, trip, now - shiftMs);
              if (cand < c.d) d = cand;
            }
          } else if (held.stopIdx === c.stopIdx) {
            const earlyEnd = this.earlyDepartureEnd(trip, pd, held, now);
            if (earlyEnd !== null) held.dwellEnd = earlyEnd;
            const holdMs = held.dwellEnd
              ? Math.max(0, held.dwellEnd - held.arrAt)
              : DWELL_MAX_MS;
            const shiftMs = (held.delaySec + holdMs / 1000) * 1000;
            d =
              now < held.arrAt + holdMs
                ? c.d
                : this.schedulePos(pd, trip, now - shiftMs);
          }
        }
        if (d === undefined) {
          const k = this.patternIdxForDist(pd, c.d);
          const schedArr = k ? trip.startEpoch + (pd.offsRows[k.idx][1]) * 1000 : 0;
          const dev = k ? (c.etaT - schedArr) / 1000 : 0;
          const arrAt = c.etaT + NOW_SLACK_MS;
          const stN = { delaySec: dev, arrD: c.d, arrAt, stopIdx: c.stopIdx };
          // Release when the row is gone — or at the dwell cap even if the feed
          // keeps the row (a stale row must not pin the marker at the stop).
          if (!this.rowStillListed(c.stopIdx, c.etaT) || now >= arrAt + DWELL_MAX_MS) {
            stN.dwellEnd = Math.min(
              Math.max(arrAt + DWELL_MS, now),
              arrAt + DWELL_MAX_MS,
            );
          }
          this.tripState.set(trip.id, stN);
          const dwellMs = stN.dwellEnd ? stN.dwellEnd - stN.arrAt : DWELL_MAX_MS;
          d =
            now < arrAt + dwellMs
              ? c.d
              : this.schedulePos(pd, trip, now - (dev + dwellMs / 1000) * 1000);
        }
      } else if (st && st.arrD >= 0) {
        // The feed dropped the row at arrival; keep the stop visible through
        // the feed-listed dwell (the card's "Now" window), then continue on
        // the shifted schedule. With fetch-more the hold also ends early when
        // the next stop's ETA can't be made at speed-map speeds — the panel's
        // countdown wins over the lingering row here. The trip drops out once
        // its shifted clock reaches the terminus.
        const earlyEnd = this.earlyDepartureEnd(trip, pd, st, now);
        if (earlyEnd !== null) st.dwellEnd = earlyEnd;
        const dwellMs = st.dwellEnd ? Math.max(0, st.dwellEnd - st.arrAt) : DWELL_MAX_MS;
        const shiftMs = (st.delaySec + dwellMs / 1000) * 1000;
        if (now - shiftMs > trip.startEpoch + trip.lenSec * 1000) continue;
        d =
          now < st.arrAt + dwellMs
            ? st.arrD
            : this.schedulePos(pd, trip, now - shiftMs);
      } else if (st) {
        // Row vanished before arrival: continue on the delay-shifted schedule
        // (equals the anchored estimate while the constraint was live).
        if (now - st.delaySec * 1000 > trip.startEpoch + trip.lenSec * 1000) continue;
        d = this.schedulePos(pd, trip, now - st.delaySec * 1000);
      } else {
        d = this.schedulePos(pd, trip, now);
        const lastD = pd.distsM[pd.distsM.length - 1];
        const boardDist = this.ctx.stopDistM?.[this.ctx.boardStopIndex];
        // Reload spawn at the terminus: hide only when the user is also at
        // that terminus. Mid-route, vehicles that already passed (incl. at
        // dest) stay on the map.
        if (
          Number.isFinite(lastD) &&
          Math.abs(d - lastD) < 12 &&
          !this.etaMap.has(trip.id) &&
          Number.isFinite(boardDist) &&
          Math.abs(boardDist - lastD) < 80
        ) {
          continue;
        }
      }
      out.push({
        id: trip.id,
        trip,
        pd,
        d,
        confidence: this.trafficIndex ? CONF_SCHED : CONF_NO_TRAFFIC,
        anchored: false,
      });
    }
    // Anchored set: the 3 soonest arrivals at the board stop. ETA-matched
    // trips anchor on their ETA while future; otherwise the next-soonest trip
    // (schedule handoff — feeds cap at 3 arrivals, so the 4th bus is anchored
    // by its scheduled stop time). The anchored position is the schedule
    // position shifted by the trip's deviation (anchor time − scheduled
    // arrival at the anchor stop): the marker sits where a bus arriving at
    // that time is on the path right now. This is continuous with the dwell
    // continuation below and never pulls the marker across segments — a
    // linear stop − seconds × speed model made markers zoom when the ETA
    // re-anchored at another stop (fetch-more / cached rows). Once a matched
    // ETA expires the trip dwells and drops out of the set automatically.
    const boardDist = ctx.stopDistM?.[ctx.boardStopIndex];
    const schedArrAt = (pd, trip, d) => {
      const k = this.patternIdxForDist(pd, d);
      return k ? trip.startEpoch + (pd.offsRows[k.idx][1]) * 1000 : null;
    };
    const cands = [];
    for (const v of out) {
      const { pd, trip } = v;
      if (!pd || pd.boardIdx < 0 || pd.boardMatchM > BOARD_MATCH_TOL_M) continue;
      // A trip dwelling at another stop is not a board candidate: its shifted
      // scheduled arrival still lies in the future, which would yank it back
      // behind the stop while it is standing there.
      const st = this.tripState.get(v.id);
      if (st && st.arrD >= 0) {
        const dwellMs = st.dwellEnd ? st.dwellEnd - st.arrAt : DWELL_MAX_MS;
        if (now < st.arrAt + dwellMs) continue;
      }
      // A trip the fetch-more departure rules released (expired "Now" row at
      // a non-board stop ahead) is already on its shifted continuation —
      // re-anchoring it here (deviation-only, via the expired ETA) would snap
      // the marker forward to the next stop.
      const cEarly = this.constraints.get(v.id);
      if (cEarly && cEarly.etaT <= now && cEarly.stopIdx !== ctx.boardStopIndex) continue;
      const shiftMs = st
        ? (st.delaySec +
            (st.arrD >= 0 && st.dwellEnd ? (st.dwellEnd - st.arrAt) / 1000 : 0)) *
          1000
        : 0;
      const etaT = this.etaMap.get(v.id);
      const anchorT =
        etaT != null ? etaT : trip.startEpoch + pd.boardOffSec * 1000 + shiftMs;
      if (anchorT <= now) continue;
      cands.push({ v, pd, trip, anchorT });
    }
    cands.sort((a, b) => a.anchorT - b.anchorT);
    for (let i = 0; i < Math.min(ANCHOR_SLOTS, cands.length); i++) {
      const { v, pd, trip, anchorT } = cands[i];
      // A tighter ETA at another anchor stop (fetched with fetch-more, or
      // cached from an earlier stop selection) overrides the board anchor:
      // the deviation is measured against THAT stop's scheduled arrival, so
      // the position stays path-continuous as the constraint moves from stop
      // to stop. (An expired constraint always dwells in the schedule pass,
      // so c.etaT > now here.)
      const c = this.constraints.get(v.id);
      const nonBoard = c && c.stopIdx !== ctx.boardStopIndex && Number.isFinite(c.d);
      const schedArr = nonBoard
        ? schedArrAt(pd, trip, c.d)
        : trip.startEpoch + pd.boardOffSec * 1000;
      if (schedArr == null) continue;
      const at = nonBoard ? c.etaT : anchorT;
      const T = remainingSec(at, now);
      v.d =
        T > 0
          ? this.walkBackFromDist(nonBoard ? c.d : boardDist, T)
          : this.schedulePos(pd, trip, now - (at - schedArr));
      v.confidence = CONF_ETA;
      v.anchored = true;
    }
    // Extended anchors: trips constrained only at non-board stops (beyond the
    // board-stop slots) — e.g. a bus well behind or ahead that fetch-more or a
    // cached row still locates. Capped so the anchored set stays readable.
    const extended = [];
    for (const v of out) {
      if (v.anchored) continue;
      const c = this.constraints.get(v.id);
      if (!c || c.stopIdx === ctx.boardStopIndex || !Number.isFinite(c.d)) continue;
      if (c.etaT <= now) continue;
      // A trip mid-dwell or on its shifted continuation is already placed —
      // the deviation-only anchor here would snap it back to the stop.
      const stX = this.tripState.get(v.id);
      if (stX && stX.arrD >= 0) continue;
      extended.push({ v, c });
    }
    extended.sort((a, b) => a.c.etaT - b.c.etaT);
    for (const { v, c } of extended.slice(0, EXTRA_ANCHORS)) {
      const schedArr = schedArrAt(v.pd, v.trip, c.d);
      if (schedArr == null) continue;
      const T = remainingSec(c.etaT, now);
      v.d =
        T > 0
          ? this.walkBackFromDist(c.d, T)
          : this.schedulePos(v.pd, v.trip, now - (c.etaT - schedArr));
      v.confidence = CONF_ETA;
      v.anchored = true;
    }
    // Unmatched ETAs → synthetic buses (id stable by rank). An arrived synth
    // simulates the stop: it holds at the stop for the feed-listed window
    // (same rule as real trips), then drops (the feed dropped its row anyway).
    for (const s of this.synth) {
      const fromD = Number.isFinite(s.d) ? s.d : boardDist;
      const T = remainingSec(s.etaT, now);
      if (T > 0) {
        out.push({
          id: `synth:${s.rank}`,
          d: this.walkBackFromDist(fromD, T),
          confidence: CONF_ETA,
          anchored: true,
        });
        continue;
      }
      if (s.arrD < 0) {
        s.arrD = boardDist;
        s.arrAt = s.etaT + NOW_SLACK_MS;
      }
      const held = this.rowStillListed(ctx.boardStopIndex, s.etaT);
      if (now < s.arrAt + (held ? DWELL_MAX_MS : DWELL_MS)) {
        out.push({
          id: `synth:${s.rank}`,
          d: s.arrD,
          confidence: CONF_ETA,
          anchored: true,
        });
      }
    }
    this.antiClump(out);
    const rail = ctx.op === "mtr" || ctx.op === "lrt";
    if (!rail) this.dropGhostsByHeadway(out);
    this.vehicles = out;
  }

  /** Bracket interpolation between the kept pattern stops surrounding `elapsed`.
   * Uses pd.offsRows (index-aligned with pd.distsM; outliers were dropped in
   * cachePatterns), never the raw pattern. */
  schedulePos(pd, trip, now) {
    const elapsed = (now - trip.startEpoch) / 1000;
    const offs = pd.offsRows || trip.offsetsSec; // [[stopIdx, offsetSec, dir], ...]
    const dists = pd.distsM;
    let k = 0;
    while (k < offs.length - 2 && offs[k + 1][1] <= elapsed) k += 1;
    const d0 = dists[k];
    const d1 = dists[k + 1];
    const t0 = offs[k][1];
    const t1 = offs[k + 1][1];
    const vSeg = (d1 - d0) / Math.max(1, t1 - t0);
    const mid = alongToLonLat(this.ctx.shape.coords, this.ctx.shape.cumM, (d0 + d1) / 2);
    const v = vSeg * (this.trafficIndex && mid ? this.trafficIndex.multiplierAt(mid.lon, mid.lat) : 1);
    // Clamp to [d[k], d[k+1]]: congestion makes the bus crawl and wait at the
    // stop, naturally modeling delay without ever going backwards.
    return Math.max(
      Math.min(d0, d1),
      Math.min(Math.max(d0, d1), d0 + Math.max(0, elapsed - t0) * v),
    );
  }

  /**
   * Traffic-adjusted speed near the board stop, used by synthetic-vehicle
   * anchoring (synths have no schedule): nominal segment speed (from the
   * soonest candidate's pattern) × traffic multiplier at the board stop.
   * Falls back to V_TYP without candidates.
   */
  anchorSpeed(cands, boardDist) {
    const ctx = this.ctx;
    let vNom = V_TYP;
    if (cands.length) {
      const { pd } = cands[0];
      const offs = (pd.offsRows || pd.pat).map((x) => x[1]);
      let i = pd.boardIdx - 1;
      if (i < 0 || offs[i + 1] - offs[i] <= 0) i = Math.min(pd.boardIdx, pd.distsM.length - 2);
      const d0 = pd.distsM[i];
      const d1 = pd.distsM[i + 1];
      const dt = offs[i + 1] - offs[i];
      if (Number.isFinite(d0) && Number.isFinite(d1) && dt > 0) {
        vNom = (d1 - d0) / dt;
      }
    }
    const stop = ctx.stops?.[ctx.boardStopIndex];
    const mult =
      this.trafficIndex && stop ? this.trafficIndex.multiplierAt(stop.lon, stop.lat) : 1;
    return Math.max(0.5, vNom * mult);
  }

  /** 1 Hz recompute between polls (schedule + remaining-time walk). */
  tick(now = this.nowFn()) {
    if (!this.running || !this.ctx) return;
    const dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    if (dt <= 0 || dt > 30) return;
    if (!this.hasPolled) return;
    this.computePositions(now);
    this.emit(now);
  }

  /** ETA/schedule fetch failure → freeze the last emit (markers stay honest). */
  coast(now) {
    if (this.lastEmit) {
      const vehicles = this.lastEmit.vehicles.map((v) => ({ ...v, coasting: true }));
      this.onUpdate({ vehicles, at: now });
    } else {
      this.onUpdate({ vehicles: [], at: now });
    }
  }

  emit(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    const coords = ctx.shape.coords;
    const cumM = ctx.shape.cumM;
    const total = cumM?.[cumM.length - 1] || 0;
    // Whole route: approaching (behind board) and already-passed (ahead).
    // Anchored / tracked first, then the rest by along-track order.
    const boardDist = ctx.stopDistM?.[ctx.boardStopIndex] || 0;
    const tracked = (v) => this.tripState.get(v.id)?.arrD >= 0;
    const list = (this.vehicles || []).filter((v) => Number.isFinite(v.d));
    list.sort((a, b) => {
      const ra = a.anchored || tracked(a) ? 0 : 1;
      const rb = b.anchored || tracked(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.d - b.d;
    });
    const vehicles = [];
    for (const v of list) {
      if (vehicles.length >= MAX_VEHICLES && !v.anchored && !tracked(v)) break;
      vehicles.push(v);
    }
    // Separate output array — the loop below must not append to the array it
    // iterates (a shared array here used to grow unboundedly → memory blow-up).
    const payloads = [];
    for (const v of vehicles) {
      const ll = alongToLonLat(coords, cumM, Math.max(0, Math.min(v.d, total)));
      if (!ll) continue;
      payloads.push({
        id: hashId(v.id),
        lon: ll.lon,
        lat: ll.lat,
        // Along-shape distance: main.js' glide uses it directly instead of
        // re-projecting the lon/lat (whole-polyline nearest search is
        // ambiguous where the shape loops back on itself — circular routes
        // made markers flip between the two nearby legs).
        d: Math.round(v.d),
        label: String(ctx.routeShort || ""),
        confidence: v.confidence,
        coasting: false,
      });
    }
    this.lastEmit = { vehicles: payloads, at: now };
    this.onUpdate(this.lastEmit);
  }
}
