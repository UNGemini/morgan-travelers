/**
 * Lazy GTFS bus-shape index (built by scripts/build-bus-shapes-index.mjs).
 *
 * Gives bus legs their real operator polyline (incl. terminal loops) instead
 * of the OSRM car-profile densification that misses bus-only terminal roads,
 * snaps to the wrong adjacent terminal, or picks a parallel wrong road.
 *
 * Loading is lazy + cached: only the agency file for a drawn leg is fetched,
 * once per session. Any failure falls back to the caller's existing path
 * (contributor overrides / OSRM) — never throws.
 *
 * Index layout (public/data/bus-shapes/):
 *   index.json      → { v, updated_at, files: {agency: file}, route_file: {ROUTE_ID: agency} }
 *   <agency>.json   → { v, updated_at, routes: { <route_id>: { sn, shapes: [ {d,h,c} ], st } } }
 *     c = flat int array [lon0e5, lat0e5, dLon, dLat, …] (1e-5 deg ≈ 1.1 m)
 *     h = headsigns (terminal names) used for direction disambiguation
 *     d = GTFS direction_id ("0" / "1")
 *     st = stop sequences per direction: { dir: [stopIndex, …] } into stops.json
 *   stops.json      → { v, updated_at, n: [names], s: [[id, lonE5, latE5, nameIdx], …] }
 *     shared directory; lets route-detail render stop lists + map pins offline
 */

/** @typedef {{ lon: number, lat: number }} LngLat */

/**
 * Agency family aliases: joint KMB+LWB routes may surface as LWB-*, and MTR
 * Bus routes as MTRB-* / LRTFEEDER-* / MTRBUS-* (the feed's MTRB agency ships
 * no shapes today, but the index build emits any agency that has geometry,
 * so these aliases pick MTR Bus shapes up automatically if the feed gains them).
 */
const AGENCY_ALIAS = {
  lwb: "kmb",
  mtrb: "mtrb",
  lrtfeeder: "mtrb",
  mtrbus: "mtrb",
};

/**
 * Joint KMB+CTB cross-harbour routes: the feed models them under KMB only
 * (CTB-101 has no geometry; KMB-101 does — same corridor, same stops).
 * When the CTB half is absent we fall back to the KMB sibling shape; the
 * stop-projection slicing downstream still rejects a mismatched corridor.
 * One-way only: KMB→CTB would risk same-number routes with different
 * corridors (e.g. KMB 8 vs CTB 8).
 */
const SIBLING_AGENCY = { ctb: "kmb" };

const BASE = () =>
  new URL(`${import.meta.env.BASE_URL}data/bus-shapes/`, window.location.href)
    .href;

/** @type {Map<string, Promise<any>>} */
const cache = new Map();

function deviceOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

async function fetchJson(url, signal) {
  const offline = deviceOffline();
  const res = await fetch(url, {
    signal,
    // Online: revalidate. Offline: use the SW / HTTP cache — no-cache would
    // try the network and fail even when the full dataset is downloaded.
    cache: offline ? "force-cache" : "no-cache",
  });
  if (!res.ok) throw new Error(`bus-shapes ${res.status} ${url}`);
  try {
    return await res.json();
  } catch (e) {
    if (offline) throw e;
    // Truncated/corrupt cached body (HTTP cache or SW) — retry once with
    // caches bypassed so a bad copy can't silently kill every route's path.
    console.warn("[bus-shapes] json parse failed, retrying uncached", url, e);
    const res2 = await fetch(url, { signal, cache: "reload" });
    if (!res2.ok) throw new Error(`bus-shapes ${res2.status} ${url}`);
    return res2.json();
  }
}

/** @returns {Promise<any|null>} */
function loadIndex(signal) {
  const url = `${BASE()}index.json`;
  if (!cache.has(url)) {
    cache.set(
      url,
      fetchJson(url, signal).catch((e) => {
        cache.delete(url);
        throw e;
      }),
    );
  }
  return cache.get(url);
}

/** @returns {Promise<any|null>} */
function loadAgencyFile(file, signal) {
  const url = `${BASE()}${file}`;
  if (!cache.has(url)) {
    cache.set(
      url,
      fetchJson(url, signal).catch((e) => {
        cache.delete(url);
        throw e;
      }),
    );
  }
  return cache.get(url);
}

/** Decode delta-encoded flat int array → LngLat[]. */
function decodeCoords(ints) {
  if (!Array.isArray(ints) || ints.length < 4) return null;
  /** @type {LngLat[]} */
  const out = [{ lon: ints[0] / 1e5, lat: ints[1] / 1e5 }];
  for (let i = 2; i < ints.length - 1; i += 2) {
    const prev = out[out.length - 1];
    out.push({
      lon: prev.lon + ints[i] / 1e5,
      lat: prev.lat + ints[i + 1] / 1e5,
    });
  }
  return out;
}

/**
 * Project a lon/lat onto segment a→b (equirectangular, metres).
 * @param {{ lon: number, lat: number }} a
 * @param {{ lon: number, lat: number }} b
 * @param {number} lon
 * @param {number} lat
 * @returns {{ t: number, lon: number, lat: number, d: number } | null}
 */
function projectOnSegment(a, b, lon, lat) {
  const cos = Math.cos((((a.lat + b.lat + lat) / 3) * Math.PI) / 180);
  const ax = a.lon * cos;
  const ay = a.lat;
  const bx = b.lon * cos;
  const by = b.lat;
  const px = lon * cos;
  const py = lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return null;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qlon = a.lon + (b.lon - a.lon) * t;
  const qlat = a.lat + (b.lat - a.lat) * t;
  const dLat = (lat - qlat) * (Math.PI / 180);
  const dLon = (lon - qlon) * (Math.PI / 180);
  return {
    t,
    lon: qlon,
    lat: qlat,
    d: 6371000 * Math.hypot(dLat, dLon * Math.cos((lat * Math.PI) / 180)),
  };
}

/**
 * Forward-monotonic projection of one stop onto a polyline: nearest segment
 * at or after searchFrom, with far-ahead segments penalised by 30% of their
 * distance-along gap beyond a 1500 m free zone — on circular routes the loop
 * closure re-approaches the terminus, and without the penalty an early stop
 * can snap onto the return leg, corrupting orientation scoring (and later
 * passed/remaining cuts). The free zone keeps the penalty from biasing a
 * genuine visit a few hundred metres ahead of the search floor.
 * Returns the segment-end vertex index + cut point.
 * @param {LngLat[]} coords
 * @param {number} lon
 * @param {number} lat
 * @param {number} searchFrom
 * @returns {{ segEnd: number, d: number, lon: number, lat: number } | null}
 */
function projectStopMonotonic(coords, lon, lat, searchFrom) {
  let best = null;
  let along = 0;
  for (let i = Math.max(0, searchFrom); i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    if (
      !Number.isFinite(a?.lon) ||
      !Number.isFinite(a?.lat) ||
      !Number.isFinite(b?.lon) ||
      !Number.isFinite(b?.lat)
    ) {
      continue;
    }
    const p = projectOnSegment(a, b, lon, lat);
    if (p) {
      // Nearest wins, but segments far ahead of the search floor pay a
      // distance penalty (1500 m free zone) so a loop closure cannot beat
      // the real visit.
      const score = p.d + Math.max(0, along - 1500) * 0.3;
      if (!best || score < best.score) {
        best = { segEnd: i + 1, d: p.d, score, lon: p.lon, lat: p.lat };
      }
    }
    // Segment length (equirectangular, metres) for the far-ahead penalty.
    const cos = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLon = (b.lon - a.lon) * (Math.PI / 180);
    along += 6371000 * Math.hypot(dLat, dLon * cos);
  }
  return best
    ? { segEnd: best.segEnd, d: best.d, lon: best.lon, lat: best.lat }
    : null;
}

/**
 * Average forward-projection error of stops onto a polyline (metres).
 * A shape running opposite the stop order scores huge because the monotonic
 * search pins late stops near the line end.
 * @param {LngLat[]} coords
 * @param {Array<{ lon?: number, lat?: number }>} stops
 */
function orientationScore(coords, stops) {
  let score = 0;
  let n = 0;
  let searchFrom = 0;
  for (const s of stops) {
    if (!s || !Number.isFinite(s.lon) || !Number.isFinite(s.lat)) continue;
    const p = projectStopMonotonic(coords, s.lon, s.lat, searchFrom);
    if (!p) return Infinity;
    score += p.d;
    n += 1;
    searchFrom = p.segEnd;
  }
  return n ? score / n : Infinity;
}

/**
 * Orient a decoded shape to the stop travel order. When the reversed shape
 * fits the stop sequence clearly better (headsign match failed and the
 * fallback shape is the opposite direction), flip it so downstream slicing
 * and passed/remaining cuts follow the real travel order.
 * @param {LngLat[]} coords
 * @param {Array<{ lon?: number, lat?: number }>} stops
 */
function orientShapeToStops(coords, stops) {
  const usable = stops.filter(
    (s) => s && Number.isFinite(s.lon) && Number.isFinite(s.lat),
  );
  if (usable.length < 3 || !coords || coords.length < 2) return;
  const fwd = orientationScore(coords, usable);
  if (!(fwd > 250)) return; // already tracks the stop order
  const rev = orientationScore([...coords].reverse(), usable);
  if (rev < fwd * 0.5) {
    coords.reverse();
  }
}

/**
 * Cumulative metres along a decoded polyline (equirectangular, same math as
 * projectStopMonotonic so distances agree with the stop snapping).
 * Returns an array of the same length as coords.
 * @param {LngLat[]} coords
 * @returns {number[]}
 */
export function cumulativeMeters(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    if (
      !Number.isFinite(a?.lon) ||
      !Number.isFinite(a?.lat) ||
      !Number.isFinite(b?.lon) ||
      !Number.isFinite(b?.lat)
    ) {
      cum.push(cum[i - 1]);
      continue;
    }
    const cos = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLon = (b.lon - a.lon) * (Math.PI / 180);
    cum.push(cum[i - 1] + 6371000 * Math.hypot(dLat, dLon * cos));
  }
  return cum;
}

/**
 * Project a lon/lat onto a polyline in travel order, returning metres-along
 * the shape. Uses the same nearest-segment-with-far-ahead-penalty rule as
 * projectStopMonotonic so the along-distance agrees with the monotonic stop
 * snapping used by the bus-position engine.
 * @param {LngLat[]} coords
 * @param {number} lon
 * @param {number} lat
 * @param {number} [searchFrom] vertex index to start searching from
 * @returns {{ alongM: number, segEnd: number, lon: number, lat: number, d: number } | null}
 */
export function projectOntoShape(coords, lon, lat, searchFrom = 0) {
  const mono = projectStopMonotonic(coords, lon, lat, searchFrom);
  if (!mono) return null;
  const cum = cumulativeMeters(coords);
  const start = Math.max(0, Math.min(mono.segEnd - 1, cum.length - 1));
  let alongM = cum[start] ?? 0;
  const a = coords[mono.segEnd - 1];
  const b = coords[mono.segEnd];
  if (
    a &&
    b &&
    Number.isFinite(a?.lon) &&
    Number.isFinite(a?.lat) &&
    Number.isFinite(b?.lon) &&
    Number.isFinite(b?.lat)
  ) {
    const p = projectOnSegment(a, b, lon, lat);
    if (p) {
      const segLen = (cum[mono.segEnd] ?? cum[start]) - (cum[start] ?? 0);
      alongM += segLen * p.t;
    }
  }
  return { alongM, segEnd: mono.segEnd, lon: mono.lon, lat: mono.lat, d: mono.d };
}

function routeIdKey(routeId) {
  return String(routeId || "").toUpperCase().replace(/\s+/g, "");
}

/**
 * Load shape index + the route's agency file (network part only, no decode).
 * Shares the per-URL cache with getGtfsBusShape, so prefetching this early
 * (e.g. while operator stop sequences load) makes the later lookup instant.
 * @param {{ route_id?: string, route_short_name?: string }} opt
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ data: any, entry: any, ridKey: string } | null>}
 */
async function resolveShapeData(opt, signal) {
  const idx = await loadIndex(signal);
  if (!idx?.route_file) return null;

  const ridKey = routeIdKey(opt?.route_id);
  const agency = ridKey ? idx.route_file[ridKey] : null;

  // Short-name fallback: scan the agency file derived from the option.
  let data = null;
  if (agency && idx.files?.[agency]) {
    data = await loadAgencyFile(idx.files[agency], signal);
  } else if (ridKey) {
    // Index may lack the id — try prefix heuristic (e.g. KMB-E42 → kmb)
    const prefix = ridKey.split(/[_-]/)[0].toLowerCase();
    const file = idx.files?.[prefix] || idx.files?.[AGENCY_ALIAS[prefix]];
    if (file) data = await loadAgencyFile(file, signal);
  }
  if (!data?.routes) return null;

  let entry = ridKey ? data.routes[ridKey] : null;
  if (!entry) {
    // Scan by short name within the agency file
    const short = String(opt?.route_short_name || "")
      .trim()
      .toUpperCase();
    if (short) {
      for (const r of Object.values(data.routes)) {
        if (String(r?.sn || "").toUpperCase() === short) {
          entry = r;
          break;
        }
      }
    }
  }
  // Joint KMB+CTB routes surface as CTB-* in the app but have geometry only
  // under KMB in the feed — reuse the sibling shape for the same corridor.
  if (!entry && ridKey) {
    const prefix = ridKey.split(/[_-]/)[0].toLowerCase();
    const sibling = SIBLING_AGENCY[prefix];
    const file = sibling ? idx.files?.[sibling] : null;
    if (file) {
      const siblingData = await loadAgencyFile(file, signal);
      const siblingKey = `${sibling.toUpperCase()}-${ridKey.slice(
        prefix.length + 1,
      )}`;
      entry = siblingData?.routes?.[siblingKey] || null;
      if (entry) {
        console.info(
          "[bus-shapes] joint sibling fallback",
          ridKey,
          "→",
          siblingKey,
        );
      }
    }
  }
  if (!entry) return null;
  return { data, entry, ridKey };
}

/**
 * Best shape for a bus leg. Direction-aware: when the wanted GTFS direction
 * is known (ETA bound O/I or explicit direction_id), shapes of that direction
 * win — the same direction grouping that built the st stop sequences, so the
 * picked corridor always matches the stop list. Headsign (terminal) matching
 * on the destination, then origin, stays as tiebreak / fallback for legs
 * without a known direction (e.g. trip-plan options).
 * @param {any} routeEntry
 * @param {{ from?: string, to?: string }} names
 * @param {string|null} [wantDir] "0" | "1" | null
 */
function pickShape(routeEntry, names, wantDir = null) {
  const shapes = routeEntry?.shapes;
  if (!Array.isArray(shapes) || !shapes.length) return null;
  const to = String(names?.to || "").toLowerCase();
  const from = String(names?.from || "").toLowerCase();
  if (shapes.length === 1) return shapes[0];

  let best = null;
  let bestScore = -1;
  for (const s of shapes) {
    let score = 0;
    if (wantDir != null && String(s.d) === String(wantDir)) score += 50;
    for (const h of s.h || []) {
      const hs = String(h).toLowerCase();
      if (to && hs && (hs.includes(to) || to.includes(hs))) score += 20;
      else if (from && hs && (hs.includes(from) || from.includes(hs)))
        score += 8;
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best || shapes[0];
}

/**
 * Warm the shape cache for a route without decoding/picking (best-effort,
 * never throws). Call early — e.g. while operator stop sequences load — so
 * the paint path hits the warm cache instead of a fresh multi-MB fetch.
 * @param {{ route_id?: string, route_short_name?: string }} opt
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function preloadGtfsBusShape(opt, opts = {}) {
  try {
    await resolveShapeData(opt, opts.signal);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    // Best-effort: the real lookup will retry or fall back.
  }
}

/**
 * Resolve the GTFS polyline for a bus leg, or null when unavailable.
 * Never throws — returns null on any failure so callers fall back.
 * @param {{ route_id?: string, route_short_name?: string, agency?: { id?: string, name?: string }, from?: any, to?: any, bound?: string, direction_id?: string|number, headsign?: string, stops?: any[] }} opt
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ coords: LngLat[], route_id: string, headsign?: string, cumM: number[] } | null>}
 */
export async function getGtfsBusShape(opt, opts = {}) {
  try {
    const signal = opts.signal;
    const resolved = await resolveShapeData(opt, signal);
    if (!resolved?.entry) return null;
    const { entry, ridKey } = resolved;

    // Wanted GTFS direction: ETA bound (O/I) or an explicit direction_id.
    // Matches the direction grouping that built the st stop sequences, so
    // prefer that corridor over headsign guessing (stop-name vs headsign
    // substring matches are fragile — parens, suffixes, cross-direction
    // terminal names). Trip-plan options without a bound fall back to
    // headsign matching below.
    const wantDir =
      opt.direction_id != null
        ? String(opt.direction_id)
        : opt.bound === "I"
          ? "1"
          : opt.bound === "O"
            ? "0"
            : null;
    const names = {
      to:
        opt?.to?.stop_name ||
        opt?.to?.name ||
        opt?.headsign ||
        "",
      from: opt?.from?.stop_name || opt?.from?.name || "",
    };
    const shape = pickShape(entry, names, wantDir);
    const coords = shape ? decodeCoords(shape.c) : null;
    if (!coords || coords.length < 2) return null;

    // Direction guard: the picked shape must run with the stop order (see
    // orientShapeToStops). Flipping here fixes wrong passed/remaining cuts
    // on the ETA map and keeps trip-plan slices in travel order.
    const stops = Array.isArray(opt?.stops) && opt.stops.length >= 3
      ? opt.stops
      : [opt?.from, opt?.to].filter(Boolean);
    orientShapeToStops(coords, stops);

    console.info(
      "[bus-shapes] gtfs shape",
      entry.sn || ridKey,
      "→",
      coords.length,
      "pts",
      shape?.h?.[0] ? `(dir ${shape.h[0]})` : "",
    );
    return { coords, route_id: ridKey, headsign: shape?.h?.[0], cumM: cumulativeMeters(coords) };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    console.warn("[bus-shapes] shape lookup failed, falling back", e);
    return null;
  }
}

/**
 * Load the shared stop directory (stops.json) once per session.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ list: Array<{ id: string, lon: number, lat: number, name: string }>, byId: Map<string, number> }>}
 */
export async function loadGtfsStopDirectory(signal) {
  const url = `${BASE()}stops.json`;
  if (!cache.has(url)) {
    cache.set(
      url,
      fetchJson(url, signal).then((j) => {
        const list = (j.s || []).map((row) => ({
          id: String(row[0]),
          lon: Number(row[1]) / 1e5,
          lat: Number(row[2]) / 1e5,
          name: j.n?.[row[3]] ?? "",
        }));
        const byId = new Map(list.map((s, i) => [s.id, i]));
        return { list, byId };
      }).catch((e) => {
        cache.delete(url);
        throw e;
      }),
    );
  }
  return cache.get(url);
}

/**
 * Official GTFS stop sequence for a route direction, or [] when unavailable.
 * Shares the same index/agency resolution as getGtfsBusShape, so it works
 * fully offline from the SW data cache. Never throws — returns [] on failure
 * so callers fall back to operator APIs / nearest-neighbour.
 * @param {{ route_id?: string, route_short_name?: string, agency?: { id?: string, name?: string } }} opt
 * @param {string} [bound] "O" | "I"
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>>}
 */
export async function getGtfsRouteStopSequence(opt, bound = "O", opts = {}) {
  try {
    const signal = opts.signal;
    const resolved = await resolveShapeData(opt, signal);
    if (!resolved?.entry?.st) return [];
    const dir = await loadGtfsStopDirectory(signal);
    const st = resolved.entry.st;
    const want = bound === "I" ? "1" : "0";
    let idxs = st[want] || st[String(want)];
    if (!idxs?.length) {
      // Cross-direction fallback: some one-way feeds store the opposite dir
      idxs = st[want === "1" ? "0" : "1"] || [];
    }
    const stops = [];
    for (let i = 0; i < idxs.length; i++) {
      const s = dir.list[idxs[i]];
      if (!s) continue;
      stops.push({
        seq: i + 1,
        name: s.name,
        nameEn: s.name,
        nameTc: "",
        stopId: s.id,
        lon: s.lon,
        lat: s.lat,
      });
    }
    if (stops.length >= 2) {
      console.info(
        "[bus-shapes] gtfs stop seq",
        resolved.entry.sn || resolved.ridKey,
        want,
        "→",
        stops.length,
        "stops",
      );
    }
    return stops;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    console.warn("[bus-shapes] stop-sequence lookup failed, falling back", e);
    return [];
  }
}

/**
 * Local bus-stop search over the shared GTFS stop directory (offline-ready).
 * Prefix matches rank before substring matches; returns up to `limit` hits.
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<{ stopId: string, name: string, lat: number, lon: number }>>}
 */
export async function searchGtfsStopsLocal(query, limit = 8) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  try {
    const dir = await loadGtfsStopDirectory();
    const prefix = [];
    const sub = [];
    for (const s of dir.list) {
      const name = String(s.name || "").toLowerCase();
      if (!name) continue;
      if (name.startsWith(q)) prefix.push(s);
      else if (name.includes(q)) sub.push(s);
      if (prefix.length >= limit) break;
    }
    const hits = [...prefix, ...sub].slice(0, limit);
    return hits.map((s) => ({
      stopId: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
    }));
  } catch (e) {
    console.warn("[bus-shapes] local stop search failed", e);
    return [];
  }
}
