/**
 * Live Bus Position Engine (PRD 4.2) — client-side vehicle tracking.
 *
 * Translates static ETA countdowns at multiple stops into a smooth bus
 * position on the route shape:
 *
 *   1. Stitch    — group per-stop ETAs into per-vehicle chains using
 *                  travel-time windows derived from shape distances.
 *   2. Kalman    — a 1-D constant-velocity Kalman filter (kalman1d.js)
 *                  smooths the along-shape position and velocity across
 *                  polls; innovation gating matches chains to tracks.
 *   3. Traffic   — TD detector speeds (trafficSpeed.js) scale the process
 *                  noise of the prediction step.
 *
 * The engine is purely additive: it imports from existing modules and never
 * modifies them. Diagnostics use the [buspos] tag (AGENTS.md).
 */

import { Kalman1D } from "./kalman1d.js";
import { fetchTrafficSpeed } from "./trafficSpeed.js";

/** Typical bus speeds for stitching windows (m/s). */
const V_TYP = 8.3; // ~30 km/h
const V_MAX = 16.7; // ~60 km/h

/** Max simultaneously tracked vehicles per route (ambiguity guard). */
const MAX_VEHICLES = 3;
/** Drop tracks not refreshed within this many ms. */
const TRACK_TTL_MS = 8 * 60_000;

/**
 * Stitch per-stop arrivals into vehicle chains. Pure function (exported for
 * the sim harness).
 *
 * @param {Array<Array<{ t: number, dest: string, seq: number }>>} rowsByStop
 *   arrivals per window stop (index-aligned, future-only, sorted by t)
 * @param {{ stopDistM: number[], windowStops: number[] }} ctx
 * @returns {Array<{ stopIdxs: number[], t: number[], dest: string, score: number }>}
 */
export function stitchVehicles(rowsByStop, ctx) {
  const n = rowsByStop.length;
  /** @type {Set<number>[]} consumed arrival per stop */
  const used = rowsByStop.map(() => new Set());
  /** @type {Array<{ stopIdxs: number[], t: number[], dest: string, score: number }>} */
  const chains = [];

  const travelLo = (i) => {
    // Minute-rounded ETAs make adjacent stops land on the same minute grid
    // (dt = 0) whenever the bus crosses both within one minute — a legitimate
    // match, so the lower bound is 0 and cost prefers the likely gap.
    const d = Math.max(30, shapeGap(ctx, i));
    return Math.max(0, (0.5 * d) / V_MAX - 45) * 1000;
  };
  const travelHi = (i) => {
    const d = Math.max(30, shapeGap(ctx, i));
    return ((1.6 * d) / V_TYP + 90) * 1000; // plus minute-rounding slack
  };
  const travelExp = (i) => (shapeGap(ctx, i) / V_TYP) * 1000;

  // Greedy forward chaining from every unconsumed arrival.
  for (let i = 0; i < n - 1; i++) {
    const arrs = rowsByStop[i];
    for (let ai = 0; ai < arrs.length; ai++) {
      if (used[i].has(ai)) continue;
      used[i].add(ai);
      /** @type {{ stopIdxs: number[], t: number[], dest: string, score: number }} */
      const chain = {
        stopIdxs: [i],
        t: [arrs[ai].t],
        dest: arrs[ai].dest,
        score: 0,
      };
      let ci = i;
      while (ci < n - 1) {
        const lo = travelLo(ci);
        const hi = travelHi(ci);
        const expected = travelExp(ci);
        const prevT = chain.t[chain.t.length - 1];
        const next = rowsByStop[ci + 1];
        let bestJ = -1;
        let bestCost = Infinity;
        for (let j = 0; j < next.length; j++) {
          if (used[ci + 1].has(j)) continue;
          const dt = next[j].t - prevT;
          if (dt < lo || dt > hi) continue;
          const destPenalty =
            chain.dest && next[j].dest && next[j].dest !== chain.dest ? 300 : 0;
          const cost = Math.abs(dt - expected) + destPenalty;
          if (cost < bestCost) {
            bestCost = cost;
            bestJ = j;
          }
        }
        if (bestJ < 0) break;
        used[ci + 1].add(bestJ);
        chain.stopIdxs.push(ci + 1);
        chain.t.push(next[bestJ].t);
        if (!chain.dest) chain.dest = next[bestJ].dest;
        chain.score += 1;
        ci += 1;
      }
      chains.push(chain);
    }
  }
  // Lone arrivals (bus visible only at the last window stop, or window edge).
  for (let i = 0; i < n; i++) {
    for (let ai = 0; ai < rowsByStop[i].length; ai++) {
      if (used[i].has(ai)) continue;
      used[i].add(ai);
      chains.push({
        stopIdxs: [i],
        t: [rowsByStop[i][ai].t],
        dest: rowsByStop[i][ai].dest,
        score: 0,
      });
    }
  }
  return chains;
}

function shapeGap(ctx, i) {
  const a = ctx.stopDistM?.[ctx.windowStops?.[i]];
  const b = ctx.stopDistM?.[ctx.windowStops?.[i + 1]];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 600;
  return Math.max(30, b - a);
}

/**
 * Turn a chain into an along-shape observation at `now` (ms epoch).
 * Brackets the bus between the two chain stops surrounding now; extrapolates
 * backward (bus still behind the first stop) or forward (passed the window)
 * using the ETA-implied segment speed.
 * @param {{ stopIdxs: number[], t: number[] }} chain
 * @param {{ stopDistM: number[], windowStops: number[] }} ctx
 * @param {number} now
 * @returns {{ s: number, sigma: number, stops: number, vHint: number } | null}
 */
export function observeChain(chain, ctx, now) {
  const n = chain.stopIdxs.length;
  if (!n) return null;
  const sOf = (k) => ctx.stopDistM[ctx.windowStops[chain.stopIdxs[k]]];
  if (n === 1) {
    const h = (chain.t[0] - now) / 1000;
    if (h > 600) {
      // 10+ min to the only future stop: no speed information at all (V_TYP
      // can be off by ±6 m/s on highways, and the error grows with h), so
      // there is nothing to observe — the track coasts on its own velocity.
      return null;
    }
    // Only a future ETA: bus is somewhere before that stop. The minute grid
    // makes the true phase uniform on (0, 60 s] — back-extrapolate from the
    // grid midpoint so the observation is unbiased.
    const s = sOf(0) - Math.max(0, h - 30) * V_TYP;
    return { s, sigma: Math.max(280, 180 + h * 2.5), stops: 1, vHint: V_TYP };
  }
  // Least-squares segment speed over the near-term links: per-link ETA deltas
  // are minute-quantized (each endpoint ±60 s), so a single link can imply
  // ±100% speed error. An OLS slope over 2–4 minutes of chain averages the
  // grid noise, and far stops are excluded (their ETA speed-model noise grows
  // with the horizon and would skew the slope).
  // Fit window: start from the near-term stops (≤10 min of ETA, at most 6
  // links) and require a ~5-minute span so the OLS can average out the minute
  // grid. Dense routes cut the span short at the 6-link cap — extend toward
  // 5 minutes. Sparse routes (long highway gaps) jump past the 10-minute cap
  // — pull in the stop that crosses the 5-minute span; its ETA shares the
  // operator's speed model, so it keeps the slope consistent.
  const fitN = Math.max(2, Math.min(n, 6));
  let fitEnd = 2;
  while (fitEnd < fitN && chain.t[fitEnd] - chain.t[0] <= 600_000) fitEnd += 1;
  if (chain.t[fitEnd - 1] - chain.t[0] < 300_000) {
    while (fitEnd < n && chain.t[fitEnd] - chain.t[0] < 300_000) fitEnd += 1;
    fitEnd = Math.min(n, fitEnd + 1);
  }
  let sBar = 0;
  let tBar = 0;
  for (let i = 0; i < fitEnd; i++) {
    sBar += sOf(i);
    tBar += chain.t[i];
  }
  sBar /= fitEnd;
  tBar /= fitEnd;
  let num = 0;
  let den = 0;
  for (let i = 0; i < fitEnd; i++) {
    const ds = sOf(i) - sBar;
    const dt = chain.t[i] - tBar;
    num += ds * dt;
    den += dt * dt;
  }
  // t is epoch-ms, so the slope is m/ms — rescale to m/s (×1000).
  const vSeg = den > 0 ? (num / den) * 1000 : V_TYP;
  const vHint = Math.max(0.5, Math.min(V_MAX, vSeg));
  // Observation noise: the ±30 s minute phase plus the ETA speed-model error,
  // which grows with the back-extrapolation horizon h (seconds). Long-horizon
  // observations must not yank the filter around.
  const sigmaFor = (h) =>
    Math.max(160, Math.min(2500, vSeg * (30 + 0.1 * Math.max(0, h))));
  // Unbiased back-extrapolation from stop k's future ETA: the true phase is
  // uniform on (0, 60 s] (countdowns round up), so correct by half a minute.
  const behind = (k) =>
    sOf(k) - Math.max(0, (chain.t[k] - now) / 1000 - 30) * vSeg;
  let k = 0;
  while (k < n - 2 && chain.t[k + 1] <= now) k += 1;
  const sK = sOf(k);
  const tK = chain.t[k];
  const sN = sOf(k + 1);
  const tN = chain.t[k + 1];
  if (now < tK) {
    // Behind the first matched stop — anchor on its future ETA. The nearest
    // stop has the shortest back-extrapolation horizon, so it carries the
    // smallest speed-error amplification.
    const s = behind(0);
    return { s, sigma: sigmaFor((tK - now) / 1000), stops: n, vHint };
  }
  if (now <= tN) {
    if (tN - tK < 60_000) {
      // The ETA pair collapsed onto the same minute grid — interpolation is
      // meaningless, so anchor on the next stop's future ETA instead.
      const s = behind(k + 1);
      return { s, sigma: sigmaFor((tN - now) / 1000), stops: n, vHint };
    }
    const frac = (now - tK) / Math.max(1, tN - tK);
    const s = sK + frac * (sN - sK);
    return { s, sigma: 60 + vSeg * 30, stops: n, vHint };
  }
  const s = sN + ((now - tN) / 1000) * vSeg;
  return { s, sigma: sigmaFor((now - tN) / 1000), stops: n, vHint };
}

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
function normalizeRows(op, rows, bound) {
  const out = [];
  const now = Date.now();
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
 * the engine just fetches on demand, tracks, and emits marker payloads.
 */
export class BusPositionEngine {
  /**
   * @param {object} opts
   * @param {(evt: { vehicles: Array<{ id: number, lon: number, lat: number, label: string, confidence: number, coasting: boolean, pinned: boolean, sigmaM: number }> }) => void} [opts.onUpdate]
   * @param {(ctx: any, stop: { stopId: string, seq: number }) => Promise<any[]>} [opts.fetchRows]
   */
  constructor(opts = {}) {
    this.onUpdate = opts.onUpdate || (() => {});
    this.fetchRows = opts.fetchRows || defaultFetchRows;
    this.ctx = null;
    /** @type {Array<{ id: number, kf: Kalman1D, chain: any, dest: string, lastSeen: number, confidence: number }>} */
    this.vehicles = [];
    this.trafficIndex = null;
    this.nextId = 1;
    this.lastTickMs = 0;
    this.running = false;
  }

  /** @param {{ op: string, routeId: string, routeShort: string, bound: string, serviceType?: number, stops: Array<{ stopId: string, seq: number, lon: number, lat: number }>, boardStopIndex: number, shape: { coords: Array<{ lon: number, lat: number }>, cumM: number[] }, stopDistM: number[], nlbRouteIds?: string[] }} ctx */
  start(ctx) {
    this.stop();
    if (!ctx?.shape?.coords?.length || !ctx.stopDistM?.length) {
      console.warn("[buspos] start skipped: no shape/stop geometry");
      return;
    }
    this.ctx = ctx;
    this.vehicles = [];
    this.lastTickMs = Date.now();
    this.running = true;
    // 6-stop fetch window centered on the board stop.
    const n = ctx.stops?.length || 0;
    const half = 3;
    const startIdx = Math.max(0, Math.min(n - 6, (ctx.boardStopIndex || 0) - half));
    const len = Math.min(6, n - startIdx);
    this.windowStops = Array.from({ length: len }, (_, k) => startIdx + k);
    console.info(
      "[buspos] engine started",
      ctx.op,
      ctx.routeShort,
      ctx.bound,
      "window",
      this.windowStops.join(","),
    );
    void this.refreshTraffic();
  }

  stop() {
    this.running = false;
    this.ctx = null;
    this.vehicles = [];
    this.trafficIndex = null;
  }

  /** Baseline refresh of the traffic index (5-min TTL cache inside). */
  async refreshTraffic() {
    try {
      this.trafficIndex = await fetchTrafficSpeed();
    } catch {
      this.trafficIndex = null;
    }
  }

  /** One poll: fetch window ETAs → stitch → match → Kalman update → emit. */
  async poll() {
    const ctx = this.ctx;
    if (!this.running || !ctx) return;
    const now = Date.now();
    try {
      const rowsByStop = [];
      for (const si of this.windowStops) {
        const stop = ctx.stops[si];
        if (!stop?.stopId) {
          rowsByStop.push([]);
          continue;
        }
        const rows = await this.fetchRows(ctx, stop);
        rowsByStop.push(normalizeRows(ctx.op, rows, ctx.bound));
      }
      const chains = stitchVehicles(rowsByStop, {
        stopDistM: ctx.stopDistM,
        windowStops: this.windowStops,
      });
      if (!chains.length) {
        console.warn("[buspos] no chains this poll");
        return;
      }
      this.ingestChains(chains, now);
    } catch (e) {
      console.warn("[buspos] poll failed, tracks will coast", e?.message || e);
      this.vehicles.forEach((v) => v.kf.coast());
    }
  }

  /** Match chains to tracks, update Kalman filters, prune stale tracks. */
  ingestChains(chains, now) {
    const ctx = this.ctx;
    // observeChain reads stop distances through the window's route-stop
    // indices — pass the same window mapping stitchVehicles used.
    const obsCtx = {
      stopDistM: ctx.stopDistM,
      windowStops: this.windowStops,
    };
    const usedTracks = new Set();
    for (const chain of chains) {
      const obs = observeChain(chain, obsCtx, now);
      if (!obs) continue;
      // PRD edge: a bus sitting at the route's first stop (origin terminus)
      // with a future departure ETA must stay pinned at the terminus, not
      // creep forward. Only the route's real first stop qualifies — the
      // window's first stop is usually mid-route.
      if (
        this.windowStops[chain.stopIdxs[0]] === 0 &&
        chain.t[0] > now
      ) {
        const v = this.trackFor(obs, chain, now);
        v.kf.pin(ctx.stopDistM[0] || 0);
        usedTracks.add(v.id);
        continue;
      }
      let track = null;
      let bestD = Infinity;
      for (const v of this.vehicles) {
        if (!v.kf.gates(obs.s, obs.sigma)) continue;
        const d = Math.abs(v.kf.state().s - obs.s);
        if (d < bestD) {
          bestD = d;
          track = v;
        }
      }
      const isNew = !track && this.vehicles.length < MAX_VEHICLES;
      if (isNew) {
        track = {
          id: this.nextId++,
          kf: new Kalman1D(),
          chain,
          dest: chain.dest,
          lastSeen: now,
          confidence: 0.55,
        };
        this.vehicles.push(track);
      }
      if (!track) continue;
      if (isNew) {
        // New track: seed the filter with the first observation instead of
        // trusting the wide initial covariance (cold start converges in one poll).
        track.kf.init(obs.s, obs.sigma, obs.vHint);
      } else {
        track.kf.update(obs.s, obs.sigma);
      }
      track.chain = chain;
      track.dest = track.dest || chain.dest;
      track.lastSeen = now;
      track.confidence = Math.min(
        1,
        (chain.score >= 1 ? 0.85 : 0.6) + (chain.score >= 1 && obs.stops > 1 ? 0.15 : 0),
      );
      usedTracks.add(track.id);
    }
    this.pruneTracks(now);
    this.emit(now);
  }

  trackFor(obs, chain, now) {
    let best = null;
    let bestD = Infinity;
    for (const v of this.vehicles) {
      const d = Math.abs(v.kf.state().s - obs.s);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best) return best;
    const track = {
      id: this.nextId++,
      kf: new Kalman1D(),
      chain,
      dest: chain.dest,
      lastSeen: now,
      confidence: 0.7,
    };
    this.vehicles.push(track);
    return track;
  }

  pruneTracks(now) {
    this.vehicles = this.vehicles.filter((v) => now - v.lastSeen < TRACK_TTL_MS);
  }

  /** 1 Hz interpolation between polls (driven by main.js ticker). */
  tick(now = Date.now()) {
    if (!this.running || !this.ctx) return;
    const dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    if (dt <= 0 || dt > 30) return;
    for (const v of this.vehicles) {
      v.kf.predict(dt, this.multiplierAt(v));
    }
    this.emit(now);
  }

  multiplierAt(v) {
    if (!this.trafficIndex || !v.lastLonLat) return 1;
    return this.trafficIndex.multiplierAt(v.lastLonLat.lon, v.lastLonLat.lat);
  }

  emit(now) {
    if (!this.ctx) return;
    const vehicles = [];
    for (const v of this.vehicles) {
      const st = v.kf.state();
      const ll = alongToLonLat(
        this.ctx.shape.coords,
        this.ctx.shape.cumM,
        st.s,
      );
      if (!ll) continue;
      v.lastLonLat = ll;
      const coasting = !!st.trust && st.trust < 0.5;
      vehicles.push({
        id: v.id,
        lon: ll.lon,
        lat: ll.lat,
        label: String(this.ctx.routeShort || ""),
        confidence: Math.max(0.1, Math.min(1, v.confidence * st.trust)),
        coasting: v.kf.coasting || coasting,
        pinned: v.kf.pinned,
        sigmaM: st.sigmaM,
      });
    }
    this.onUpdate({ vehicles, at: now });
  }
}
