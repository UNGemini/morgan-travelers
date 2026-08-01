/**
 * Contributor / mod bus route path overrides.
 * Source: public/overrides/bus-shapes.json (reviewed entries only).
 *
 * Draft submissions open a GitHub PR (or download JSON); they are NOT auto-published.
 */

import { getBusShapeOverrides } from "./overrides.js";

/**
 * @typedef {{
 *   stop_id?: string,
 *   name?: string,
 *   seq?: number,
 *   official?: number[],
 *   visual?: number[],
 * }} BusShapeVisualStop
 */

/**
 * @typedef {{
 *   id: string,
 *   agency?: string,
 *   route_short_name?: string,
 *   route_id_match?: string[],
 *   from_match?: string[],
 *   to_match?: string[],
 *   direction?: string,
 *   notes?: string,
 *   coordinates: number[][],
 *   visual_stops?: BusShapeVisualStop[],
 *   contributor?: string,
 *   submitted_at?: string,
 *   status?: string,
 * }} BusShapeOverride
 */

/**
 * @param {string} text
 * @param {string[]} needles
 */
function nameMatches(text, needles) {
  if (!needles?.length) return true;
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return needles.some((n) => t.includes(String(n).toLowerCase()));
}

/**
 * @param {object} opt route option from RAPTOR
 */
function routeBlob(opt) {
  return {
    short: String(opt?.route_short_name || "").trim().toUpperCase(),
    id: String(opt?.route_id || "").toUpperCase(),
    agency: String(opt?.agency?.id || opt?.agency?.name || "").toUpperCase(),
    from: String(
      opt?.from?.stop_name ||
        opt?.stops?.[0]?.stop_name ||
        opt?.from?.name ||
        "",
    ),
    to: String(
      opt?.to?.stop_name ||
        (opt?.stops?.length
          ? opt.stops[opt.stops.length - 1]?.stop_name
          : "") ||
        opt?.to?.name ||
        "",
    ),
  };
}

/**
 * @returns {BusShapeOverride[]}
 */
function publishedShapes() {
  const routes = getBusShapeOverrides()?.routes || [];
  return routes.filter((r) => {
    if (!Array.isArray(r.coordinates) || r.coordinates.length < 2) return false;
    if (r.status && r.status !== "published" && r.status !== "approved") {
      return false;
    }
    return true;
  });
}

/**
 * Find a reviewed bus shape override for this transit option.
 * Exact route match first; if none, reuse another published path that
 * geometrically covers the stop sequence (shared corridor).
 * @param {object} opt
 * @returns {BusShapeOverride | null}
 */
export function matchBusShapeOverride(opt) {
  const routes = publishedShapes();
  if (!routes.length || !opt) return null;

  const b = routeBlob(opt);
  /** @type {Array<{ r: BusShapeOverride, score: number, exactRoute: boolean }>} */
  const candidates = [];

  for (const r of routes) {
    let score = 0;
    const rShort = String(r.route_short_name || "").trim().toUpperCase();
    const exactRoute = !!(rShort && b.short && rShort === b.short);
    if (exactRoute) score += 40;
    else if (rShort && b.short && rShort !== b.short) continue;

    let agencyOk = true;
    if (r.agency) {
      const ag = String(r.agency).toUpperCase();
      const bag = String(b.agency || "").toUpperCase();
      if (
        !bag ||
        bag.includes(ag) ||
        ag.includes(bag.split(/\s/)[0] || "") ||
        ag.includes("JOINT") ||
        // KMB/LWB family
        ((ag.includes("KMB") || ag.includes("LWB")) &&
          (bag.includes("KMB") || bag.includes("LWB")))
      ) {
        score += 15;
      } else {
        agencyOk = false;
        score -= 25; // wrong company — usually skip
      }
    }
    if (!agencyOk && exactRoute) {
      // Still allow only if agency completely unknown on either side
      if (r.agency && b.agency) continue;
    }

    if (Array.isArray(r.route_id_match) && r.route_id_match.length) {
      const idHit = r.route_id_match.some((m) =>
        b.id.includes(String(m).toUpperCase()),
      );
      if (idHit) score += 25;
      else score -= 5;
    }

    // OD match is a soft preference (disambiguate multi-bound shapes), not a hard reject
    if (r.from_match?.length) {
      if (nameMatches(b.from, r.from_match)) score += 20;
      else if (nameMatches(b.to, r.from_match)) score += 8; // reverse bound
      else score -= 5;
    }
    if (r.to_match?.length) {
      if (nameMatches(b.to, r.to_match)) score += 20;
      else if (nameMatches(b.from, r.to_match)) score += 8;
      else score -= 5;
    }

    if (r.direction && b.from) {
      // mild preference only
      const rd = String(r.direction).toLowerCase();
      if (rd === "circular" || rd.includes("loop")) score += 2;
    }

    candidates.push({ r, score, exactRoute });
  }

  if (!candidates.length) {
    const stops = stopsFromOpt(opt);
    const similar = matchSimilarBusShapeOverride(stops, {
      excludeRoute: b.short || undefined,
      preferAgency: b.agency || undefined,
    });
    return similar?.shape || null;
  }

  candidates.sort((a, b) => b.score - a.score);

  // Single published shape for this route number → always use it (merged path)
  const exact = candidates.filter((c) => c.exactRoute);
  if (exact.length === 1 && exact[0].score >= 20) {
    return exact[0].r;
  }

  // Multiple bounds / variants: pick best score
  if (candidates[0].score >= 35) return candidates[0].r;
  if (exact.length && exact[0].score >= 30) return exact[0].r;

  // No exact override — try a published path that already follows this corridor
  const stops = stopsFromOpt(opt);
  const similar = matchSimilarBusShapeOverride(stops, {
    excludeRoute: b.short || undefined,
    preferAgency: b.agency || undefined,
  });
  return similar?.shape || null;
}

/**
 * Stops with coords from a RAPTOR option (or contribute stop list).
 * @param {object} opt
 * @returns {Array<{ lon: number, lat: number, id?: string }>}
 */
function stopsFromOpt(opt) {
  const raw =
    opt?.stops?.length >= 2
      ? opt.stops
      : [opt?.from, opt?.to].filter(Boolean);
  /** @type {Array<{ lon: number, lat: number, id?: string }>} */
  const out = [];
  for (let i = 0; i < (raw || []).length; i++) {
    const s = raw[i];
    const lon = Number(s?.location?.lon ?? s?.lon);
    const lat = Number(s?.location?.lat ?? s?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({
      lon,
      lat,
      id: String(s?.stop_id || s?.id || i),
    });
  }
  return out;
}

/**
 * Reuse another route’s published polyline when this route has no override but
 * its stops lie on a similar reviewed path (shared roads / airport corridors).
 *
 * @param {Array<{ lon: number, lat: number, id?: string }>} stops ordered travel
 * @param {{
 *   excludeRoute?: string,
 *   preferAgency?: string,
 *   maxErrM?: number,
 *   minCoverage?: number,
 * }} [opts]
 * @returns {{ shape: BusShapeOverride, score: number, coverage: number, avgErrM: number } | null}
 */
export function matchSimilarBusShapeOverride(stops, opts = {}) {
  const routes = publishedShapes();
  if (!routes.length || !stops || stops.length < 2) return null;

  const maxErrM = opts.maxErrM ?? 130;
  const minCoverage = opts.minCoverage ?? 0.7;
  const exclude = String(opts.excludeRoute || "")
    .trim()
    .toUpperCase();
  const preferAg = String(opts.preferAgency || "")
    .trim()
    .toUpperCase();

  /** @type {{ shape: BusShapeOverride, score: number, coverage: number, avgErrM: number } | null} */
  let best = null;

  for (const shape of routes) {
    const rShort = String(shape.route_short_name || "").trim().toUpperCase();
    // Skip exact same route number (caller already tried exact match)
    if (exclude && rShort && rShort === exclude) continue;

    const line = shapeCoords(shape);
    if (line.length < 2) continue;

    const fit = scoreStopsOnShape(line, stops, maxErrM);
    if (!fit || fit.coverage < minCoverage) continue;

    // Need first & last stop reasonably on the path
    if (fit.endErrors[0] > maxErrM * 1.25 || fit.endErrors[1] > maxErrM * 1.25) {
      continue;
    }
    // Forward progression along path (not reverse-bound mirror)
    if (fit.forwardRatio < 0.65) continue;

    let score =
      fit.coverage * 100 -
      fit.avgErrM * 0.35 +
      fit.forwardRatio * 25 +
      Math.min(20, fit.okCount);

    if (preferAg && shape.agency) {
      const ag = String(shape.agency).toUpperCase();
      if (preferAg.includes(ag) || ag.includes(preferAg.split(/\s/)[0] || "")) {
        score += 8;
      }
    }

    // Prefer longer reviewed paths that cover more of the trip
    score += Math.min(15, line.length / 80);

    if (!best || score > best.score) {
      best = {
        shape,
        score,
        coverage: fit.coverage,
        avgErrM: fit.avgErrM,
      };
    }
  }

  // Require a solid geometric fit (not a random distant path)
  if (!best || best.score < 55 || best.coverage < minCoverage) return null;
  return best;
}

/**
 * @param {BusShapeOverride} shape
 * @returns {Array<{ lon: number, lat: number }>}
 */
function shapeCoords(shape) {
  /** @type {Array<{ lon: number, lat: number }>} */
  const out = [];
  for (const c of shape.coordinates || []) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({ lon, lat });
  }
  return out;
}

/**
 * Project ordered stops onto a shape; measure coverage, error, forward order.
 * @param {Array<{ lon: number, lat: number }>} line
 * @param {Array<{ lon: number, lat: number }>} stops
 * @param {number} maxErrM
 */
function scoreStopsOnShape(line, stops, maxErrM) {
  const cum = cumulativeM(line);
  let minAlong = 0;
  let ok = 0;
  let sumErr = 0;
  let forward = 0;
  let prevAlong = -1;
  /** @type {number[]} */
  const endErrors = [];

  for (let si = 0; si < stops.length; si++) {
    const s = stops[si];
    const isFirst = si === 0;
    const isLast = si === stops.length - 1;
    const floor = isFirst ? 0 : Math.max(0, minAlong - 80);
    let hit = nearestOnLine(line, cum, s, floor);
    if (!hit) hit = nearestOnLine(line, cum, s, 0);
    if (!hit) continue;

    // Prefer ends of path for first/last when close
    if (isFirst) {
      const d0 = haversineM(s.lat, s.lon, line[0].lat, line[0].lon);
      if (d0 <= (hit.err ?? Infinity) + 30) {
        hit = { lon: line[0].lon, lat: line[0].lat, along: 0, err: d0 };
      }
    }
    if (isLast) {
      const last = line[line.length - 1];
      const d1 = haversineM(s.lat, s.lon, last.lat, last.lon);
      if (d1 <= (hit.err ?? Infinity) + 30) {
        hit = {
          lon: last.lon,
          lat: last.lat,
          along: cum[cum.length - 1] || 0,
          err: d1,
        };
      }
    }

    if (isFirst || isLast) endErrors.push(hit.err);

    if (hit.err <= maxErrM) {
      ok += 1;
      sumErr += hit.err;
      if (hit.along + 1 >= prevAlong) forward += 1;
      prevAlong = Math.max(prevAlong, hit.along);
      minAlong = Math.max(minAlong, hit.along);
    } else if (hit.err <= maxErrM * 1.6) {
      // partial credit for near misses
      ok += 0.45;
      sumErr += hit.err;
      if (hit.along + 1 >= prevAlong) forward += 0.45;
      prevAlong = Math.max(prevAlong, hit.along);
      minAlong = Math.max(minAlong, hit.along);
    }
  }

  const n = stops.length;
  if (n < 2) return null;
  while (endErrors.length < 2) endErrors.push(Infinity);

  return {
    okCount: ok,
    coverage: ok / n,
    avgErrM: ok > 0 ? sumErr / Math.max(1, ok) : 999,
    forwardRatio: forward / n,
    endErrors: /** @type {[number, number]} */ ([endErrors[0], endErrors[1]]),
  };
}

/** @param {Array<{ lon: number, lat: number }>} line */
function cumulativeM(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) {
    cum.push(
      cum[i - 1] +
        haversineM(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon),
    );
  }
  return cum;
}

/**
 * @param {Array<{ lon: number, lat: number }>} line
 * @param {number[]} cum
 * @param {{ lon: number, lat: number }} stop
 * @param {number} minAlongM
 */
function nearestOnLine(line, cum, stop, minAlongM) {
  let best = null;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = Math.max(1e-6, cum[i + 1] - cum[i]);
    const { t, lon, lat, err } = projectToSegment(stop, a, b);
    const along = cum[i] + t * segLen;
    if (along + 0.5 < minAlongM) continue;
    if (!best || err < best.err) best = { lon, lat, along, err };
  }
  return best;
}

/**
 * @param {{ lon: number, lat: number }} p
 * @param {{ lon: number, lat: number }} a
 * @param {{ lon: number, lat: number }} b
 */
function projectToSegment(p, a, b) {
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
  const lon = a.lon + (b.lon - a.lon) * t;
  const lat = a.lat + (b.lat - a.lat) * t;
  const err = haversineM(p.lat, p.lon, lat, lon);
  return { t, lon, lat, err };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Find a published bus shape for the contribute loader (agency + route + ends).
 * Prefer matching from/to names and direction so reverse bounds stay separate.
 *
 * @param {{
 *   agency?: string,
 *   route_short_name?: string,
 *   direction?: string,
 *   from?: string,
 *   to?: string,
 *   stops?: Array<{ lon: number, lat: number, id?: string }>,
 * }} query
 * @returns {{
 *   shape: BusShapeOverride,
 *   score: number,
 *   similar?: boolean,
 *   coverage?: number,
 *   avgErrM?: number,
 * } | null}
 */
export function matchBusShapeForRoute(query) {
  const data = getBusShapeOverrides();
  const routes = data?.routes || [];
  if (!routes.length || !query) return null;

  const short = String(query.route_short_name || "").trim().toUpperCase();
  const agency = String(query.agency || "").trim().toUpperCase();
  const from = String(query.from || "");
  const to = String(query.to || "");
  const dir = String(query.direction || "").toLowerCase().trim();

  /** @type {BusShapeOverride | null} */
  let best = null;
  let bestScore = 0;

  for (const r of routes) {
    if (!Array.isArray(r.coordinates) || r.coordinates.length < 2) continue;
    if (r.status && r.status !== "published" && r.status !== "approved") {
      continue;
    }

    const rShort = String(r.route_short_name || "").trim().toUpperCase();
    if (!short || !rShort || rShort !== short) continue;

    let score = 40; // route number match

    if (agency) {
      // When caller specifies operator, require agency match (no cross-company reuse)
      const ag = String(r.agency || "").toUpperCase();
      if (!ag) {
        score -= 20; // untagged shape must not win for a tagged operator
      } else if (
        agency.includes(ag) ||
        ag.includes(agency) ||
        ag.includes("JOINT") ||
        ((agency === "KMB" || agency === "LWB") &&
          (ag.includes("KMB") || ag.includes("LWB"))) ||
        (agency === "CTB" &&
          (ag.includes("CTB") || ag.includes("CITYBUS") || ag.includes("NWFB")))
      ) {
        score += 20;
      } else {
        score -= 40; // hard reject different operator
      }
    } else if (r.agency) {
      score += 5;
    }

    if (r.from_match?.length) {
      if (nameMatches(from, r.from_match)) score += 25;
      else if (nameMatches(to, r.from_match)) score += 10;
      else score -= 5;
    }
    if (r.to_match?.length) {
      if (nameMatches(to, r.to_match)) score += 25;
      else if (nameMatches(from, r.to_match)) score += 10;
      else score -= 5;
    }

    if (r.direction && dir) {
      const rd = String(r.direction).toLowerCase();
      const sameBound =
        rd === dir ||
        rd === "circular" ||
        (dir === "o" && (rd.includes("out") || rd === "o")) ||
        (dir === "i" && (rd.includes("in") || rd === "i")) ||
        rd.includes(dir) ||
        dir.includes(rd);
      if (sameBound) score += 10;
      else score -= 3;
    }

    if (score > bestScore && score >= 40) {
      bestScore = score;
      best = r;
    }
  }

  // Soft fallback: single published shape for this route+agency (any bound)
  // — ensures merged contributions always show even when OD labels differ
  if (!best && short) {
    const candidates = routes.filter((r) => {
      if (!Array.isArray(r.coordinates) || r.coordinates.length < 2) return false;
      if (r.status && r.status !== "published" && r.status !== "approved") {
        return false;
      }
      const rShort = String(r.route_short_name || "").trim().toUpperCase();
      if (rShort !== short) return false;
      if (!agency || !r.agency) return true;
      const ag = String(r.agency).toUpperCase();
      return (
        agency.includes(ag) ||
        ag.includes(agency) ||
        ag.includes("JOINT") ||
        ((agency === "KMB" || agency === "LWB") &&
          (ag.includes("KMB") || ag.includes("LWB")))
      );
    });
    if (candidates.length === 1) {
      return { shape: candidates[0], score: 40 };
    }
    if (candidates.length > 1 && dir) {
      const dirHit = candidates.find((r) => {
        const rd = String(r.direction || "").toLowerCase();
        return (
          rd === dir ||
          (dir === "outbound" && (rd.includes("out") || rd === "o")) ||
          (dir === "inbound" && (rd.includes("in") || rd === "i"))
        );
      });
      if (dirHit) return { shape: dirHit, score: 42 };
    }
  }

  if (best) return { shape: best, score: bestScore };

  // Geometric fallback: another route’s published path covering these ends
  // (caller supplies stop coords via optional stops array on query)
  if (Array.isArray(query.stops) && query.stops.length >= 2) {
    const similar = matchSimilarBusShapeOverride(query.stops, {
      excludeRoute: short || undefined,
      preferAgency: agency || undefined,
    });
    if (similar) {
      return {
        shape: similar.shape,
        score: similar.score,
        similar: true,
        coverage: similar.coverage,
        avgErrM: similar.avgErrM,
      };
    }
  }

  return null;
}

/**
 * Convert override coordinates to {lon,lat}[] and optionally slice to stops.
 * @param {BusShapeOverride} shape
 * @param {Array<{ lon: number, lat: number }>} stops
 * @param {(line: Array<{lon:number,lat:number}>, stops: any[]) => any[]} sliceFn
 */
export function busShapeToPolyline(shape, stops, sliceFn) {
  const coords = (shape.coordinates || [])
    .map((c) => {
      if (!Array.isArray(c) || c.length < 2) return null;
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return { lon, lat };
    })
    .filter(Boolean);
  if (coords.length < 2) return null;
  if (typeof sliceFn === "function" && stops?.length >= 2) {
    try {
      const sliced = sliceFn(coords, stops);
      if (sliced?.length >= 2) return sliced;
    } catch {
      /* use full */
    }
  }
  return coords;
}

/** Same-origin serverless intake (Cloudflare Pages Function). */
export const PATH_CONTRIBUTE_API = "/api/contribute-path";

/**
 * Build a submission draft object for download / API / GitHub PR.
 * @param {object} fields
 * @returns {object}
 */
export function buildPathContributionDraft(fields) {
  const coords = (fields.coordinates || []).map((c) => [
    Number(c[0]),
    Number(c[1]),
  ]);
  /** @type {BusShapeVisualStop[]} */
  const visualStops = (fields.visual_stops || [])
    .map((s, i) => {
      const official = Array.isArray(s.official)
        ? [Number(s.official[0]), Number(s.official[1])]
        : null;
      const visual = Array.isArray(s.visual)
        ? [Number(s.visual[0]), Number(s.visual[1])]
        : null;
      if (
        !visual ||
        !Number.isFinite(visual[0]) ||
        !Number.isFinite(visual[1])
      ) {
        return null;
      }
      return {
        stop_id: String(s.stop_id || "").slice(0, 64),
        name: String(s.name || "").slice(0, 120),
        seq: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i,
        official:
          official &&
          Number.isFinite(official[0]) &&
          Number.isFinite(official[1])
            ? official
            : undefined,
        visual,
      };
    })
    .filter(Boolean);
  const idParts = [
    String(fields.agency || "BUS").toUpperCase(),
    String(fields.route_short_name || "route").replace(/\s+/g, ""),
    String(fields.from_match?.[0] || "from").slice(0, 24),
    String(fields.to_match?.[0] || "to").slice(0, 24),
  ];
  return {
    schema: "morgan.travelers.bus-shape.v1",
    status: "pending_review",
    id: idParts
      .join("_")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80),
    agency: String(fields.agency || "").trim(),
    route_short_name: String(fields.route_short_name || "").trim(),
    route_id_match: fields.route_id_match || [],
    from_match: fields.from_match || [],
    to_match: fields.to_match || [],
    direction: String(fields.direction || "").trim(),
    notes: String(fields.notes || "").trim(),
    coordinates: coords,
    // Official stop identity fixed in open data / merge; visual is map display only
    visual_stops: visualStops,
    contributor: String(fields.contributor || "").trim(),
    submitted_at: new Date().toISOString(),
    app_version: "0.4.0",
  };
}

/**
 * Apply contributed visual stop positions onto plan stop features for a leg.
 * Official GTFS coords / merge identity are not changed — only display geometry.
 *
 * Match order: stop_id → seq/stop_index → ordered fallback.
 *
 * @param {Array<{ properties?: object, geometry?: object }>} stopFeatures
 * @param {BusShapeOverride | null | undefined} shape
 * @returns {number} how many features updated
 */
export function applyVisualStopsFromShape(stopFeatures, shape) {
  const vs = shape?.visual_stops;
  if (!Array.isArray(vs) || !vs.length || !stopFeatures?.length) return 0;

  /** @type {Map<string, BusShapeVisualStop>} */
  const byId = new Map();
  /** @type {Map<number, BusShapeVisualStop>} */
  const bySeq = new Map();
  for (const s of vs) {
    if (!s?.visual || s.visual.length < 2) continue;
    const id = String(s.stop_id || "").trim();
    if (id) byId.set(id, s);
    if (Number.isFinite(Number(s.seq))) bySeq.set(Number(s.seq), s);
  }

  let n = 0;
  const ordered = [...stopFeatures].sort(
    (a, b) =>
      (Number(a.properties?.stop_index) || 0) -
      (Number(b.properties?.stop_index) || 0),
  );

  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    const sid = String(f.properties?.stop_id || "").trim();
    const seq = Number(f.properties?.stop_index);
    let hit =
      (sid && byId.get(sid)) ||
      (Number.isFinite(seq) ? bySeq.get(seq) : null) ||
      vs[i] ||
      null;
    if (!hit?.visual) continue;
    const lon = Number(hit.visual[0]);
    const lat = Number(hit.visual[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    f.geometry = { type: "Point", coordinates: [lon, lat] };
    if (f.properties) {
      f.properties.visual_override = true;
      f.properties.snapped = true;
    }
    n += 1;
  }
  return n;
}

/**
 * POST draft to serverless /api/contribute-path (Cloudflare Pages Function).
 * Works under COEP (same-origin). Returns API JSON or throws.
 *
 * @param {object} draft
 * @param {{ submit_mode?: "oauth" | "bot" }} [opts]
 */
export async function submitPathContribution(draft, opts = {}) {
  const submit_mode = opts.submit_mode === "bot" ? "bot" : "oauth";
  const res = await fetch(PATH_CONTRIBUTE_API, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ ...draft, submit_mode }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `HTTP ${res.status}` };
  }
  if (!res.ok && !data.ok) {
    const err = new Error(data.error || `Submit failed (${res.status})`);
    // @ts-expect-error attach
    err.status = res.status;
    // @ts-expect-error attach
    err.data = data;
    throw err;
  }
  return data;
}
