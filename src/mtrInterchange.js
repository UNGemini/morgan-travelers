/**
 * Former KCR ↔ MTR interchange handling.
 *
 * Before the 2007 rail merger, KCR and MTR were separate systems. Many
 * interchanges between their networks were bolted on later and involve
 * longer walks / more vertical circulation than purpose-built hubs.
 *
 * Integrated / same-period (normal interchange time):
 *   - Nam Cheong (TCL ↔ TML) — dual-system hub
 *   - Ho Man Tin (KTL ↔ TML) — built integrated
 *   - Admiralty TWL ↔ ISL — original MTR, same construction period
 *   - Admiralty SIL ↔ EAL — 2010s expansion, same construction period
 *
 * Longer former KCR–MTR style hubs (include Diamond Hill):
 *   - Diamond Hill (KTL ↔ TML), Kowloon Tong, Mei Foo, TST / East TST, …
 */

import { detectMtrLineCode } from "./mtrColors.js";

/** Extra perceived time for a former KCR–MTR style interchange (seconds). */
export const KCR_MTR_INTERCHANGE_EXTRA_SECONDS = 360; // +6 min

/**
 * Stations where a cross-heritage change is typically long.
 * Admiralty is NOT listed — SIL/EAL share one expansion; TWL/ISL are original MTR.
 */
export const LONG_KCR_MTR_INTERCHANGE_STATIONS = [
  { id: "kowloon_tong", patterns: [/kowloon\s*tong/i, /九龍塘/] },
  { id: "mei_foo", patterns: [/mei\s*foo/i, /美孚/] },
  { id: "tst", patterns: [/tsim\s*sha\s*tsui/i, /尖沙咀/, /尖東/, /east\s*tsim\s*sha\s*tsui/i] },
  { id: "austin", patterns: [/\baustin\b/i, /柯士甸/] },
  // Tuen Ma platforms added later alongside KTL — long transfer
  { id: "diamond_hill", patterns: [/diamond\s*hill/i, /鑽石山/] },
  { id: "hung_hom", patterns: [/hung\s*hom/i, /紅磡/] },
  // Mong Kok East (EAL) separate from Mong Kok MTR
  { id: "mong_kok_east", patterns: [/mong\s*kok\s*east/i, /旺角東/] },
  { id: "mong_kok", patterns: [/mong\s*kok(?!\s*east)/i, /旺角(?!東)/] },
];

/** Integrated hubs — never apply the long surcharge. */
export const INTEGRATED_INTERCHANGE_STATIONS = [
  { id: "nam_cheong", patterns: [/nam\s*cheong/i, /南昌/] },
  { id: "ho_man_tin", patterns: [/ho\s*man\s*tin/i, /何文田/] },
];

/** Admiralty — special same-period line groups (not a “bolted-on” KCR hub). */
export const ADMIRALTY_STATION = {
  id: "admiralty",
  patterns: [/\badmiralty\b/i, /金鐘/],
};

/**
 * Admiralty construction cohorts (same period → normal interchange).
 * - original MTR: Tsuen Wan Line + Island Line
 * - 2010s expansion: South Island Line + East Rail Line
 */
const ADMIRALTY_COHORT_ORIGINAL_MTR = new Set(["TWL", "ISL"]);
const ADMIRALTY_COHORT_EXPANSION = new Set(["SIL", "EAL"]);

/** Former KCR / KCR-descended codes (for cross-system detection elsewhere). */
const KCR_HERITAGE = new Set(["EAL", "WRL", "MOL", "TML", "LRT"]);

/** Pre-merger MTR urban / pure-MTR lines. */
const MTR_HERITAGE = new Set(["TWL", "KTL", "ISL", "TCL", "TKL", "AEL", "DRL", "SIL"]);

/**
 * @param {string | null | undefined} text
 */
export function matchStationGroup(text, groups) {
  const s = String(text || "");
  if (!s) return null;
  for (const g of groups) {
    if (g.patterns.some((re) => re.test(s))) return g.id;
  }
  return null;
}

/**
 * @param {{ stop_name?: string, address?: string } | null | undefined} stop
 */
export function stopLabel(stop) {
  if (!stop) return "";
  return String(stop.stop_name || stop.address || "");
}

export function isAdmiraltyStop(stop) {
  return !!matchStationGroup(stopLabel(stop), [ADMIRALTY_STATION]);
}

/**
 * True if this stop is Nam Cheong / Ho Man Tin (integrated — normal time).
 */
export function isIntegratedInterchangeStop(stop) {
  return !!matchStationGroup(stopLabel(stop), INTEGRATED_INTERCHANGE_STATIONS);
}

/**
 * True if stop is a known long former KCR–MTR style interchange location.
 */
export function isLongKcrMtrInterchangeStop(stop) {
  if (isIntegratedInterchangeStop(stop)) return false;
  if (isAdmiraltyStop(stop)) return false; // handled via same-period cohorts, not legacy list
  return !!matchStationGroup(stopLabel(stop), LONG_KCR_MTR_INTERCHANGE_STATIONS);
}

/**
 * Line heritage: "kcr" | "mtr" | "unknown"
 */
export function lineHeritage(opt) {
  const code = detectMtrLineCode(opt);
  if (!code) {
    const blob = `${opt?.route_long_name || ""} ${opt?.route_name || ""}`;
    if (/east\s*rail|west\s*rail|tuen\s*ma|ma\s*on\s*shan|light\s*rail/i.test(blob)) {
      return "kcr";
    }
    if (
      /tsuen\s*wan\s*line|kwun\s*tong\s*line|island\s*line|tung\s*chung\s*line|tseung\s*kwan\s*o|airport\s*express|south\s*island|disneyland/i.test(
        blob,
      )
    ) {
      return "mtr";
    }
    return "unknown";
  }
  if (KCR_HERITAGE.has(code)) return "kcr";
  if (MTR_HERITAGE.has(code)) return "mtr";
  return "unknown";
}

/**
 * At Admiralty: lines built in the same period share a normal interchange.
 * @returns {boolean} true if this pair should NOT get a long legacy penalty
 */
export function isAdmiraltySamePeriodPair(fromOpt, toOpt) {
  const c1 = detectMtrLineCode(fromOpt);
  const c2 = detectMtrLineCode(toOpt);
  if (!c1 || !c2 || c1 === c2) return false;

  const bothOriginal =
    ADMIRALTY_COHORT_ORIGINAL_MTR.has(c1) && ADMIRALTY_COHORT_ORIGINAL_MTR.has(c2);
  const bothExpansion =
    ADMIRALTY_COHORT_EXPANSION.has(c1) && ADMIRALTY_COHORT_EXPANSION.has(c2);

  return bothOriginal || bothExpansion;
}

/**
 * Whether an MTR→MTR change should use the longer former KCR–MTR penalty.
 *
 * @param {object} fromOpt route_options[0] of alighting leg
 * @param {object} toOpt route_options[0] of boarding leg
 * @param {object} [fromStop] alight stop
 * @param {object} [toStop] board stop
 */
export function isLegacyKcrMtrInterchange(fromOpt, toOpt, fromStop, toStop) {
  // Purpose-built integrated hubs
  if (isIntegratedInterchangeStop(fromStop) || isIntegratedInterchangeStop(toStop)) {
    return false;
  }

  const atAdmiralty = isAdmiraltyStop(fromStop) || isAdmiraltyStop(toStop);
  if (atAdmiralty) {
    // TWL ↔ ISL (original MTR) and SIL ↔ EAL (2010s wing): same-period, normal time
    if (isAdmiraltySamePeriodPair(fromOpt, toOpt)) {
      return false;
    }
    // Cross-wing at Admiralty (e.g. EAL ↔ TWL) still uses the expanded complex
    // designed to connect them — not a classic bolted-on KCR–MTR walk like Kln Tong.
    // Treat as normal MTR interchange (base MTR transfer penalty only).
    return false;
  }

  const h1 = lineHeritage(fromOpt);
  const h2 = lineHeritage(toOpt);
  const crossHeritage =
    (h1 === "kcr" && h2 === "mtr") || (h1 === "mtr" && h2 === "kcr");

  const atLongStation =
    isLongKcrMtrInterchangeStop(fromStop) || isLongKcrMtrInterchangeStop(toStop);

  // Only apply long surcharge at known long hubs (not every cross-heritage pair)
  if (!atLongStation) {
    return false;
  }

  const c1 = detectMtrLineCode(fromOpt);
  const c2 = detectMtrLineCode(toOpt);
  if (!c1 || !c2 || c1 === c2) return false;

  // Same-heritage pure original MTR (shouldn't hit long list often)
  if (h1 === "mtr" && h2 === "mtr") return false;

  // Cross-heritage at long hub (Kowloon Tong EAL↔KTL, Mei Foo TWL↔TML, Diamond Hill KTL↔TML, …)
  if (crossHeritage) return true;

  // Same-heritage KCR at sprawling hub (e.g. Hung Hom EAL↔TML)
  if (h1 === "kcr" && h2 === "kcr") return true;

  // Listed long station + different lines involving TML/EAL with urban MTR
  if (
    (KCR_HERITAGE.has(c1) && MTR_HERITAGE.has(c2)) ||
    (MTR_HERITAGE.has(c1) && KCR_HERITAGE.has(c2))
  ) {
    return true;
  }

  return false;
}

// ── Official free / paid-area interchanges (routing + ranking) ───────────────

/**
 * MTR-recommended pedestrian links between distinct station names.
 * Walks up to maxWalkM should be treated as station transfers (not “street”
 * penalties) so RAPTOR plans that use them rank competitively with buses.
 */
export const FREE_MTR_INTERCHANGE_LINKS = [
  {
    id: "cen_hok",
    codes: ["CEN", "HOK"],
    maxWalkM: 550,
    // Indoor paid-area walkway (IFC / Central–HK Station)
    indoor: true,
    match: (a, b) => {
      // Require MTR-ish station names — not bus stops that merely say "Central"
      const cen = (s) =>
        (/\bcentral\b/.test(s) || /中環/.test(s)) &&
        !/mid.?levels|ferry|pier|market|bus|bbi|interchange|hospital|library/i.test(s);
      // "Hong Kong (Platform 1)" / "Hong Kong Station" — not science park, hotels, etc.
      const hok = (s) =>
        (/^hong\s*kong(\s+station)?(\s*\(|$)/i.test(s.trim()) ||
          /hong\s*kong\s*\(platform/i.test(s) ||
          /香港站|香港\s*\(/.test(s)) &&
        !/university|大學|science|park|hotel|museum|airport|bus|minibus|ferry/i.test(s);
      return (cen(a) && hok(b)) || (cen(b) && hok(a));
    },
  },
  {
    id: "tst_ets",
    codes: ["TST", "ETS"],
    maxWalkM: 650,
    indoor: false, // MTR subway pedestrian tunnel (still free transfer)
    match: (a, b) => {
      const tst = (s) => /tsim\s*sha\s*tsui|尖沙咀/.test(s) && !/east|尖東/.test(s);
      const ets = (s) =>
        /east\s*tsim\s*sha\s*tsui|尖東/.test(s) ||
        (/tsim\s*sha\s*tsui/.test(s) && /east|尖東/.test(s));
      return (tst(a) && ets(b)) || (ets(a) && tst(b));
    },
  },
  {
    id: "mok_mkk",
    codes: ["MOK", "MKK"],
    maxWalkM: 750,
    indoor: false,
    match: (a, b) => {
      const mok = (s) => /mong\s*kok(?!\s*east)/i.test(s) || (/旺角/.test(s) && !/東/.test(s));
      const mkk = (s) => /mong\s*kok\s*east/i.test(s) || /旺角東/.test(s);
      return (mok(a) && mkk(b)) || (mkk(a) && mok(b));
    },
  },
];

/**
 * True if alight→board is an official free MTR interchange walk within budget.
 * Cross-station only (CEN↔HOK, TST↔ETS, MOK↔MKK) — never same-station
 * platform changes (those are ordinary in-station interchanges).
 *
 * @param {{ stop_name?: string, address?: string } | null | undefined} alightStop
 * @param {{ stop_name?: string, address?: string } | null | undefined} boardStop
 * @param {number} [distM]
 */
export function isFreeMtrInterchangeWalk(alightStop, boardStop, distM = 0) {
  const a = stopLabel(alightStop).toLowerCase();
  const b = stopLabel(boardStop).toLowerCase();
  if (!a || !b) return false;
  // Same station / same complex → not a "free link" between two stations
  if (isSameMtrStation(alightStop, boardStop)) return false;
  for (const link of FREE_MTR_INTERCHANGE_LINKS) {
    if (!link.match(a, b)) continue;
    if (distM > 0 && distM > link.maxWalkM) continue;
    return true;
  }
  return false;
}

/**
 * True when alight and board are the same MTR station (line change inside).
 * Official free links (CEN↔HOK, TST↔ETS, MOK↔MKK) are always distinct stations.
 *
 * @param {{ stop_name?: string, address?: string } | null | undefined} a
 * @param {{ stop_name?: string, address?: string } | null | undefined} b
 */
export function isSameMtrStation(a, b) {
  // Cross-station free pairs must never count as "same station"
  // (substring logic would otherwise treat East TST as TST, Mong Kok East as Mong Kok).
  if (isOfficialFreeLinkNamePair(a, b)) return false;
  if (sameStationComplexName(a, b)) return true;
  const na = normalizeStationName(stopLabel(a));
  const nb = normalizeStationName(stopLabel(b));
  if (!na || !nb) return false;
  if (na === nb) return true;
  // "Admiralty (Platform 1)" vs "Admiralty (Platform 3)" already covered by normalize
  // Strip parenthetical platforms again for safety
  const strip = (s) =>
    s
      .replace(/\(platform[^)]*\)/gi, "")
      .replace(/platform\s*\d+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  const sa = strip(na);
  const sb = strip(nb);
  if (!sa || !sb || sa.length < 2) return false;
  if (sa === sb) return true;
  // East / parent pairs remain distinct even after strip
  if (isEastParentNameMismatch(sa, sb)) return false;
  return false;
}

// ── Map geometry: indoor vs cross-station walks ─────────────────────────────

/**
 * Free outdoor / long pedestrian links between *different* MTR stations.
 * These should keep real walk geometry on the map (not a straight indoor chord).
 * Codes are station_code from mtr stations GeoJSON.
 */
export const CROSS_STATION_CODE_PAIRS = [
  ["TST", "ETS"], // Tsim Sha Tsui ↔ East Tsim Sha Tsui
  ["MOK", "MKK"], // Mong Kok ↔ Mong Kok East
  // CEN–HOK is indoor paid-area — not listed here (draw as indoor chord)
];

/**
 * @param {string | null | undefined} codeA
 * @param {string | null | undefined} codeB
 */
export function isCrossStationCodePair(codeA, codeB) {
  const a = String(codeA || "").toUpperCase();
  const b = String(codeB || "").toUpperCase();
  if (!a || !b || a === b) return false;
  for (const [x, y] of CROSS_STATION_CODE_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

/**
 * True when alight + board are the known outdoor cross-station pair
 * (TST↔ETS, Mong Kok↔Mong Kok East), not an in-station interchange.
 *
 * @param {{ stop_name?: string, address?: string } | null} alightStop
 * @param {{ stop_name?: string, address?: string } | null} boardStop
 * @param {string | null} [codeA]
 * @param {string | null} [codeB]
 */
export function isCrossStationInterchange(alightStop, boardStop, codeA, codeB) {
  if (isCrossStationCodePair(codeA, codeB)) return true;

  const na = stopLabel(alightStop).toLowerCase();
  const nb = stopLabel(boardStop).toLowerCase();
  if (!na || !nb) return false;

  const tst = (s) =>
    /tsim\s*sha\s*tsui|尖沙咀/.test(s) && !/east|尖東/.test(s);
  const ets = (s) =>
    /east\s*tsim\s*sha\s*tsui|尖東|東\s*tsim/i.test(s) ||
    (/tsim\s*sha\s*tsui/.test(s) && /east|尖東/.test(s));
  if ((tst(na) && ets(nb)) || (ets(na) && tst(nb))) return true;

  const mok = (s) => /mong\s*kok(?!\s*east)/i.test(s) || (/旺角/.test(s) && !/東/.test(s));
  const mkk = (s) => /mong\s*kok\s*east/i.test(s) || /旺角東/.test(s);
  if ((mok(na) && mkk(nb)) || (mkk(na) && mok(nb))) return true;

  return false;
}

/**
 * Indoor MTR line-change: draw a straight map chord (platforms are indoors).
 * Cross-station outdoor links and access/egress street walks return false.
 *
 * @param {object} walkLeg
 * @param {object | null} prevOpt  alighting route option
 * @param {object | null} nextOpt  boarding route option
 * @param {object | null} alightStop
 * @param {object | null} boardStop
 * @param {{ codeA?: string|null, codeB?: string|null }} [codes]
 */
export function isIndoorMtrInterchangeWalk(
  walkLeg,
  prevOpt,
  nextOpt,
  alightStop,
  boardStop,
  codes = {},
) {
  if (!walkLeg || walkLeg.type !== "walk") return false;
  if (!prevOpt || !nextOpt) return false;

  // Must be between two rail legs
  if (!looksLikeRailOption(prevOpt) || !looksLikeRailOption(nextOpt)) return false;

  const wtype = String(walkLeg.walk_type || "").toLowerCase();
  if (wtype === "access" || wtype === "egress") return false;

  const codeA = codes.codeA || null;
  const codeB = codes.codeB || null;

  // Official free outdoor corridors (TST↔ETS, MOK↔MKK) — full street path
  if (isCrossStationInterchange(alightStop, boardStop, codeA, codeB)) {
    return false;
  }

  // CEN↔HOK indoor paid-area walkway — straight chord on map
  const distProbe =
    walkLeg.distance_meters ?? (walkLeg.duration_seconds || 0) * 0.85;
  if (isFreeMtrInterchangeWalk(alightStop, boardStop, distProbe)) {
    const a = stopLabel(alightStop).toLowerCase();
    const b = stopLabel(boardStop).toLowerCase();
    const isCenHok =
      (/\bcentral\b|中環/.test(a) && /\bhong\s*kong\b|香港/.test(b)) ||
      (/\bcentral\b|中環/.test(b) && /\bhong\s*kong\b|香港/.test(a));
    if (isCenHok) return true;
  }

  // Router tags paid-area / in-station transfers
  if (wtype === "station_transfer") return true;

  // Same station complex (shared code or fuzzy name)
  if (codeA && codeB && codeA === codeB) return true;
  if (sameStationComplexName(alightStop, boardStop)) return true;

  // Short MTR↔MTR walk without street-scale distance → indoor
  const dist = walkLeg.distance_meters ?? (walkLeg.duration_seconds || 0) * 0.85;
  const secs = walkLeg.duration_seconds || 0;
  if (dist <= 280 && secs <= 300 && wtype !== "street") return true;

  return false;
}

function looksLikeRailOption(opt) {
  const mode = String(opt?.mode || "").toLowerCase();
  if (
    mode.includes("subway") ||
    mode.includes("rail") ||
    mode.includes("metro") ||
    mode.includes("tram") ||
    mode.includes("monorail")
  ) {
    return true;
  }
  return !!detectMtrLineCode(opt);
}

/**
 * True if names match an official free MTR link (distinct stations).
 */
function isOfficialFreeLinkNamePair(a, b) {
  const la = stopLabel(a).toLowerCase();
  const lb = stopLabel(b).toLowerCase();
  if (!la || !lb) return false;
  return FREE_MTR_INTERCHANGE_LINKS.some((link) => link.match(la, lb));
}

/**
 * East Tsim Sha Tsui / Mong Kok East vs their parent stations are distinct.
 * Naive includes("tsim sha tsui") on "east tsim sha tsui" must not merge them.
 */
function isEastParentNameMismatch(a, b) {
  const eastA = isEastStationName(a);
  const eastB = isEastStationName(b);
  if (eastA === eastB) return false;
  const rootA = stripEastStationMarker(a);
  const rootB = stripEastStationMarker(b);
  if (!rootA || !rootB) return false;
  return (
    rootA === rootB ||
    rootA.includes(rootB) ||
    rootB.includes(rootA)
  );
}

function isEastStationName(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return false;
  // English: leading/trailing "east", or "… east" compound
  if (/^east\s+/.test(t) || /\s+east$/.test(t)) return true;
  // Chinese MTR East stations
  if (/尖東|旺角東/.test(t)) return true;
  if (/東$/.test(t) && /[沙咀角]/.test(t)) return true; // 尖沙咀東-style rare forms
  return false;
}

function stripEastStationMarker(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^east\s+/, "")
    .replace(/\s+east$/, "")
    .replace(/尖東/g, "尖沙咀")
    .replace(/旺角東/g, "旺角")
    .replace(/東$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameStationComplexName(a, b) {
  if (isOfficialFreeLinkNamePair(a, b)) return false;

  const na = normalizeStationName(stopLabel(a));
  const nb = normalizeStationName(stopLabel(b));
  if (!na || !nb) return false;
  if (na === nb) return true;

  // East parent vs East child are never the same complex
  if (isEastParentNameMismatch(na, nb)) return false;

  // Only treat as same when one name is the other plus platform / stop junk —
  // not when the longer form is "east …" or an unrelated compound.
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (!shorter || !longer.includes(shorter)) return false;
  const remainder = longer.replace(shorter, " ").replace(/\s+/g, " ").trim();
  if (!remainder) return true;
  // Allow residual platform / gate / exit tokens only
  if (
    /^(platform\s*)?\d+$/i.test(remainder) ||
    /^(p\d+|exit\s*[a-z0-9]+|gate\s*\w+)$/i.test(remainder) ||
    /^\(.*\)$/.test(remainder)
  ) {
    return true;
  }
  return false;
}

function normalizeStationName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+station$/i, "")
    .replace(/站$/u, "")
    .replace(/\s*·\s*p\d+/i, "")
    .replace(/\s*platform\s*\d+/i, "")
    .replace(/\s*\(platform[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
