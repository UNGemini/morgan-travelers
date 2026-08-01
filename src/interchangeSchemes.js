/**
 * Load / compile interchange discount schemes from a single JSON file.
 *
 * Edit: src/data/interchange-schemes.json
 * (operators change often — keep rules out of fares.js)
 */

import raw from "./data/interchange-schemes.json" with { type: "json" };

/**
 * @typedef {{
 *   id?: string,
 *   cos: string[],
 *   routes: string[],
 *   stations: RegExp[] | null,
 *   adult: number,
 *   other: number | null,
 *   student?: number | null,
 *   adultOnly?: boolean,
 *   fareBands?: { minAdultFare: number, adult: number }[],
 *   windowMinutes?: number,
 *   source?: string,
 * }} MtrIxRule
 */

/**
 * @typedef {{
 *   id?: string,
 *   fromCos: string[],
 *   fromRoutes: string[],
 *   toCos: string[],
 *   toRoutes: string[],
 *   discount: number,
 *   adultOnly?: boolean,
 *   windowMinutes?: number,
 *   note?: string,
 * }} BusBusRule
 */

/** @type {MtrIxRule[] | null} */
let compiledMtr = null;
/** @type {BusBusRule[] | null} */
let compiledBusBus = null;

/**
 * @param {unknown} patterns
 * @returns {RegExp[] | null}
 */
function compileStationPatterns(patterns) {
  if (patterns == null) return null;
  if (!Array.isArray(patterns) || !patterns.length) return null;
  return patterns.map((p) => {
    if (p instanceof RegExp) return p;
    return new RegExp(String(p), "i");
  });
}

/**
 * @param {object} r
 * @returns {MtrIxRule}
 */
function compileMtrRule(r) {
  const bands = Array.isArray(r.fare_bands)
    ? r.fare_bands.map((b) => ({
        minAdultFare: Number(b.min_adult_fare) || 0,
        adult: Number(b.adult) || 0,
      }))
    : Array.isArray(r.fareBands)
      ? r.fareBands
      : undefined;
  return {
    id: r.id ? String(r.id) : undefined,
    cos: (r.cos || []).map(String),
    routes: (r.routes || []).map((x) => String(x).toUpperCase()),
    stations: compileStationPatterns(r.stations),
    adult: Number(r.adult) || 0,
    other: r.other == null ? null : Number(r.other),
    student: r.student == null ? null : Number(r.student),
    adultOnly: !!(r.adult_only ?? r.adultOnly),
    fareBands: bands,
    windowMinutes:
      r.window_minutes != null
        ? Number(r.window_minutes)
        : r.windowMinutes != null
          ? Number(r.windowMinutes)
          : undefined,
    source: r.source ? String(r.source) : undefined,
  };
}

/**
 * @param {object} r
 * @returns {BusBusRule}
 */
function compileBusBusRule(r) {
  return {
    id: r.id ? String(r.id) : undefined,
    fromCos: (r.from_cos || r.fromCos || []).map(String),
    fromRoutes: (r.from_routes || r.fromRoutes || []).map((x) =>
      String(x).toUpperCase(),
    ),
    toCos: (r.to_cos || r.toCos || []).map(String),
    toRoutes: (r.to_routes || r.toRoutes || []).map((x) =>
      String(x).toUpperCase(),
    ),
    discount: Number(r.discount) || 0,
    adultOnly: !!(r.adult_only ?? r.adultOnly),
    windowMinutes:
      r.window_minutes != null
        ? Number(r.window_minutes)
        : r.windowMinutes != null
          ? Number(r.windowMinutes)
          : 90,
    note: r.note ? String(r.note) : undefined,
  };
}

function ensureCompiled() {
  if (compiledMtr) return;
  const pack = raw && typeof raw === "object" ? raw : {};
  const mtr = pack.mtr_pt || pack.mtr_interchange || {};
  const rules = Array.isArray(mtr.rules) ? mtr.rules : [];
  compiledMtr = mtr.enabled === false ? [] : rules.map(compileMtrRule);

  const bb = pack.bus_bus || {};
  const bbRules = Array.isArray(bb.rules) ? bb.rules : [];
  compiledBusBus =
    bb.enabled === false ? [] : bbRules.map(compileBusBusRule);
}

/** Raw JSON pack (for debug / UI). */
export function getInterchangeSchemesPack() {
  return raw;
}

/** @returns {MtrIxRule[]} */
export function getMtrInterchangeRules() {
  ensureCompiled();
  return compiledMtr || [];
}

/** @returns {boolean} */
export function isMtrInterchangeEnabled() {
  const pack = raw?.mtr_pt || raw?.mtr_interchange;
  return pack?.enabled !== false;
}

/** @returns {boolean} */
export function excludeIxAfterAelFreeMtr() {
  const pack = raw?.mtr_pt || raw?.mtr_interchange;
  return pack?.exclude_after_ael_free_mtr !== false;
}

/** @returns {BusBusRule[]} */
export function getBusBusInterchangeRules() {
  ensureCompiled();
  return compiledBusBus || [];
}

/** @returns {boolean} */
export function isBusBusInterchangeEnabled() {
  return raw?.bus_bus?.enabled === true;
}

/**
 * Force recompile after hot-replace (tests / future live reload).
 */
export function resetInterchangeSchemesCache() {
  compiledMtr = null;
  compiledBusBus = null;
}
