/**
 * Detect impossible pedestrian crossings of Victoria Harbour.
 *
 * The walk graph can invent “paths” that cut across the harbour (or use
 * road tunnels that are not pedestrian). There is no walkable surface
 * crossing of the main harbour — only ferry / MTR / vehicle tunnels.
 *
 * We classify points as island / kowloon / water / out, then reject walk
 * legs that go island↔kowloon through the harbour corridor.
 */

/**
 * Harbour *water* band as (lon → [southLat, northLat]) control points.
 * Kept tight so waterfront stations stay on land:
 *   Central ~22.282 island, TST ~22.297 kowloon, water in between.
 * Outside lon range we allow walks (around the harbour via east/west).
 */
const HARBOUR_BAND = [
  // lon, south shore (island side of water), north shore (Kowloon side of water)
  // South edge kept north of Hong Kong Station / IFC reclamation (~22.284–22.285)
  // so HOK + Central stay "island", not water.
  { lon: 114.108, south: 22.2885, north: 22.2985 }, // west harbour
  { lon: 114.130, south: 22.2865, north: 22.2990 }, // Sheung Wan – Central
  { lon: 114.150, south: 22.2855, north: 22.2975 }, // Admiralty – TST west
  { lon: 114.168, south: 22.2850, north: 22.2955 }, // Wan Chai – TST / East TST
  { lon: 114.185, south: 22.2860, north: 22.2965 }, // Causeway – Hung Hom bay
  { lon: 114.200, south: 22.2865, north: 22.2970 }, // North Point – Laguna
  { lon: 114.218, south: 22.2845, north: 22.2960 }, // Quarry Bay – Kwun Tong
  { lon: 114.240, south: 22.2810, north: 22.2930 }, // east mouth
];

const LON_MIN = HARBOUR_BAND[0].lon;
const LON_MAX = HARBOUR_BAND[HARBOUR_BAND.length - 1].lon;

/** Huge ranking penalty if a plan still contains a cross-harbour walk. */
export const CROSS_HARBOUR_WALK_PENALTY_SECONDS = 50_000;

/**
 * @param {number} lon
 * @returns {{ south: number, north: number } | null}
 */
function harbourBandAtLon(lon) {
  if (lon < LON_MIN || lon > LON_MAX) return null;
  for (let i = 0; i < HARBOUR_BAND.length - 1; i++) {
    const a = HARBOUR_BAND[i];
    const b = HARBOUR_BAND[i + 1];
    if (lon >= a.lon && lon <= b.lon) {
      const t = (lon - a.lon) / Math.max(b.lon - a.lon, 1e-9);
      return {
        south: a.south + (b.south - a.south) * t,
        north: a.north + (b.north - a.north) * t,
      };
    }
  }
  return HARBOUR_BAND[HARBOUR_BAND.length - 1];
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {"island" | "kowloon" | "water" | "out"}
 */
export function harbourSide(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "out";
  const band = harbourBandAtLon(lon);
  if (!band) return "out";
  if (lat < band.south) return "island";
  if (lat > band.north) return "kowloon";
  return "water";
}

/**
 * @param {{ lat?: number, lon?: number, location?: { lat: number, lon: number } } | null | undefined} p
 */
function pointLatLon(p) {
  if (!p) return null;
  const lat = p.location?.lat ?? p.lat;
  const lon = p.location?.lon ?? p.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * True if this walk leg crosses Victoria Harbour in a non-walkable way.
 * @param {{
 *   type?: string,
 *   path?: Array<{ lat: number, lon: number }>,
 *   from?: unknown,
 *   to?: unknown,
 *   distance_meters?: number,
 *   duration_seconds?: number,
 *   walk_type?: string,
 * }} leg
 */
export function walkCrossesHarbour(leg) {
  if (!leg || leg.type !== "walk") return false;

  // In-station transfers never cross the harbour
  const wtype = String(leg.walk_type || "").toLowerCase();
  if (wtype === "station_transfer") return false;

  /** @type {Array<{ lat: number, lon: number }>} */
  let samples = [];

  if (Array.isArray(leg.path) && leg.path.length >= 2) {
    samples = leg.path
      .map((p) => ({ lat: p.lat, lon: p.lon }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  if (samples.length < 2) {
    const a = pointLatLon(leg.from);
    const b = pointLatLon(leg.to);
    if (a && b) {
      // densify chord so we detect water crossing
      samples = densifyChord(a, b, 12);
    }
  }

  if (samples.length < 2) return false;

  // Sample denser along path
  samples = densifyPath(samples, 80);

  const sides = samples.map((p) => harbourSide(p.lat, p.lon));
  const hasIsland = sides.includes("island");
  const hasKowloon = sides.includes("kowloon");

  // Impossible: path (or endpoints) on both sides of Victoria Harbour
  if (hasIsland && hasKowloon) return true;

  // Near-straight chord across harbour between shores
  const a = samples[0];
  const b = samples[samples.length - 1];
  if (chordCrossesHarbourBand(a, b)) return true;

  // Long path that spends most of its length in harbour water while
  // connecting land — vehicle-tunnel style false walks (not promenades)
  const dist =
    typeof leg.distance_meters === "number"
      ? leg.distance_meters
      : pathLengthM(samples);
  if (dist > 500) {
    let waterM = 0;
    for (let i = 1; i < samples.length; i++) {
      if (sides[i] === "water" || sides[i - 1] === "water") {
        waterM += haversineM(
          samples[i - 1].lat,
          samples[i - 1].lon,
          samples[i].lat,
          samples[i].lon,
        );
      }
    }
    if (waterM > 400 && waterM / Math.max(dist, 1) > 0.35) return true;
  }

  return false;
}

/**
 * @param {object} plan
 * @returns {boolean}
 */
export function planHasCrossHarbourWalk(plan) {
  const legs = plan?.legs || [];
  for (const leg of legs) {
    if (walkCrossesHarbour(leg)) return true;
  }

  // Pure walk-only plan with endpoints on opposite shores (sparse geometry).
  const walks = legs.filter((l) => l.type === "walk");
  const hasTransit = legs.some((l) => l.type === "transit");
  if (!hasTransit && walks.length >= 1) {
    const first = walks[0];
    const last = walks[walks.length - 1];
    const a =
      pointLatLon(first.path?.[0]) ||
      pointLatLon(first.from);
    const b =
      pointLatLon(last.path?.[last.path.length - 1]) ||
      pointLatLon(last.to);
    if (a && b) {
      const sa = harbourSide(a.lat, a.lon);
      const sb = harbourSide(b.lat, b.lon);
      if (
        (sa === "island" && sb === "kowloon") ||
        (sa === "kowloon" && sb === "island")
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Count cross-harbour walk legs (for ranking).
 * @param {object} plan
 */
export function countCrossHarbourWalks(plan) {
  let n = 0;
  for (const leg of plan?.legs || []) {
    if (walkCrossesHarbour(leg)) n += 1;
  }
  return n;
}

// ── geometry helpers ────────────────────────────────────────────────────────

function densifyChord(a, b, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
    });
  }
  return out;
}

function densifyPath(path, maxStepM) {
  if (path.length < 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const d = haversineM(a.lat, a.lon, b.lat, b.lon);
    const steps = Math.max(1, Math.ceil(d / maxStepM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
      });
    }
  }
  return out;
}

/**
 * Segment intersects harbour water band (for endpoint-only legs).
 */
function chordCrossesHarbourBand(a, b) {
  const sa = harbourSide(a.lat, a.lon);
  const sb = harbourSide(b.lat, b.lon);
  if (sa === "island" && sb === "kowloon") return true;
  if (sa === "kowloon" && sb === "island") return true;

  // Midpoint in water while ends on land and chord is short-ish across
  const mid = {
    lat: (a.lat + b.lat) / 2,
    lon: (a.lon + b.lon) / 2,
  };
  if (harbourSide(mid.lat, mid.lon) !== "water") return false;

  const landA = sa === "island" || sa === "kowloon";
  const landB = sb === "island" || sb === "kowloon";
  if (landA && landB && sa !== sb) return true;

  // Both ends "out" but chord still punches through harbour water
  // (e.g. eastern approaches) — only if water crossing is substantial
  const d = haversineM(a.lat, a.lon, b.lat, b.lon);
  if (d > 400 && d < 8000) {
    // count fraction of densified chord in water
    const samples = densifyChord(a, b, 16);
    let water = 0;
    for (const p of samples) {
      if (harbourSide(p.lat, p.lon) === "water") water += 1;
    }
    if (water / samples.length >= 0.25) return true;
  }
  return false;
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

function pathLengthM(coords) {
  let n = 0;
  for (let i = 1; i < coords.length; i++) {
    n += haversineM(
      coords[i - 1].lat,
      coords[i - 1].lon,
      coords[i].lat,
      coords[i].lon,
    );
  }
  return n;
}
