/**
 * Live Bus Position Engine (PRD 4.2 v2) — schedule-based whole-route tracking.
 *
 * Positioning stays Speed + Time = Position: traffic speed (trafficSpeed.js,
 * unchanged) × time from a known reference. The time source is now the GTFS
 * schedule for the whole route (busSchedules.js) instead of stitched ETA
 * chains, with the 3 live ETAs at the selected stop re-anchoring the next 3
 * buses:
 *
 *   1. Schedule pass — every active trip of the route/direction is placed by
 *      bracket interpolation between its pattern's stop offsets, scaled by
 *      the traffic multiplier of the current segment.
 *   2. ETA anchoring — up to 3 future ETAs at the board stop match the trip
 *      whose scheduled arrival there is closest (≤ 15 min); matched trips are
 *      pulled to `board stop − seconds × speed`. Unmatched ETAs become
 *      synthetic vehicles (id synth:{rank}).
 *   3. Handoff — the anchored set is always the 3 soonest arrivals at the
 *      board stop: ETA-matched trips use their ETA while future, otherwise
 *      the next-soonest trip (the "4th bus", feeds cap at 3 arrivals) is
 *      anchored by its scheduled arrival. When a matched ETA expires the trip
 *      reverts to pure schedule interpolation; near-on-time ETAs (≤ 30 s past
 *      the scheduled arrival) blend into the schedule first, so the revert
 *      is continuous instead of snapping on fast segments.
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
/** Max simultaneously emitted vehicles (3 anchored + up to 5 schedule). */
const MAX_VEHICLES = 8;
/** ETA anchor slots at the selected stop (operator feeds cap at 3). */
const ANCHOR_SLOTS = 3;
/** A pattern stop is the "board stop" only within this distance (m). */
const BOARD_MATCH_TOL_M = 300;
/** ETA ↔ scheduled-arrival matching tolerance at the board stop. */
const ETA_MATCH_TOL_MS = 15 * 60_000;
/**
 * ETA deviation (rounded ETA − scheduled arrival) within which the anchored
 * estimate blends into the schedule over the anchor's remaining life. Covers
 * the minute-rounding ambiguity of a near-on-time bus (±30 s) so the revert
 * at ETA expiry is continuous; a genuinely late ETA (> 30 s) stays purely
 * anchored until expiry (the schedule would be far behind the bus).
 */
const BLEND_DEV_S = 30;
/** Max projection distance for a schedule stop onto the drawn shape (m). */
const PROJECT_TOL_M = 400;

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

/** Default per-operator ETA row fetcher (browser; lazy eta.js import). */
async function defaultFetchRows(ctx, stop) {
  const { fetchJson } = await import("./eta.js");
  const op = String(ctx.op || "").toLowerCase();
  if (op === "kmb") {
    const data = await fetchJson(
      `/eta/kmb/eta/${encodeURIComponent(stop.stopId)}/${encodeURIComponent(ctx.routeShort)}/${encodeURIComponent(ctx.serviceType || 1)}`,
    );
    return Array.isArray(data?.data) ? data.data : [];
  }
  if (op === "ctb") {
    const data = await fetchJson(
      `/eta/ctb/eta/CTB/${encodeURIComponent(stop.stopId)}/${encodeURIComponent(ctx.routeShort)}`,
    );
    return Array.isArray(data?.data) ? data.data : [];
  }
  if (op === "nlb") {
    const routeIds = ctx.nlbRouteIds?.length ? ctx.nlbRouteIds : [ctx.routeId];
    for (const rid of routeIds) {
      if (!rid) continue;
      const data = await fetchJson(
        `/eta/nlb/stop.php?action=estimatedArrivals&routeId=${encodeURIComponent(rid)}&stopId=${encodeURIComponent(stop.stopId)}&language=en`,
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
  return [];
}

/** Filter + normalize raw operator rows for one stop. */
function normalizeRows(op, rows, bound, now = Date.now()) {
  const out = [];
  for (const r of rows) {
    if (r?.departed === 1 || r?.departed === true) continue;
    const iso = r?.eta || r?.estimatedArrivalTime || r?.estimatedArrival;
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t) || t <= now) continue;
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
   * @param {(co: string) => Promise<any|null>} [opts.loadSchedules] harness injection (default: browser fetch)
   * @param {() => Promise<any|null>} [opts.loadTraffic] harness injection (default: fetchTrafficSpeed)
   * @param {() => number} [opts.nowFn] clock injection for the sim harness (default: Date.now)
   */
  constructor(opts = {}) {
    this.onUpdate = opts.onUpdate || (() => {});
    this.fetchRows = opts.fetchRows || defaultFetchRows;
    this.loadSchedules = opts.loadSchedules || loadOperatorSchedules;
    this.loadTraffic = opts.loadTraffic || fetchTrafficSpeed;
    this.nowFn = opts.nowFn || Date.now;
    this.ctx = null;
    this.running = false;
    /** @type {Map<string, number>} trip id → ETA time from the last poll */
    this.etaMap = new Map();
    /** @type {Array<{ rank: number, etaT: number }>} unmatched ETAs (synth buses) */
    this.synth = [];
    /** @type {Map<number, { distsM: number[], pat: any, boardIdx: number, boardMatchM: number, boardOffSec: number }>} */
    this.patternDists = new Map();
    this.schedules = null;
    this.trafficIndex = null;
    this.lastEmit = null;
    this.lastTickMs = 0;
    this.initPromise = null;
  }

  /**
   * @param {{ op: string, routeId: string, routeShort: string, bound: string, serviceType?: number, stops: Array<{ stopId: string, seq: number, lon: number, lat: number }>, boardStopIndex: number, shape: { coords: Array<{ lon: number, lat: number }>, cumM: number[] }, stopDistM: number[], nlbRouteIds?: string[] }} ctx
   */
  start(ctx) {
    this.stop();
    if (!ctx?.shape?.coords?.length || !ctx.stopDistM?.length) {
      console.warn("[buspos] start skipped: no shape/stop geometry");
      return;
    }
    this.ctx = ctx;
    this.running = true;
    this.lastTickMs = this.nowFn();
    // Schedule lookup key + GTFS direction: same mapping the shape loader uses
    // (ctx.routeId is the short name; bound O/I maps to direction_id 0/1).
    this.routeKey = `${String(ctx.op || "").toUpperCase()}-${ctx.routeId}`;
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
    this.synth = [];
    this.trafficIndex = null;
    this.lastEmit = null;
    this.initPromise = null;
  }

  /** Load schedules (async, cached) + traffic index once at start. */
  async init() {
    const ctx = this.ctx;
    if (!this.running) return;
    this.schedules = await this.loadSchedules(String(ctx.op || "").toLowerCase());
    if (!this.running || this.ctx !== ctx) return;
    if (!this.schedules) {
      console.warn("[buspos] schedules unavailable — ETA-synth only");
      return;
    }
    this.cachePatterns();
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

  /** One poll: fetch board-stop ETAs → match anchors → compute → emit. */
  async poll() {
    const ctx = this.ctx;
    if (!this.running || !ctx) return;
    const now = this.nowFn();
    try {
      if (this.initPromise) await this.initPromise;
      if (!this.running || this.ctx !== ctx) return;
      const stop = ctx.stops?.[ctx.boardStopIndex];
      let etas = [];
      if (stop?.stopId) {
        const rows = await this.fetchRows(ctx, stop);
        etas = normalizeRows(ctx.op, rows, ctx.bound, now);
      }
      this.etaMap.clear();
      this.synth = [];
      if (this.schedules && this.patternDists.size) {
        const trips = enumerateTrips(this.schedules, this.routeKey, this.dir, now);
        const matched = new Set();
        // Greedy ascending: each ETA takes the unmatched trip whose scheduled
        // arrival at the board stop is closest (≤ 15 min).
        for (const eta of etas) {
          let best = null;
          let bestD = Infinity;
          for (const trip of trips) {
            if (matched.has(trip.id)) continue;
            const pd = this.patternDists.get(trip.patIdx);
            if (!pd || pd.boardIdx < 0 || pd.boardMatchM > BOARD_MATCH_TOL_M) continue;
            const arr = trip.startEpoch + pd.boardOffSec * 1000;
            const d = Math.abs(arr - eta.t);
            if (d <= ETA_MATCH_TOL_MS && d < bestD) {
              bestD = d;
              best = trip;
            }
          }
          if (best) {
            matched.add(best.id);
            this.etaMap.set(best.id, eta.t);
          } else {
            this.synth.push({ rank: this.synth.length + 1, etaT: eta.t });
          }
        }
      } else {
        // No schedule: every ETA is a synthetic, ETA-anchored bus.
        for (const eta of etas) this.synth.push({ rank: this.synth.length + 1, etaT: eta.t });
      }
      this.computePositions(now);
      this.emit(now);
    } catch (e) {
      console.warn("[buspos] poll failed", e?.message || e);
      this.coast(now);
    }
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
    const trips = this.schedules
      ? enumerateTrips(this.schedules, this.routeKey, this.dir, now)
      : [];
    for (const trip of trips) {
      const pd = this.patternDists.get(trip.patIdx);
      if (!pd) continue;
      out.push({
        id: trip.id,
        trip,
        pd,
        d: this.schedulePos(pd, trip, now),
        confidence: this.trafficIndex ? CONF_SCHED : CONF_NO_TRAFFIC,
        anchored: false,
      });
    }
    // Anchored set: the 3 soonest arrivals at the board stop. ETA-matched
    // trips anchor on their ETA while future; otherwise the next-soonest trip
    // (schedule handoff — feeds cap at 3 arrivals, so the 4th bus is anchored
    // by its scheduled stop time). Once a matched ETA expires the trip reverts
    // to schedule interpolation and drops out of the set automatically.
    const boardDist = ctx.stopDistM?.[ctx.boardStopIndex];
    const cands = [];
    for (const v of out) {
      const { pd, trip } = v;
      if (!pd || pd.boardIdx < 0 || pd.boardMatchM > BOARD_MATCH_TOL_M) continue;
      const etaT = this.etaMap.get(v.id);
      const anchorT =
        etaT != null ? etaT : trip.startEpoch + pd.boardOffSec * 1000;
      if (anchorT <= now) continue;
      cands.push({ v, pd, trip, anchorT });
    }
    cands.sort((a, b) => a.anchorT - b.anchorT);
    const vAnchor = this.anchorSpeed(cands, boardDist);
    for (let i = 0; i < Math.min(ANCHOR_SLOTS, cands.length); i++) {
      const { v, pd, trip, anchorT } = cands[i];
      let d = Math.max(0, boardDist - ((anchorT - now) / 1000) * vAnchor);
      const etaT = this.etaMap.get(v.id);
      if (etaT != null) {
        // Near-on-time ETA: blend the anchored estimate into the schedule
        // over the anchor's remaining life. The minute-rounded ETA of an
        // on-time bus trails its scheduled arrival by ≤ 30 s; blending keeps
        // the marker continuous when the row expires (fast segments would
        // otherwise snap by minutes of travel). Genuinely late buses
        // (deviation > 30 s) stay purely anchored — the schedule is behind them.
        const schedArr = trip.startEpoch + pd.boardOffSec * 1000;
        const dev = (etaT - schedArr) / 1000;
        if (dev > 0 && dev <= BLEND_DEV_S && now > schedArr) {
          const w = Math.min(1, (now - schedArr) / (dev * 1000));
          d += (this.schedulePos(pd, trip, now) - d) * w;
        }
      }
      v.d = d;
      v.confidence = CONF_ETA;
      v.anchored = true;
    }
    // Unmatched ETAs → synthetic buses (id stable by rank; disappear once
    // their ETA passes, since the feed drops departed buses anyway).
    for (const s of this.synth) {
      if (s.etaT <= now) continue;
      out.push({
        id: `synth:${s.rank}`,
        d: Math.max(0, boardDist - ((s.etaT - now) / 1000) * vAnchor),
        confidence: CONF_ETA,
        anchored: true,
      });
    }
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
   * Traffic-adjusted speed near the board stop, used by ETA anchoring:
   * nominal segment speed (from the soonest candidate's pattern) × traffic
   * multiplier at the board stop. Falls back to V_TYP without candidates.
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

  /** 1 Hz recompute between polls (deterministic schedule model). */
  tick(now = this.nowFn()) {
    if (!this.running || !this.ctx) return;
    const dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    if (dt <= 0 || dt > 30) return;
    if (!this.schedules || !this.patternDists.size) return;
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
    // Anchored (soonest) first, then schedule buses; cap for radar clutter.
    const anchored = [];
    const sched = [];
    for (const v of this.vehicles || []) (v.anchored ? anchored : sched).push(v);
    sched.sort((a, b) => a.d - b.d);
    const vehicles = [];
    for (const v of [...anchored, ...sched].slice(0, MAX_VEHICLES)) {
      const ll = alongToLonLat(coords, cumM, Math.max(0, Math.min(v.d, total)));
      if (!ll) continue;
      vehicles.push({
        id: hashId(v.id),
        lon: ll.lon,
        lat: ll.lat,
        label: String(ctx.routeShort || ""),
        confidence: v.confidence,
        coasting: false,
      });
    }
    this.lastEmit = { vehicles, at: now };
    this.onUpdate(this.lastEmit);
  }
}
