/**
 * Lightweight route-snapper inspired by wheelstransit/route-snapper.
 * Projects ordered stops onto a route LineString (lon/lat), always moving
 * forward — handles out-and-back / overlapping corridors better than
 * naive nearest-point.
 *
 * Used to slice a full bus shape between board and alight stops.
 * Rail / LRT polylines use basemap railways via railSnapper.js.
 */

import { detectMtrLineCode } from "./mtrColors.js";
import { t } from "./lang.js";

/**
 * @typedef {{ lon: number, lat: number }} LngLat
 */

/**
 * @param {LngLat[]} route  LineString coords [lon, lat] order for MapLibre
 * @param {Array<{ id?: string, lon: number, lat: number }>} stops  travel order
 * @returns {Array<{ id: string, lon: number, lat: number, distanceAlong: number, error: number }>}
 */
/**
 * Nearest point on a polyline to a stop (no forward constraint).
 * @param {LngLat[]} route
 * @param {{ lon: number, lat: number }} stop
 * @param {number} [minAlongM] optional: prefer projections at/after this distance
 * @returns {{ lon: number, lat: number, distanceAlong: number, error: number } | null}
 */
export function nearestPointOnRoute(route, stop, minAlongM = 0) {
  if (!route || route.length < 2 || !stop) return null;
  if (!Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) return null;

  const cum = cumulativeDistances(route);
  let best = null;
  let bestForward = null;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const segLen = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (segLen < 1e-9) continue;
    const { t, lon, lat, err } = projectPointToSegment(stop, a, b);
    const along = cum[i] + t * segLen;
    const cand = { lon, lat, distanceAlong: along, error: err };
    if (!best || err < best.error) best = cand;
    if (along + 0.5 >= minAlongM) {
      if (!bestForward || err < bestForward.error) bestForward = cand;
    }
  }

  // Prefer on-or-after minAlong when still a reasonable snap
  if (
    bestForward &&
    (!best || bestForward.error <= best.error + 35 || bestForward.error < 80)
  ) {
    return bestForward;
  }
  return best;
}

/**
 * Project ordered stops onto a route LineString (forward-biased).
 * Always returns one result per input stop (uses global nearest if needed).
 * @param {LngLat[]} route
 * @param {Array<{ id?: string, lon: number, lat: number }>} stops
 * @returns {Array<{ id: string, lon: number, lat: number, distanceAlong: number, error: number }>}
 */
export function projectStops(route, stops) {
  if (!route || route.length < 2 || !stops?.length) return [];

  let minDist = 0;
  const out = [];

  for (let si = 0; si < stops.length; si++) {
    const stop = stops[si];
    const isFirst = si === 0;
    const isLast = si === stops.length - 1;

    // Soft forward bias (30 m back-track allowed) so out-of-order GTFS still snaps
    const floor = isFirst ? 0 : Math.max(0, minDist - 30);
    let best = nearestPointOnRoute(route, stop, floor);

    // Last stop: prefer path end when close
    if (isLast && route.length >= 1) {
      const end = route[route.length - 1];
      const endErr = haversineM(stop.lat, stop.lon, end.lat, end.lon);
      if (!best || endErr <= (best.error ?? Infinity) + 25) {
        const cum = cumulativeDistances(route);
        best = {
          lon: end.lon,
          lat: end.lat,
          distanceAlong: cum[cum.length - 1] || 0,
          error: endErr,
        };
      }
    }
    // First stop: prefer path start when close
    if (isFirst && route.length >= 1) {
      const start = route[0];
      const startErr = haversineM(stop.lat, stop.lon, start.lat, start.lon);
      if (!best || startErr <= (best.error ?? Infinity) + 25) {
        best = {
          lon: start.lon,
          lat: start.lat,
          distanceAlong: 0,
          error: startErr,
        };
      }
    }

    if (!best) {
      // Should be rare — pin to nearest vertex
      let vBest = null;
      for (let i = 0; i < route.length; i++) {
        const err = haversineM(stop.lat, stop.lon, route[i].lat, route[i].lon);
        if (!vBest || err < vBest.error) {
          vBest = {
            lon: route[i].lon,
            lat: route[i].lat,
            distanceAlong: 0,
            error: err,
          };
        }
      }
      best = vBest;
    }
    if (!best) continue;

    minDist = Math.max(minDist, best.distanceAlong);
    out.push({
      id: stop.id || String(si),
      lon: best.lon,
      lat: best.lat,
      distanceAlong: best.distanceAlong,
      error: best.error,
    });
  }
  return out;
}

/**
 * Slice route polyline between first and last projected stop (inclusive).
 * @param {LngLat[]} route
 * @param {Array<{ lon: number, lat: number }>} orderedStops
 * @returns {LngLat[]}
 */
export function sliceRouteBetweenStops(route, orderedStops) {
  if (!route?.length || !orderedStops?.length) return [];
  if (orderedStops.length === 1) {
    return [{ lon: orderedStops[0].lon, lat: orderedStops[0].lat }];
  }

  const projected = projectStops(
    route,
    orderedStops.map((s, i) => ({
      id: String(i),
      lon: s.lon,
      lat: s.lat,
    })),
  );
  if (projected.length < 2) {
    return orderedStops.map((s) => ({ lon: s.lon, lat: s.lat }));
  }

  const d0 = projected[0].distanceAlong;
  const d1 = projected[projected.length - 1].distanceAlong;
  const start = route[0];
  const end = route[route.length - 1];
  const isLoop =
    !!start &&
    !!end &&
    haversineM(start.lat, start.lon, end.lat, end.lon) < 150;
  const first = orderedStops[0];
  const last = orderedStops[orderedStops.length - 1];
  const circularTrip =
    isLoop &&
    orderedStops.length >= 4 &&
    !!first &&
    !!last &&
    haversineM(first.lat, first.lon, last.lat, last.lon) < 150;
  if (circularTrip) {
    const cum = cumulativeDistances(route);
    const total = cum[cum.length - 1] || 0;
    const span = Math.abs(d1 - d0);
    // First and last are the same terminus — a min/max slice would be a
    // stub (or empty) and the map would fall back to stop chords (S64C).
    if (total > 400 && span < total * 0.15) {
      return route.map((p) => ({ lon: p.lon, lat: p.lat }));
    }
  }
  const from = Math.min(d0, d1);
  const to = Math.max(d0, d1);
  const slice = sliceByDistance(route, from, to);
  if (slice.length < 2) {
    return orderedStops.map((s) => ({ lon: s.lon, lat: s.lat }));
  }
  return slice;
}

/**
 * OSRM sometimes routes airport-island stops via HZMB Hong Kong Link Road /
 * the bridge (~90 km detour) when local access is restricted or mis-snapped
 * (e.g. Tung Chung → Chek Lap Kok South Road). Reject those legs and fall
 * back to a short chord so stop markers are not pulled onto the Link Road.
 */
const OSRM_MAX_DETOUR_RATIO = 3.5;
const OSRM_MAX_EXTRA_M = 2200;
/** Single hop this long is never a real bus segment between consecutive stops */
const OSRM_ABSURD_HOP_M = 12_000;
/** Multi-route total this long for a local densify is almost always a bridge loop */
const OSRM_ABSURD_TOTAL_M = 80_000;
/** Reject multi path if any original stop is farther than this from the line */
const OSRM_MAX_STOP_SNAP_M = 140;

// ── Terminal / endpoint approach guards ──────────────────────────────────────
// OSRM (car profile) misses bus-only terminal roads and often ends the route
// at the nearest drivable road — the wrong adjacent terminal or a parallel
// wrong road. These guards verify the approach of the FIRST and LAST hop of a
// leg against the straight board/alight chord; a path that fails is replaced
// with a short chord straight to the stop pin (same fallback OSRM already uses
// for rejected hops), so bus legs always reach their terminal stops.

/** OSRM path must end within this of the terminal stop, else reject */
const TERMINAL_MAX_END_SNAP_M = 140;
/** Approach points may drift this far sideways off the stop chord */
const TERMINAL_MAX_LATERAL_M = 95;
/** Approach bearing may deviate this much from the chord bearing */
const TERMINAL_MAX_BEARING_DEG = 70;
/** Within this end error the approach is trusted without further checks */
const TERMINAL_END_OK_M = 60;

/**
 * Densify stop sequence via OSRM driving (road-following bus approx).
 * Proxied at /osrm for COEP. Detour-rejects bad airport/HZMB legs.
 * @param {Array<{ lon: number, lat: number }>} stops
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<LngLat[]>}
 */
export async function densifyStopsViaOsrm(stops, opts = {}) {
  if (!stops || stops.length < 2) {
    return (stops || []).map((s) => ({ lon: s.lon, lat: s.lat }));
  }
  // OSRM is a live proxy — offline, skip the hang and use stop chords.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return stops.map((s) => ({ lon: s.lon, lat: s.lat }));
  }

  // Cap waypoints for public OSRM (URL length + latency). Keep ends + even sample.
  const MAX_WAYPOINTS = 28;
  const waypoints =
    stops.length <= MAX_WAYPOINTS
      ? stops
      : sampleStops(stops, MAX_WAYPOINTS);

  // Prefer one multi-waypoint request when the path stays near every stop
  try {
    const path = await osrmRoute(waypoints, opts.signal);
    if (
      path.length >= 2 &&
      osrmMultiPathPlausible(path, waypoints, stops) &&
      osrmMultiPathTerminalsOk(path, waypoints)
    ) {
      return path;
    }
    if (path.length >= 2) {
      console.warn(
        "[routeSnapper] OSRM multi-waypoint rejected (detour / far from stops / terminal approach) — pair densify",
      );
    }
  } catch (e) {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
    console.warn("[routeSnapper] multi-waypoint OSRM failed, trying pairs", e);
  }

  return densifyOsrmPairs(waypoints, opts.signal);
}

/**
 * Max lateral drift from the *original* user vertex when snapping (m).
 * Keeps Follow roads from jumping to a parallel highway.
 */
const FOLLOW_MAX_DRIFT_M = 70;
/** Max /nearest distance from a user point (m). */
const FOLLOW_NEAREST_MAX_M = 95;
/** Concurrent /nearest requests. */
const FOLLOW_NEAREST_CONCURRENCY = 8;
/** Max intermediate road points inserted per successful segment. */
const FOLLOW_MAX_INSERT_PER_SEG = 24;

/**
 * Contribution assistant: snap the *existing* path onto nearby road geometry.
 *
 * **Never deletes user points.** Each original vertex is kept (optionally
 * offset onto a road). Extra road vertices may be *added* only between
 * consecutive originals when OSRM can match that section. Sections OSRM
 * cannot handle are left as the user’s points (downgrade, not delete).
 *
 * @param {Array<number[] | { lon: number, lat: number }>} coords
 * @param {{
 *   signal?: AbortSignal,
 *   maxDriftM?: number,
 *   onProgress?: (ev: { phase: string, i?: number, n?: number, msg?: string }) => void,
 * }} [opts]
 * @returns {Promise<{
 *   path: LngLat[],
 *   method: "snap" | "unchanged",
 *   controls: number,
 *   snapped: number,
 *   inserted: number,
 *   keptRaw: number,
 *   debug?: FollowRoadsDebug,
 * }>}
 */
export async function followRoadsPath(coords, opts = {}) {
  const pts = normalizeLngLatList(coords);
  if (pts.length < 2) {
    return {
      path: pts,
      method: "unchanged",
      controls: pts.length,
      snapped: 0,
      inserted: 0,
      keptRaw: pts.length,
      debug: emptyFollowDebug(pts),
    };
  }

  const maxDrift = opts.maxDriftM ?? FOLLOW_MAX_DRIFT_M;
  const signal = opts.signal;
  /** @type {(ev: { phase: string, i?: number, n?: number, msg?: string }) => void} */
  const onProgress =
    typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  onProgress({ phase: "vertices", msg: t("Snapping vertices to nearest road…") });

  // ── 1) Per-vertex nearest snap — 1:1 with originals, never drop ──
  const vertexSnaps = await mapPool(
    pts,
    FOLLOW_NEAREST_CONCURRENCY,
    async (p, i) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const isEnd = i === 0 || i === pts.length - 1;
      try {
        const n = await osrmNearest(p, signal);
        if (
          n &&
          Number.isFinite(n.distanceM) &&
          n.distanceM <= FOLLOW_NEAREST_MAX_M
        ) {
          const drift = haversineM(p.lat, p.lon, n.lat, n.lon);
          // Ends: only tiny pull so board/alight stay put
          const lim = isEnd ? Math.min(25, maxDrift) : maxDrift;
          if (drift <= lim) {
            return {
              lon: n.lon,
              lat: n.lat,
              snapped: true,
              raw: false,
              driftM: drift,
            };
          }
          return {
            lon: p.lon,
            lat: p.lat,
            snapped: false,
            raw: true,
            driftM: drift,
            reason: "drift",
          };
        }
      } catch {
        /* keep raw */
      }
      return {
        lon: p.lon,
        lat: p.lat,
        snapped: false,
        raw: true,
        driftM: 0,
        reason: "no_road",
      };
    },
  );

  let snappedCount = vertexSnaps.filter((v) => v.snapped).length;
  let keptRaw = vertexSnaps.filter((v) => v.raw).length;
  let inserted = 0;

  /** @type {FollowRoadsDebugSegment[]} */
  const debugSegs = [];
  /** @type {LngLat[]} */
  const insertedPts = [];

  onProgress({
    phase: "segments",
    msg: t("Densifying segments OSRM can handle…"),
    n: pts.length - 1,
  });

  // ── 2) Between consecutive vertices: add road middles only if OSRM can ──
  /** @type {LngLat[]} */
  const out = [];
  for (let i = 0; i < vertexSnaps.length; i++) {
    const v = vertexSnaps[i];
    out.push({ lon: v.lon, lat: v.lat });

    if (i >= vertexSnaps.length - 1) break;

    const aOrig = pts[i];
    const bOrig = pts[i + 1];
    const aSnap = { lon: v.lon, lat: v.lat };
    const bSnap = {
      lon: vertexSnaps[i + 1].lon,
      lat: vertexSnaps[i + 1].lat,
    };

    const hopM = haversineM(aOrig.lat, aOrig.lon, bOrig.lat, bOrig.lon);
    if (hopM < 35) {
      debugSegs.push({
        i,
        status: "skip_short",
        method: null,
        a: aSnap,
        b: bSnap,
        mids: [],
      });
      continue;
    }

    if (i % 20 === 0) {
      onProgress({
        phase: "segments",
        i,
        n: vertexSnaps.length - 1,
        msg: t("Segment {n}/{total}", { n: i + 1, total: vertexSnaps.length - 1 }),
      });
    }

    let mids = null;
    let segMethod = null;
    try {
      const dens = await densifySegmentIfOsrmOk(aSnap, bSnap, aOrig, bOrig, {
        signal,
        maxDrift,
      });
      if (dens) {
        mids = dens.mids;
        segMethod = dens.method;
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      mids = null;
    }

    if (mids?.length) {
      /** @type {LngLat[]} */
      const keptMids = [];
      for (const m of mids) {
        if (haversineM(m.lat, m.lon, aSnap.lat, aSnap.lon) < 4) continue;
        if (haversineM(m.lat, m.lon, bSnap.lat, bSnap.lon) < 4) continue;
        out.push(m);
        keptMids.push(m);
        insertedPts.push(m);
        inserted += 1;
      }
      debugSegs.push({
        i,
        status: "densified",
        method: segMethod,
        a: aSnap,
        b: bSnap,
        mids: keptMids,
      });
    } else {
      debugSegs.push({
        i,
        status: "downgrade",
        method: null,
        a: aSnap,
        b: bSnap,
        mids: [],
      });
    }
  }

  const deduped = dedupePathClose(out, 1.5);
  const path =
    deduped.length >= pts.length
      ? deduped
      : vertexSnaps.map((v) => ({ lon: v.lon, lat: v.lat }));

  const changed =
    snappedCount > 0 ||
    inserted > 0 ||
    path.some(
      (p, i) =>
        i < pts.length &&
        haversineM(p.lat, p.lon, pts[i].lat, pts[i].lon) > 0.5,
    );

  /** @type {FollowRoadsDebug} */
  const debug = {
    original: pts.map((p) => ({ lon: p.lon, lat: p.lat })),
    vertices: pts.map((p, i) => ({
      original: { lon: p.lon, lat: p.lat },
      result: { lon: vertexSnaps[i].lon, lat: vertexSnaps[i].lat },
      snapped: !!vertexSnaps[i].snapped,
      raw: !!vertexSnaps[i].raw,
      driftM: Number(vertexSnaps[i].driftM) || 0,
      reason: vertexSnaps[i].reason || null,
    })),
    segments: debugSegs,
    inserted: insertedPts,
    result: path.map((p) => ({ lon: p.lon, lat: p.lat })),
  };

  onProgress({ phase: "done", msg: t("Done") });

  return {
    path,
    method: changed ? "snap" : "unchanged",
    controls: pts.length,
    snapped: snappedCount,
    inserted,
    keptRaw,
    debug,
  };
}

/**
 * @typedef {{
 *   i: number,
 *   status: "densified" | "downgrade" | "skip_short",
 *   method: "match" | "nearest" | null,
 *   a: LngLat,
 *   b: LngLat,
 *   mids: LngLat[],
 * }} FollowRoadsDebugSegment
 */

/**
 * @typedef {{
 *   original: LngLat[],
 *   vertices: Array<{
 *     original: LngLat,
 *     result: LngLat,
 *     snapped: boolean,
 *     raw: boolean,
 *     driftM: number,
 *     reason: string | null,
 *   }>,
 *   segments: FollowRoadsDebugSegment[],
 *   inserted: LngLat[],
 *   result: LngLat[],
 * }} FollowRoadsDebug
 */

/** @param {LngLat[]} pts */
function emptyFollowDebug(pts) {
  return {
    original: pts.map((p) => ({ lon: p.lon, lat: p.lat })),
    vertices: pts.map((p) => ({
      original: { lon: p.lon, lat: p.lat },
      result: { lon: p.lon, lat: p.lat },
      snapped: false,
      raw: true,
      driftM: 0,
      reason: null,
    })),
    segments: [],
    inserted: [],
    result: pts.map((p) => ({ lon: p.lon, lat: p.lat })),
  };
}

/**
 * Try to densify one segment onto roads. Returns intermediate points only
 * (not endpoints), or null if OSRM cannot handle this section.
 *
 * @param {LngLat} aSnap
 * @param {LngLat} bSnap
 * @param {LngLat} aOrig
 * @param {LngLat} bOrig
 * @param {{ signal?: AbortSignal, maxDrift?: number }} opts
 * @returns {Promise<{ mids: LngLat[], method: "match" | "nearest" } | null>}
 */
async function densifySegmentIfOsrmOk(aSnap, bSnap, aOrig, bOrig, opts) {
  const signal = opts.signal;
  const maxDrift = opts.maxDrift ?? FOLLOW_MAX_DRIFT_M;
  const chord = [
    { lon: aOrig.lon, lat: aOrig.lat },
    { lon: bOrig.lon, lat: bOrig.lat },
  ];
  const chordLen = pathLengthM(chord);

  // Prefer map-match of the two snapped ends (+ chord mid if long)
  /** @type {LngLat[]} */
  const seed = [{ lon: aSnap.lon, lat: aSnap.lat }];
  if (chordLen > 120) {
    seed.push({
      lon: (aOrig.lon + bOrig.lon) / 2,
      lat: (aOrig.lat + bOrig.lat) / 2,
    });
  }
  seed.push({ lon: bSnap.lon, lat: bSnap.lat });

  let matched = null;
  try {
    matched = await osrmMatch(seed, signal, {
      radiusesM: [30, 50, 70],
      gaps: "ignore",
    });
  } catch {
    matched = null;
  }

  if (matched?.length >= 2) {
    const mLen = pathLengthM(matched);
    // Reject re-routes that leave the user segment corridor
    const okLen =
      mLen < chordLen * 3.2 + 400 && mLen > chordLen * 0.45;
    const midOk =
      distPointToLngLatPolylineM(
        {
          lon: (aOrig.lon + bOrig.lon) / 2,
          lat: (aOrig.lat + bOrig.lat) / 2,
        },
        matched,
      ) <= maxDrift * 1.4;
    const endsOk =
      distPointToLngLatPolylineM(aSnap, matched) <= maxDrift &&
      distPointToLngLatPolylineM(bSnap, matched) <= maxDrift;

    if (okLen && midOk && endsOk) {
      return {
        mids: thinPathMids(matched, FOLLOW_MAX_INSERT_PER_SEG),
        method: "match",
      };
    }
  }

  // Fallback: sample along original segment + nearest each mid (no connectivity)
  const hopM = haversineM(aOrig.lat, aOrig.lon, bOrig.lat, bOrig.lon);
  if (hopM < 50) return null;

  const step = Math.min(45, Math.max(22, hopM / 6));
  const samples = sampleAlongPathMeters(
    [
      { lon: aOrig.lon, lat: aOrig.lat },
      { lon: bOrig.lon, lat: bOrig.lat },
    ],
    step,
  ).slice(1, -1);

  if (!samples.length) return null;

  const mids = await mapPool(
    samples,
    FOLLOW_NEAREST_CONCURRENCY,
    async (p) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const n = await osrmNearest(p, signal);
        if (
          n &&
          n.distanceM <= FOLLOW_NEAREST_MAX_M &&
          haversineM(p.lat, p.lon, n.lat, n.lon) <= maxDrift
        ) {
          return { lon: n.lon, lat: n.lat, ok: true };
        }
      } catch {
        /* skip */
      }
      return { lon: p.lon, lat: p.lat, ok: false };
    },
  );

  const okMids = mids.filter((m) => m.ok).map((m) => ({ lon: m.lon, lat: m.lat }));
  // Need a majority of mids on road, else leave segment as user chord only
  if (okMids.length < Math.ceil(samples.length * 0.5)) return null;
  return {
    mids: thinPathMids(okMids, FOLLOW_MAX_INSERT_PER_SEG),
    method: "nearest",
  };
}

/**
 * Keep up to maxN intermediate points (evenly spaced).
 * @param {LngLat[]} path full segment including ends optional
 * @param {number} maxN
 */
function thinPathMids(path, maxN) {
  if (!path?.length) return [];
  // Drop near-ends if present
  let mids = path;
  if (path.length > 2) {
    // keep all as candidates; caller already skips ends by distance
    mids = path;
  }
  if (mids.length <= maxN) {
    return mids.map((p) => ({ lon: p.lon, lat: p.lat }));
  }
  /** @type {LngLat[]} */
  const out = [];
  for (let i = 0; i < maxN; i++) {
    const t = (i + 1) / (maxN + 1);
    const idx = Math.min(mids.length - 1, Math.round(t * (mids.length - 1)));
    out.push({ lon: mids[idx].lon, lat: mids[idx].lat });
  }
  return out;
}

/** @param {LngLat[]} path @param {number} minM */
function dedupePathClose(path, minM) {
  if (!path?.length) return [];
  /** @type {LngLat[]} */
  const out = [{ lon: path[0].lon, lat: path[0].lat }];
  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    const prev = out[out.length - 1];
    if (haversineM(prev.lat, prev.lon, p.lat, p.lon) >= minM) {
      out.push({ lon: p.lon, lat: p.lat });
    }
  }
  // Always keep last
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (
    haversineM(tail.lat, tail.lon, last.lat, last.lon) >= minM * 0.5 ||
    out.length === 1
  ) {
    if (haversineM(tail.lat, tail.lon, last.lat, last.lon) > 0.2) {
      out.push({ lon: last.lon, lat: last.lat });
    }
  } else {
    out[out.length - 1] = { lon: last.lon, lat: last.lat };
  }
  return out;
}

/**
 * Walk polyline and emit points every stepM metres (+ endpoints).
 * @param {LngLat[]} pts
 * @param {number} stepM
 * @returns {LngLat[]}
 */
function sampleAlongPathMeters(pts, stepM) {
  if (!pts?.length) return [];
  if (pts.length === 1) return [{ lon: pts[0].lon, lat: pts[0].lat }];
  /** @type {LngLat[]} */
  const out = [{ lon: pts[0].lon, lat: pts[0].lat }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (seg < 1e-6) continue;
    let dist = stepM - carry;
    while (dist < seg) {
      const t = dist / seg;
      out.push({
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
      });
      dist += stepM;
    }
    carry = seg - (dist - stepM);
    // Always keep original vertex
    out.push({ lon: b.lon, lat: b.lat });
  }
  return out;
}

/**
 * Run async mapper with concurrency limit.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, i: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** @param {LngLat} p @param {LngLat[]} line */
function distPointToLngLatPolylineM(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = distPointToLngLatSegmentM(p, line[i], line[i + 1]);
    if (d < best) best = d;
  }
  if (!Number.isFinite(best) && line.length) {
    return haversineM(p.lat, p.lon, line[0].lat, line[0].lon);
  }
  return best;
}

/** @param {LngLat} p @param {LngLat} a @param {LngLat} b */
function distPointToLngLatSegmentM(p, a, b) {
  const lat0 = ((p.lat + a.lat + b.lat) / 3) * (Math.PI / 180);
  const cos = Math.cos(lat0);
  const mLat = 111320;
  const mLon = 111320 * cos;
  const px = (p.lon - a.lon) * mLon;
  const py = (p.lat - a.lat) * mLat;
  const bx = (b.lon - a.lon) * mLon;
  const by = (b.lat - a.lat) * mLat;
  const len2 = bx * bx + by * by;
  let t = len2 < 1e-9 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * @param {LngLat} p
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ lon: number, lat: number, distanceM: number } | null>}
 */
async function osrmNearest(p, signal) {
  const url =
    `${osrmBase()}/nearest/v1/driving/${p.lon},${p.lat}` + `?number=1`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OSRM nearest ${res.status}`);
  const data = await res.json();
  const w = data?.waypoints?.[0];
  if (!w?.location) return null;
  const lon = Number(w.location[0]);
  const lat = Number(w.location[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return {
    lon,
    lat,
    distanceM: Number(w.distance) || haversineM(p.lat, p.lon, lat, lon),
  };
}

/**
 * Pick editable control waypoints from a dense polyline:
 * endpoints + bearing turns + max spacing (for OSRM route/match).
 *
 * @param {LngLat[]} pts
 * @param {{ maxPoints?: number, minTurnDeg?: number, maxSpacingM?: number }} [opts]
 * @returns {LngLat[]}
 */
export function pathControlWaypoints(pts, opts = {}) {
  if (!pts?.length) return [];
  if (pts.length <= 2) return pts.map((p) => ({ lon: p.lon, lat: p.lat }));

  const maxPoints = opts.maxPoints ?? 28;
  const minTurnDeg = opts.minTurnDeg ?? 10;
  const maxSpacingM = opts.maxSpacingM ?? 260;

  /** @type {Set<number>} */
  const set = new Set([0, pts.length - 1]);

  for (let i = 1; i < pts.length - 1; i++) {
    const turn = polylineTurnDeg(pts[i - 1], pts[i], pts[i + 1]);
    if (turn >= minTurnDeg) set.add(i);
  }

  // Even spacing along path so long straights still get road densify anchors
  let since = 0;
  for (let i = 1; i < pts.length; i++) {
    since += haversineM(
      pts[i - 1].lat,
      pts[i - 1].lon,
      pts[i].lat,
      pts[i].lon,
    );
    if (since >= maxSpacingM) {
      set.add(i);
      since = 0;
    }
  }

  let idxs = [...set].sort((a, b) => a - b);
  if (idxs.length > maxPoints) {
    // Keep ends + evenly sample the rest
    const mid = idxs.slice(1, -1);
    const keepMid = maxPoints - 2;
    const sampled = [];
    for (let i = 0; i < keepMid; i++) {
      const j = Math.round((i * (mid.length - 1)) / Math.max(1, keepMid - 1));
      sampled.push(mid[Math.min(j, mid.length - 1)]);
    }
    idxs = [idxs[0], ...new Set(sampled), idxs[idxs.length - 1]].sort(
      (a, b) => a - b,
    );
  }

  return idxs.map((i) => ({ lon: pts[i].lon, lat: pts[i].lat }));
}

/**
 * @param {Array<number[] | { lon: number, lat: number }>} coords
 * @returns {LngLat[]}
 */
function normalizeLngLatList(coords) {
  if (!Array.isArray(coords)) return [];
  /** @type {LngLat[]} */
  const out = [];
  for (const c of coords) {
    if (!c) continue;
    if (Array.isArray(c) && c.length >= 2) {
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
    } else {
      const lon = Number(/** @type {any} */ (c).lon ?? /** @type {any} */ (c).lng);
      const lat = Number(/** @type {any} */ (c).lat);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
    }
  }
  return out;
}

/**
 * @param {LngLat} a
 * @param {LngLat} b
 * @param {LngLat} c
 */
function polylineTurnDeg(a, b, c) {
  const b1 = bearingDeg(a, b);
  const b2 = bearingDeg(b, c);
  if (!Number.isFinite(b1) || !Number.isFinite(b2)) return 0;
  let d = Math.abs(b2 - b1);
  if (d > 180) d = 360 - d;
  return d;
}

/** @param {LngLat} p @param {LngLat} q */
function bearingDeg(p, q) {
  const lon1 = (p.lon * Math.PI) / 180;
  const lon2 = (q.lon * Math.PI) / 180;
  const lat1 = (p.lat * Math.PI) / 180;
  const lat2 = (q.lat * Math.PI) / 180;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return NaN;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * OSRM map-matching — snap a trace onto the driving network.
 * @param {LngLat[]} points
 * @param {AbortSignal} [signal]
 * @returns {Promise<LngLat[] | null>}
 */
/**
 * OSRM map-matching — snap a trace onto the driving network.
 * @param {LngLat[]} points
 * @param {AbortSignal} [signal]
 * @param {{ radiusesM?: number[], gaps?: "split" | "ignore" }} [opts]
 * @returns {Promise<LngLat[] | null>}
 */
async function osrmMatch(points, signal, opts = {}) {
  if (!points || points.length < 2) return null;
  // Public OSRM match: keep request modest
  const trace =
    points.length <= 90
      ? points
      : pathControlWaypoints(points, { maxPoints: 90, maxSpacingM: 100 });
  const coordStr = trace.map((p) => `${p.lon},${p.lat}`).join(";");
  const radiusTries = opts.radiusesM?.length ? opts.radiusesM : [40, 75];
  // gaps=ignore: continue matching when the graph has holes (bus bays, etc.)
  const gaps = opts.gaps === "split" ? "split" : "ignore";

  for (const radiusM of radiusTries) {
    const radiuses = trace.map(() => radiusM).join(";");
    const url =
      `${osrmBase()}/match/v1/driving/${coordStr}` +
      `?overview=full&geometries=geojson&tidy=true&gaps=${gaps}&radiuses=${radiuses}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) continue;
      throw new Error(`OSRM match ${res.status}`);
    }
    const data = await res.json();
    const matchings = data?.matchings;
    if (!Array.isArray(matchings) || !matchings.length) continue;

    /** @type {LngLat[]} */
    const out = [];
    for (const m of matchings) {
      const coords = m?.geometry?.coordinates;
      if (!Array.isArray(coords)) continue;
      for (const c of coords) {
        if (!Array.isArray(c) || c.length < 2) continue;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (
          out.length &&
          out[out.length - 1].lon === lon &&
          out[out.length - 1].lat === lat
        ) {
          continue;
        }
        out.push({ lon, lat });
      }
    }
    if (out.length >= 2) return out;
  }
  return null;
}

/**
 * @param {Array<{ lon: number, lat: number }>} waypoints
 * @param {AbortSignal} [signal]
 */
async function densifyOsrmPairs(waypoints, signal) {
  const chunks = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const a = waypoints[i];
    const b = waypoints[i + 1];
    let path = null;
    try {
      path = await osrmRoute([a, b], signal);
    } catch (e) {
      if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
      path = null;
    }
    const isFirstHop = i === 0;
    const isLastHop = i === waypoints.length - 2;
    const endOk = path
      ? osrmHopPlausible(a, b, path) &&
        (!isFirstHop || terminalApproachOk(path, a, b, false)) &&
        (!isLastHop || terminalApproachOk(path, b, a, true))
      : false;
    if (!endOk) {
      if (path?.length >= 2) {
        console.warn(
          "[routeSnapper] OSRM hop rejected",
          hopDiag(a, b, path),
          "→ chord",
        );
      }
      path = chordDensify(a, b);
    }
    if (i === 0) chunks.push(...path);
    else chunks.push(...path.slice(1));
  }
  return chunks.length >= 2
    ? chunks
    : waypoints.map((s) => ({ lon: s.lon, lat: s.lat }));
}

/**
 * @param {{ lon: number, lat: number }} a
 * @param {{ lon: number, lat: number }} b
 * @param {LngLat[]} path
 */
function osrmHopPlausible(a, b, path) {
  if (!path || path.length < 2) return false;
  const straight = haversineM(a.lat, a.lon, b.lat, b.lon);
  const len = pathLengthM(path);
  if (!(len > 0) || !Number.isFinite(len)) return false;
  // Tiny hop
  if (straight < 40) return len < 600;
  // Classic HZMB loop: ~90 km for a ~1.5 km airport-island hop
  if (len >= OSRM_ABSURD_HOP_M && len > straight * 4) return false;
  if (len > straight * OSRM_MAX_DETOUR_RATIO + OSRM_MAX_EXTRA_M) return false;
  const endA = haversineM(a.lat, a.lon, path[0].lat, path[0].lon);
  const endB = haversineM(
    b.lat,
    b.lon,
    path[path.length - 1].lat,
    path[path.length - 1].lon,
  );
  if (endA > 350 || endB > 350) return false;
  return true;
}

/**
 * @param {LngLat[]} path
 * @param {Array<{ lon: number, lat: number }>} waypoints
 * @param {Array<{ lon: number, lat: number }>} allStops
 */
function osrmMultiPathPlausible(path, waypoints, allStops) {
  const pathLen = pathLengthM(path);
  if (pathLen >= OSRM_ABSURD_TOTAL_M) return false;

  let chordSum = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    chordSum += haversineM(
      waypoints[i].lat,
      waypoints[i].lon,
      waypoints[i + 1].lat,
      waypoints[i + 1].lon,
    );
  }
  if (chordSum < 50) return pathLen < 2000;
  if (pathLen > chordSum * OSRM_MAX_DETOUR_RATIO + waypoints.length * 600) {
    return false;
  }

  // Every original stop must sit near the drawn path — catches Link Road offsets
  // when Chek Lap Kok South Road was skipped as a waypoint or mis-routed.
  const check = allStops?.length ? allStops : waypoints;
  for (const s of check) {
    const n = nearestPointOnRoute(path, s, 0);
    if (!n || n.error > OSRM_MAX_STOP_SNAP_M) return false;
  }
  return true;
}

/**
 * Verify the approach of a multi-waypoint path into its FIRST/LAST waypoint:
 * the path must actually reach the endpoint (not stop on a parallel wrong
 * road) and the final segment must head toward it, not off sideways.
 * @param {LngLat[]} path
 * @param {Array<{ lon: number, lat: number }>} waypoints
 */
function osrmMultiPathTerminalsOk(path, waypoints) {
  if (!waypoints?.length || !path?.length) return false;
  if (waypoints.length >= 2) {
    // Start approach: orient so the terminal sits at the path END.
    const startTerm = waypoints[0];
    const startRoad = waypoints[1];
    if (!terminalApproachOk(path, startTerm, startRoad, false)) return false;
    // End approach.
    const endTerm = waypoints[waypoints.length - 1];
    const endRoad = waypoints[waypoints.length - 2];
    if (!terminalApproachOk(path, endTerm, endRoad, true)) return false;
  }
  return true;
}

/**
 * Is the OSRM path's approach into `term` (from neighbour stop `road`)
 * plausible? The last ~320 m of the approach must end near the terminal stop
 * and stay close to the straight chord, with a matching final bearing.
 * @param {LngLat[]} path
 * @param {{ lon: number, lat: number }} term terminal stop
 * @param {{ lon: number, lat: number }} road neighbouring stop
 * @param {boolean} atEnd true = terminal at path end, false = at path start
 */
function terminalApproachOk(path, term, road, atEnd) {
  const oriented = atEnd ? path : [...path].reverse();
  const sub = tailOfPathM(oriented, 320);
  if (!sub || sub.length < 2) return false;

  const endPt = sub[sub.length - 1];
  const endErr = haversineM(endPt.lat, endPt.lon, term.lat, term.lon);
  if (endErr <= TERMINAL_END_OK_M) return true;
  if (endErr > TERMINAL_MAX_END_SNAP_M) return false;

  // Suspicious band: approach must hug the chord toward the stop.
  if (maxLateralDeviationM(sub, road, term) > TERMINAL_MAX_LATERAL_M) {
    return false;
  }
  const appBearing = bearingDeg(sub[sub.length - 2], endPt);
  const chordBearing = bearingDeg(road, term);
  let diff = Math.abs(appBearing - chordBearing);
  if (diff > 180) diff = 360 - diff;
  if (diff > TERMINAL_MAX_BEARING_DEG) return false;
  return true;
}

/** Keep the tail of a polyline up to maxM metres (always includes the end). */
function tailOfPathM(path, maxM) {
  if (!path?.length) return [];
  const out = [];
  let acc = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    out.unshift(path[i]);
    if (i > 0) {
      acc += haversineM(
        path[i].lat,
        path[i].lon,
        path[i - 1].lat,
        path[i - 1].lon,
      );
      if (acc >= maxM) break;
    }
  }
  return out;
}

/** Max distance of any path point from the a→b straight chord. */
function maxLateralDeviationM(path, a, b) {
  let worst = 0;
  for (const p of path) {
    const d = distPointToLngLatSegmentM(p, a, b);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * @param {{ lon: number, lat: number }} a
 * @param {{ lon: number, lat: number }} b
 * @param {LngLat[]} path
 */
function hopDiag(a, b, path) {
  return {
    straightM: Math.round(haversineM(a.lat, a.lon, b.lat, b.lon)),
    pathM: Math.round(pathLengthM(path)),
  };
}

/** @param {LngLat[]} path */
function pathLengthM(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += haversineM(
      path[i - 1].lat,
      path[i - 1].lon,
      path[i].lat,
      path[i].lon,
    );
  }
  return d;
}

/**
 * Straight densified segment when OSRM is unusable (keeps stop order / pin home).
 * @param {{ lon: number, lat: number }} a
 * @param {{ lon: number, lat: number }} b
 * @param {number} [stepM]
 */
function chordDensify(a, b, stepM = 45) {
  const d = haversineM(a.lat, a.lon, b.lat, b.lon);
  if (!(d > stepM)) {
    return [
      { lon: a.lon, lat: a.lat },
      { lon: b.lon, lat: b.lat },
    ];
  }
  const n = Math.min(48, Math.max(2, Math.ceil(d / stepM)));
  /** @type {LngLat[]} */
  const out = [{ lon: a.lon, lat: a.lat }];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push({
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    });
  }
  out.push({ lon: b.lon, lat: b.lat });
  return out;
}

/** Evenly sample intermediate stops, always keeping first + last. */
function sampleStops(stops, maxN) {
  if (stops.length <= maxN) return stops;
  const out = [stops[0]];
  const mid = maxN - 2;
  for (let i = 1; i <= mid; i++) {
    const idx = Math.round((i * (stops.length - 1)) / (mid + 1));
    out.push(stops[idx]);
  }
  out.push(stops[stops.length - 1]);
  // Dedupe consecutive identical indices
  return out.filter((s, i, arr) => i === 0 || s !== arr[i - 1]);
}

/**
 * Build a display polyline for a transit leg:
 *  - rail / LRT / tram → basemap railway shapes (Protomaps roads kind=rail)
 *  - bus → OSRM road densify
 *  - else stop chords
 */
export async function buildTransitPolyline(opt, opts = {}) {
  const stops = (opt.stops?.length ? opt.stops : [opt.from, opt.to].filter(Boolean))
    .map((s, i) => ({
      id: s.stop_id || s.id || String(i),
      lon: s.location?.lon ?? s.lon,
      lat: s.location?.lat ?? s.lat,
      // Keep names for LRT shape overrides (e.g. Ginza → Tin Wing YOHO West)
      stop_name: s.stop_name || s.name || s.address || "",
      name: s.stop_name || s.name || "",
      platform: s.platform || s.platform_code || "",
    }))
    .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));

  if (stops.length < 2) return stops;

  // Optional full shape (if preloaded index provides it)
  if (opts.routeLine && opts.routeLine.length >= 2) {
    return sliceRouteBetweenStops(opts.routeLine, stops);
  }

  const mode = String(opt.mode || "").toLowerCase();
  const lineCode = detectMtrLineCode(opt);
  const isRail =
    mode === "subway" ||
    mode === "rail" ||
    mode === "light_rail" ||
    mode === "tram" ||
    mode === "monorail" ||
    mode === "metro" ||
    mode === "funicular" ||
    !!lineCode ||
    opts.forceRail;
  const isFerry = mode === "ferry" || mode === "boat";

  // MTR / LRT / tram: follow basemap track geometry
  if (isRail && !opts.forceOsrm) {
    try {
      const { densifyAlongBasemapRail } = await import("./railSnapper.js");
      const railPoly = await densifyAlongBasemapRail(stops, opt, opts);
      if (railPoly && railPoly.length >= 2) return railPoly;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      console.warn("[routeSnapper] basemap rail densify failed", e);
    }
    // fall through to stop chords
    return stops.map((s) => ({ lon: s.lon, lat: s.lat }));
  }

  // Reviewed contributor bus path (exact route, else similar corridor override)
  if ((!isRail && !isFerry) || opts.forceOsrm) {
    try {
      const { matchBusShapeOverride, busShapeToPolyline } = await import(
        "./busShapes.js"
      );
      const shape = matchBusShapeOverride(opt);
      if (shape) {
        const poly = busShapeToPolyline(shape, stops, sliceRouteBetweenStops);
        if (poly?.length >= 2) {
          const own =
            String(shape.route_short_name || "")
              .trim()
              .toUpperCase() ===
            String(opt?.route_short_name || "")
              .trim()
              .toUpperCase();
          if (!own) {
            console.info(
              "[routeSnapper] using similar published path",
              shape.route_short_name || shape.id,
              "for",
              opt?.route_short_name,
            );
          }
          return poly;
        }
      }
    } catch (e) {
      console.warn("[routeSnapper] bus shape override", e);
    }
  }

  // GTFS operator polyline (real terminal loops) — lazy, cached, never throws
  if ((!isRail && !isFerry) || opts.forceOsrm) {
    try {
      const { getGtfsBusShape } = await import("./routeShapes.js");
      const gtfs = await getGtfsBusShape(opt, opts);
      if (gtfs?.coords?.length >= 2) {
        let poly = sliceRouteBetweenStops(gtfs.coords, stops);
        if (!polylineCoversStops(poly, stops, gtfs.coords)) {
          // Slice collapsed (same terminus) — try the unsliced corridor
          if (polylineCoversStops(gtfs.coords, stops)) {
            poly = gtfs.coords.map((p) => ({ lon: p.lon, lat: p.lat }));
          } else {
            poly = null;
          }
        }
        if (poly?.length >= 2) {
          // Keep the GTFS corridor (S64C AM loop / PM inbound). OSRM on Chek
          // Lap Kok hops the Link Road. Sparse stop-seq shapes (S1) still
          // densify via OSRM; everyone else interpolates along the operator
          // line so zooming does not collapse to stop chords.
          if (gtfs.sparse) {
            try {
              const dens = await densifyStopsViaOsrm(poly, opts);
              if (dens?.length >= 2) return densifyAlongPolyline(dens);
            } catch (e) {
              if (e?.name === "AbortError") throw e;
              console.warn("[routeSnapper] sparse GTFS OSRM densify", e);
            }
          }
          return densifyAlongPolyline(poly);
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      console.warn("[routeSnapper] GTFS bus shape", e);
    }
  }

  // Road-following for bus / surface modes (needs the live OSRM proxy)
  if (
    ((!isRail && !isFerry) || opts.forceOsrm) &&
    !(typeof navigator !== "undefined" && navigator.onLine === false)
  ) {
    try {
      return await densifyStopsViaOsrm(stops, opts);
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      console.warn("[routeSnapper] OSRM densify failed", e);
    }
  }

  return stops.map((s) => ({ lon: s.lon, lat: s.lat }));
}

/**
 * Extra vertices along an existing polyline (no reroute). GTFS hops are
 * ~80–120 m; without this, zoom-in looks like stop chords. S64C PM uses
 * this on the inbound shape — not OSRM.
 */
function densifyAlongPolyline(poly, maxStepM = 22) {
  if (!poly?.length || poly.length < 2) return poly || [];
  /** @type {LngLat[]} */
  const out = [{ lon: poly[0].lon, lat: poly[0].lat }];
  for (let i = 1; i < poly.length; i++) {
    const a = out[out.length - 1];
    const b = poly[i];
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    const n = Number.isFinite(d) && d > maxStepM ? Math.ceil(d / maxStepM) : 1;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      out.push({
        lon: a.lon + (b.lon - a.lon) * f,
        lat: a.lat + (b.lat - a.lat) * f,
      });
    }
  }
  return out;
}

function isClosedLoop(pts, maxM = 150) {
  if (!pts?.length || pts.length < 4) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (
    !Number.isFinite(a?.lon) ||
    !Number.isFinite(a?.lat) ||
    !Number.isFinite(b?.lon) ||
    !Number.isFinite(b?.lat)
  ) {
    return false;
  }
  return haversineM(a.lat, a.lon, b.lat, b.lon) < maxM;
}

/**
 * Accept a GTFS slice unless it is a short fragment that misses the stops
 * (S64C inbound stub). Closed loops (S64C AM) always keep the full circuit —
 * cargo stops can sit off the GTFS line; rejecting them dropped the loop
 * and painted zoom chords.
 */
function polylineCoversStops(poly, stops, fullCoords = null) {
  if (!poly?.length || !stops?.length) return false;
  const usable = stops.filter(
    (s) => Number.isFinite(s?.lon) && Number.isFinite(s?.lat),
  );
  if (usable.length < 2) return poly.length >= 2;
  if (isClosedLoop(poly) && isClosedLoop(usable) && poly.length >= 8) {
    return true;
  }
  let ok = 0;
  for (const s of usable) {
    const p = nearestPointOnRoute(poly, s);
    if (p && p.error <= 180) ok += 1;
  }
  if (ok / usable.length >= 0.72) return true;
  if (
    fullCoords &&
    isClosedLoop(fullCoords) &&
    fullCoords.length > poly.length * 1.5
  ) {
    return false;
  }
  return ok / usable.length >= 0.55;
}

// ── internals ────────────────────────────────────────────────────────────────

function osrmBase() {
  // Same-origin proxy under COEP (see vite.config.js)
  return `${location.origin}/osrm`;
}

/** Cap OSRM latency: a hung upstream falls back to stop chords instead of
 *  blocking the route paint forever (no caller supplies a timeout signal). */
const OSRM_TIMEOUT_MS = 12000;

/**
 * @param {Array<{ lon: number, lat: number }>} points
 * @param {AbortSignal} [signal]
 */
async function osrmRoute(points, signal) {
  if (!points || points.length < 2) {
    return (points || []).map((p) => ({ lon: p.lon, lat: p.lat }));
  }
  const coordStr = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url =
    `${osrmBase()}/route/v1/driving/${coordStr}` +
    `?overview=full&geometries=geojson&steps=false`;
  // Own abort controller: hard timeout + forward the caller's signal.
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("OSRM timeout", "TimeoutError")),
    OSRM_TIMEOUT_MS,
  );
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      return points.map((p) => ({ lon: p.lon, lat: p.lat }));
    }
    return coords.map(([lon, lat]) => ({ lon, lat }));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function cumulativeDistances(route) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    cum.push(cum[i - 1] + haversineM(a.lat, a.lon, b.lat, b.lon));
  }
  return cum;
}

function projectPointToSegment(p, a, b) {
  // Equirectangular local projection for short segments
  const cos = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lon * cos;
  const ay = a.lat;
  const bx = b.lon * cos;
  const by = b.lat;
  const px = p.lon * cos;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 < 1e-18 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const lon = a.lon + (b.lon - a.lon) * t;
  const lat = a.lat + (b.lat - a.lat) * t;
  const err = haversineM(p.lat, p.lon, lat, lon);
  return { t, lon, lat, err };
}

function nearestOnRouteForward(stop, route, cum, minDist) {
  let best = null;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const segLen = haversineM(a.lat, a.lon, b.lat, b.lon);
    const { t, lon, lat, err } = projectPointToSegment(stop, a, b);
    const along = cum[i] + t * segLen;
    if (along + 1 < minDist) continue;
    if (!best || err < best.err) best = { lon, lat, distanceAlong: along, err };
  }
  return best;
}

function sliceByDistance(route, fromDist, toDist) {
  const cum = cumulativeDistances(route);
  const out = [];
  // start point
  out.push(pointAtDistance(route, cum, fromDist));
  for (let i = 1; i < route.length - 1; i++) {
    if (cum[i] > fromDist && cum[i] < toDist) {
      out.push({ lon: route[i].lon, lat: route[i].lat });
    }
  }
  out.push(pointAtDistance(route, cum, toDist));
  return out;
}

function pointAtDistance(route, cum, dist) {
  if (dist <= 0) return { lon: route[0].lon, lat: route[0].lat };
  const total = cum[cum.length - 1];
  if (dist >= total) {
    const last = route[route.length - 1];
    return { lon: last.lon, lat: last.lat };
  }
  for (let i = 0; i < route.length - 1; i++) {
    if (cum[i + 1] >= dist) {
      const segLen = cum[i + 1] - cum[i];
      const t = segLen < 1e-9 ? 0 : (dist - cum[i]) / segLen;
      const a = route[i];
      const b = route[i + 1];
      return {
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
      };
    }
  }
  const last = route[route.length - 1];
  return { lon: last.lon, lat: last.lat };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
