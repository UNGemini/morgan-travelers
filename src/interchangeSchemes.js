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

/** @type {Record<string, number> | null} */
let bbiPairs = null;
/** @type {Promise<Record<string, number>> | null} */
let bbiLoadPromise = null;

/**
 * Compact ordered first>second bus discounts (from offline summarize-bbi.mjs).
 * Fetches public/fares/bbi-compact.json once.
 * @returns {Promise<Record<string, number>>}
 */
export async function loadBbiCompactPairs() {
  if (bbiPairs) return bbiPairs;
  if (bbiLoadPromise) return bbiLoadPromise;
  bbiLoadPromise = (async () => {
    try {
      const base =
        (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) ||
        "/";
      const url = new URL(`${base}fares/bbi-compact.json`, window.location.href);
      url.searchParams.set("v", "1");
      const res = await fetch(url.href, { cache: "no-cache" });
      if (!res.ok) throw new Error(`bbi-compact ${res.status}`);
      const j = await res.json();
      bbiPairs =
        j && typeof j.pairs === "object" && j.pairs ? j.pairs : {};
      console.info(
        "[bbi] compact pairs",
        Object.keys(bbiPairs).length,
        j?.updated_at || "",
      );
    } catch (e) {
      console.warn("[bbi] compact load failed", e?.message || e);
      bbiPairs = {};
    }
    return bbiPairs;
  })();
  return bbiLoadPromise;
}

/** Sync getter (empty until loadBbiCompactPairs resolves). */
export function getBbiCompactPairs() {
  return bbiPairs || {};
}

/**
 * Max HKD discount for consecutive bus routes (ordered first → second).
 * @param {string} fromRoute
 * @param {string} toRoute
 */
export function lookupBbiDiscount(fromRoute, toRoute) {
  const a = String(fromRoute || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const b = String(toRoute || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!a || !b || a === b) return 0;
  const map = getBbiCompactPairs();
  const d1 = map[`${a}>${b}`];
  const d2 = map[`${b}>${a}`];
  // Prefer ordered first→second; fall back reverse if only other direction listed
  if (d1 != null && d1 > 0) return Number(d1);
  if (d2 != null && d2 > 0) return Number(d2);
  return 0;
}
