/**
 * Light Rail shape / platform overrides.
 * Data lives in public/overrides/lrt.json (static); this module only applies it.
 */
import { getLrtOverrides } from "./overrides.js";

/** @typedef {{ lon: number, lat: number }} LngLat */

/**
 * @param {string} name
 */
function normStop(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\blight\s*rail\b/g, "")
    .replace(/輕鐵/g, "")
    .replace(/·.*$/g, "")
    .replace(/\bplatform\s*\w*/gi, "")
    .replace(/\bp\d+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(name, patterns = []) {
  const n = normStop(name);
  if (!n) return false;
  return patterns.some((p) => n.includes(String(p).toLowerCase()));
}

function coordsToLngLat(coords) {
  return (coords || [])
    .map((c) => {
      if (Array.isArray(c) && c.length >= 2) {
        return { lon: Number(c[0]), lat: Number(c[1]) };
      }
      if (c && Number.isFinite(c.lon) && Number.isFinite(c.lat)) {
        return { lon: c.lon, lat: c.lat };
      }
      return null;
    })
    .filter(Boolean);
}

function getShapeById(id) {
  const shapes = getLrtOverrides()?.shapes || [];
  return shapes.find((s) => s.id === id) || null;
}

function platformBlockForName(name) {
  const plats = getLrtOverrides()?.platforms || {};
  for (const [key, block] of Object.entries(plats)) {
    const patterns = block.name_match || [key];
    if (nameMatches(name, patterns)) return block;
  }
  return null;
}

/** @returns {LngLat | null} */
function primaryPlatformPoint(name) {
  const block = platformBlockForName(name);
  if (!block) return null;
  const p1 = block.by_ref?.["1"] || block.centroid;
  if (p1 && Number.isFinite(p1.lat) && Number.isFinite(p1.lon)) {
    return { lon: p1.lon, lat: p1.lat };
  }
  return null;
}

function nearPoint(p, target, maxM) {
  if (!p || !target) return false;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return false;
  const dlat = (p.lat - target.lat) * 111320;
  const dlon =
    (p.lon - target.lon) * 111320 * Math.cos((target.lat * Math.PI) / 180);
  return Math.hypot(dlat, dlon) <= maxM;
}

/** Backward-compat exports (from static overrides). */
export function getTinWingP1() {
  const block = getLrtOverrides()?.platforms?.["Tin Wing"];
  const p = block?.by_ref?.["1"] || { lon: 114.00248, lat: 22.45978 };
  return { lon: p.lon, lat: p.lat, ref: "1" };
}

export function getTinWingCentroid() {
  const block = getLrtOverrides()?.platforms?.["Tin Wing"];
  const p = block?.centroid || { lon: 114.00222, lat: 22.46 };
  return { lon: p.lon, lat: p.lat };
}

/** @deprecated use getTinWingP1() */
export const TIN_WING_P1 = getTinWingP1();
/** @deprecated use getTinWingCentroid() */
export const TIN_WING_CENTROID = getTinWingCentroid();

/**
 * Ginza → Tin Wing shape from static overrides.
 * @returns {LngLat[]}
 */
export function getGinzaToTinWingShape() {
  const shape = getShapeById("ginza_to_tin_wing");
  return coordsToLngLat(shape?.coordinates);
}

/** @deprecated */
export const SHAPE_GINZA_TO_TIN_WING = getGinzaToTinWingShape();

/**
 * If this hop is a known broken LRT segment, return a corrected polyline.
 * @param {{ lon: number, lat: number, stop_name?: string, name?: string }} a
 * @param {{ lon: number, lat: number, stop_name?: string, name?: string }} b
 * @returns {LngLat[] | null}
 */
export function lrtHopOverride(a, b) {
  const na = a?.stop_name || a?.name || "";
  const nb = b?.stop_name || b?.name || "";
  const data = getLrtOverrides();
  const shapes = data?.shapes || [];

  const aPt = primaryPlatformPoint(na);
  const bPt = primaryPlatformPoint(nb);

  for (const shape of shapes) {
    const coords = coordsToLngLat(shape.coordinates);
    if (coords.length < 2) continue;
    const aMatch =
      nameMatches(na, shape.from_match) ||
      nearPoint(a, coords[0], 100);
    const bMatch =
      nameMatches(nb, shape.to_match) ||
      nearPoint(b, coords[coords.length - 1], 120);
    if (aMatch && bMatch) return pinEnds(coords, a, b);

    const aMatchRev =
      nameMatches(na, shape.to_match) ||
      nearPoint(a, coords[coords.length - 1], 120);
    const bMatchRev =
      nameMatches(nb, shape.from_match) ||
      nearPoint(b, coords[0], 100);
    if (aMatchRev && bMatchRev) {
      return pinEnds([...coords].reverse(), a, b);
    }
  }

  // Approach rules: hop ending at overridden station forces final segment
  for (const rule of data?.approach_rules || []) {
    const endMatch =
      nameMatches(nb, rule.end_match) ||
      (bPt && nearPoint(b, bPt, 120));
    const startMatch = nameMatches(na, rule.end_match) || (aPt && nearPoint(a, aPt, 120));
    const shape = getShapeById(rule.use_shape);
    const coords = coordsToLngLat(shape?.coordinates);
    if (!coords.length) continue;
    const n = Math.max(2, Number(rule.slice_end) || 4);
    const tail = coords.slice(-n);

    if (endMatch && !startMatch) {
      return pinEnds(
        [
          { lon: a.lon, lat: a.lat },
          ...tail.slice(0, -1),
          { lon: (bPt || b).lon, lat: (bPt || b).lat },
        ],
        a,
        b,
      );
    }
    if (startMatch && !endMatch) {
      const approach = [...tail].reverse();
      return pinEnds(
        [
          { lon: (aPt || a).lon, lat: (aPt || a).lat },
          ...approach.slice(1),
          { lon: b.lon, lat: b.lat },
        ],
        a,
        b,
      );
    }
  }

  return null;
}

/**
 * @param {LngLat[]} shape
 * @param {LngLat} a
 * @param {LngLat} b
 */
function pinEnds(shape, a, b) {
  if (!shape?.length) return null;
  const out = shape.map((p) => ({ lon: p.lon, lat: p.lat }));
  if (Number.isFinite(a.lon) && Number.isFinite(a.lat)) {
    out[0] = { lon: a.lon, lat: a.lat };
  }
  if (Number.isFinite(b.lon) && Number.isFinite(b.lat)) {
    out[out.length - 1] = { lon: b.lon, lat: b.lat };
  }
  return out;
}

/**
 * Platform override from public/overrides/lrt.json.
 * @param {string} [name]
 * @param {string} [ref]
 */
export function tinWingPlatformOverride(name, ref) {
  const block = platformBlockForName(name || "");
  if (!block) return null;
  const r = String(ref || "1").replace(/^p/i, "");
  const pt =
    block.by_ref?.[r] ||
    block.by_ref?.["1"] ||
    block.centroid;
  if (!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) return null;
  return { lon: pt.lon, lat: pt.lat, ref: r || "1" };
}

/** Generic name used by mtrLayer — same as platform override for any configured stop. */
export function lrtPlatformOverride(name, ref) {
  return tinWingPlatformOverride(name, ref);
}
