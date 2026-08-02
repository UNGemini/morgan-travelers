/**
 * Client-side fare estimates:
 *  - MTR heavy rail / AEL / LRT / MTR Bus (official multi-type matrices)
 *  - Franchised bus, GMB, ferry (full-journey adult via hk-bus-crawling pack)
 *  - Free AEL↔MTR domestic connection (Octopus / QR / contactless)
 *  - MTR↔GMB / designated bus-ferry Octopus interchange discounts ($0.5+)
 *  - Optional East Rail Line First Class premium
 *
 * Ticket types — see FARE_TYPES / FARE_TYPE_LABELS.
 *
 * MTR interchange discounts are a simplified model of the official scheme
 * (same plan = same “card”; no 1.5h wall-clock check; no Early Bird / Monthly Pass).
 */
import { detectMtrLineCode, isLightRailOption } from "./mtrColors.js";
import { LRT_STOPS, matchLrtStop } from "./lrtStops.js";
import {
  getMtrInterchangeRules,
  excludeIxAfterAelFreeMtr,
  isMtrInterchangeEnabled,
  getBusBusInterchangeRules,
  loadBbiCompactPairs,
  lookupBbiDiscount,
} from "./interchangeSchemes.js";

/**
 * @typedef {
 *   | "octopus_adult"
 *   | "octopus_child"
 *   | "octopus_student"
 *   | "octopus_joyyou_65"
 *   | "octopus_joyyou_60"
 *   | "qr_adult"
 *   | "qr_child"
 *   | "single_ride"
 *   | "contactless"
 *   | "china_tunion"
 * } FareType
 */

export const FARE_TYPE_STORAGE_KEY = "morgan.fareType";
export const EAL_FIRST_CLASS_STORAGE_KEY = "morgan.ealFirstClass";

/** @type {FareType[]} */
export const FARE_TYPES = [
  "octopus_adult",
  "octopus_child",
  "octopus_student",
  "octopus_joyyou_65",
  "octopus_joyyou_60",
  "qr_adult",
  "qr_child",
  "single_ride",
  "contactless",
  "china_tunion",
];

export const FARE_TYPE_LABELS = {
  octopus_adult: "Octopus Adult/Elderly",
  octopus_child: "Octopus Child",
  octopus_student: "Octopus Student",
  octopus_joyyou_65: "Octopus JoyYou Cards (65+)",
  octopus_joyyou_60: "Octopus JoyYou Cards (60–64)",
  qr_adult: "QR Code Adult/Elderly",
  qr_child: "QR Code Child",
  single_ride: "Single Ride Ticket/Cash",
  contactless: "Contactless Bank Cards",
  china_tunion: "China T-Union Cards",
};

/** Short hints for UI (optional title tooltips). */
export const FARE_TYPE_HINTS = {
  octopus_joyyou_65:
    "Concessionary fare on domestic MTR (excl. AEL, EAL First Class, Lo Wu & Lok Ma Chau).",
  octopus_joyyou_60:
    "JoyYou $2 / 20% scheme; full adult for AEL, Lo Wu, Lok Ma Chau, and Racecourse.",
  qr_adult: "Same rates as Octopus Adult/Elderly.",
  qr_child: "Same rates as Octopus Child.",
  contactless: "Same rates as Octopus Adult.",
  china_tunion: "Treated as adult Octopus rates on MTR / bus estimates.",
  single_ride: "Single-journey / cash ticket rates where published.",
};

/** Legacy ids → current FareType */
const FARE_TYPE_LEGACY = {
  octopus_joyyou: "octopus_joyyou_60",
  qr_code: "qr_adult",
  octopus_elder: "octopus_adult",
};

/**
 * @param {unknown} v
 * @returns {v is FareType}
 */
export function isFareType(v) {
  return FARE_TYPES.includes(/** @type {FareType} */ (v));
}

/**
 * @param {unknown} raw
 * @returns {FareType}
 */
function normalizeFareType(raw) {
  if (isFareType(raw)) return raw;
  const migrated = FARE_TYPE_LEGACY[/** @type {string} */ (raw)];
  if (isFareType(migrated)) return migrated;
  return "octopus_adult";
}

/**
 * @returns {FareType}
 */
export function loadFareType() {
  try {
    const raw = localStorage.getItem(FARE_TYPE_STORAGE_KEY);
    return normalizeFareType(raw);
  } catch {
    /* private mode */
  }
  return "octopus_adult";
}

/**
 * @param {FareType} type
 * @returns {FareType}
 */
export function saveFareType(type) {
  const next = normalizeFareType(type);
  try {
    localStorage.setItem(FARE_TYPE_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  activeFareType = next;
  return next;
}

/** @type {FareType} */
let activeFareType = loadFareType();

/** @type {boolean} */
let ealFirstClassOn = loadEalFirstClass();

export function getFareType() {
  return activeFareType;
}

/**
 * @param {FareType} [type]
 */
export function setFareType(type) {
  return saveFareType(type || "octopus_adult");
}

export function formatFareTypeLabel(type = activeFareType) {
  return FARE_TYPE_LABELS[type] || FARE_TYPE_LABELS.octopus_adult;
}

/** @returns {boolean} */
export function loadEalFirstClass() {
  try {
    return localStorage.getItem(EAL_FIRST_CLASS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * @param {boolean} on
 * @returns {boolean}
 */
export function saveEalFirstClass(on) {
  ealFirstClassOn = !!on;
  try {
    localStorage.setItem(EAL_FIRST_CLASS_STORAGE_KEY, ealFirstClassOn ? "1" : "0");
  } catch {
    /* ignore */
  }
  return ealFirstClassOn;
}

export function getEalFirstClass() {
  return ealFirstClassOn;
}

/**
 * @param {boolean} [on]
 */
export function setEalFirstClass(on) {
  return saveEalFirstClass(!!on);
}

/**
 * Map UI ticket type → matrix key inside hk-fares.json (v3+).
 * @param {FareType} type
 * @returns {string}
 */
function matrixKeyForType(type) {
  switch (type) {
    case "octopus_child":
    case "qr_child":
      return "octopus_child";
    case "octopus_student":
      return "octopus_student";
    case "octopus_joyyou_65":
      return "octopus_elderly";
    case "octopus_joyyou_60":
      // Formula from adult; optional joyyou_60 column used as hint only
      return "octopus_adult";
    case "single_ride":
      return "single_adult";
    case "qr_adult":
    case "contactless":
    case "china_tunion":
    case "octopus_adult":
    default:
      return "octopus_adult";
  }
}

/** Types that get free AEL → domestic MTR connection (MTR privilege). */
function supportsAelFreeMtrConnection(type) {
  return (
    type === "octopus_adult" ||
    type === "octopus_child" ||
    type === "octopus_student" ||
    type === "octopus_joyyou_65" ||
    type === "octopus_joyyou_60" ||
    type === "qr_adult" ||
    type === "qr_child" ||
    type === "contactless" ||
    type === "china_tunion"
  );
  // Single-ride / cash tickets: no free connection
}

/**
 * JoyYou / elderly exclusions for station names (OD ends).
 * @param {string} [name]
 * @param {"65"|"60"|null} age
 */
function isJoyYouExcludedStation(name, age) {
  const s = String(name || "");
  if (!s.trim()) return false;
  if (/lo\s*wu|羅湖/i.test(s)) return true;
  if (/lok\s*ma\s*chau|落馬洲/i.test(s)) return true;
  // 60–64: also full adult to/from Racecourse
  if (age === "60" && /racecourse|馬場/i.test(s)) return true;
  return false;
}

/**
 * @param {string} [from]
 * @param {string} [to]
 * @param {"65"|"60"|null} age
 */
function joyYouOdExcluded(from, to, age) {
  return isJoyYouExcludedStation(from, age) || isJoyYouExcludedStation(to, age);
}

function isMtrTransitOption(opt) {
  if (!opt) return false;
  if (isLightRailOption(opt)) return true;
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "bus" || mode === "ferry" || mode === "trolleybus") return false;
  if (["subway", "rail", "light_rail", "tram", "monorail"].includes(mode)) return true;
  if (detectMtrLineCode(opt)) return true;
  const agency = String(opt.agency?.name || opt.agency?.id || "").toLowerCase();
  if (agency === "lr") return true;
  return /\bmtr\b/.test(agency) && mode !== "bus";
}

function isFerryOption(opt) {
  if (!opt) return false;
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "ferry") return true;
  const agency = String(opt.agency?.name || opt.agency?.id || "").toLowerCase();
  return /ferry|hkkf|star\s*ferry|sun\s*ferry|fortune/.test(agency);
}

function isBusTransitOption(opt) {
  if (!opt || isMtrTransitOption(opt) || isFerryOption(opt)) return false;
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "bus" || mode === "trolleybus") return true;
  // Missing mode: treat non-rail agency as bus candidate when route looks like bus
  const agency = String(opt.agency?.name || opt.agency?.id || "").toLowerCase();
  if (/kmb|ctb|citybus|nlb|lwb|gmb|minibus|nwfb|new\s*world/.test(agency)) return true;
  return false;
}

function isMtrBusRoute(code) {
  const c = String(code || "").trim().toUpperCase();
  // K12…K76S, 506 (and lettered variants like K51A, K75P)
  return /^(K\d+[A-Z]?|506)$/i.test(c);
}

/**
 * @param {object} [opt]
 */
function isMtrBusAgency(opt) {
  if (!opt) return false;
  const kind = String(opt.kind || opt.etaKind || "").toLowerCase();
  if (kind === "mtr_bus" || kind === "mtrbus" || kind === "lrtfeeder") return true;
  const agency = `${opt.agency?.id || ""} ${opt.agency?.name || ""}`.toLowerCase();
  return /lrt\s*feeder|mtr\s*bus|mtrb|mtr_bus|港鐵巴士|輕鐵接駁/.test(agency);
}

/**
 * Map plan agency → hkbus company code.
 * @param {object} opt
 * @returns {string[]}
 */
function agencyCompanies(opt) {
  const blob = `${opt?.agency?.id || ""} ${opt?.agency?.name || ""}`.toLowerCase();
  const out = [];
  if (/lrt\s*feeder|mtr\s*bus|mtrb|\bmtr\b.*bus|bus.*\bmtr\b/.test(blob)) {
    out.push("lrtfeeder");
  }
  if (/\bkmb\b|kowloon\s*motor|lwb|long\s*win/.test(blob)) out.push("kmb");
  if (/\bctb\b|citybus|nwfb|new\s*world/.test(blob)) out.push("ctb");
  if (/\bnlb\b|new\s*lanto/.test(blob)) out.push("nlb");
  if (/\bgmb\b|green\s*mini|minibus|專線/.test(blob)) out.push("gmb");
  if (/fortune/.test(blob)) out.push("fortuneferry");
  if (/sun\s*ferry|新渡輪/.test(blob)) out.push("sunferry");
  if (/hkkf|香港油麻地|h\.?k\.?\s*ferry/.test(blob)) out.push("hkkf");
  if (/star\s*ferry/.test(blob)) out.push("starferry");
  return out;
}

/** @type {null | FarePack} */
let pack = null;
let loadPromise = null;

/**
 * @typedef {object} FarePack
 * @property {string} currency
 * @property {string} [fare_type]
 * @property {number} [version]
 * @property {object} mtr
 * @property {object} ael
 * @property {object} lrt
 * @property {object} mtrBus
 */

/**
 * @typedef {object} FarePart
 * @property {string} kind  mtr | ael | lrt | mtr_bus | bus_unknown
 * @property {string} label
 * @property {number | null} amount  HKD, null if unknown
 */

/**
 * @typedef {object} PlanFare
 * @property {number | null} total
 * @property {string} currency
 * @property {FarePart[]} parts
 * @property {boolean} incomplete  true if some legs lack fare data
 * @property {string} fare_type
 */

/**
 * @param {object | null | undefined} typed
 * @param {"od"|"bus"} kind
 */
function typedMapHasData(typed, kind = "od") {
  if (!typed || typeof typed !== "object") return false;
  if (kind === "bus") {
    return Object.keys(typed).some((k) => k !== "byId" && k !== "byName" && k !== "byType");
  }
  return (
    Object.keys(typed.byId || {}).length > 0 ||
    Object.keys(typed.byName || {}).length > 0
  );
}

/**
 * Resolve { byId, byName } maps for a ticket type (v2+ byType or legacy flat).
 * @param {object | null | undefined} section
 * @param {string} matrixKey  pack byType key (or UI FareType for legacy packs)
 * @param {"od"|"bus"} kind
 */
function mapsFor(section, matrixKey, kind = "od") {
  if (!section) return kind === "bus" ? {} : { byId: {}, byName: {} };

  // Prefer exact pack key, then legacy aliases
  const candidates = [matrixKey];
  if (matrixKey === "single_adult") candidates.push("qr_code", "single_ride");
  if (matrixKey === "octopus_elderly") {
    candidates.push("octopus_joyyou_65", "octopus_joyyou");
  }
  if (matrixKey === "octopus_adult") {
    candidates.push("contactless", "qr_adult");
  }

  for (const key of candidates) {
    const typed = section.byType?.[key];
    if (typedMapHasData(typed, kind)) return typed;
  }

  const needsOwn =
    matrixKey === "octopus_student" ||
    matrixKey === "octopus_child" ||
    matrixKey === "octopus_elderly" ||
    matrixKey === "single_adult" ||
    matrixKey === "single_child";

  if (needsOwn) {
    return kind === "bus" ? {} : { byId: {}, byName: {} };
  }

  if (kind === "bus") {
    if (typedMapHasData(section.byType?.octopus_adult, "bus")) {
      return section.byType.octopus_adult;
    }
    return section;
  }
  if (typedMapHasData(section.byType?.octopus_adult, "od")) {
    return section.byType.octopus_adult;
  }
  return {
    byId: section.byId || {},
    byName: section.byName || {},
  };
}

/**
 * OD lookup in a { byId, byName } map pair.
 * @param {{ byId?: Record<string, number>, byName?: Record<string, number> }} maps
 * @param {string} from
 * @param {string} to
 * @param {Record<string, string>} [idToName]
 */
function lookupOdFare(maps, from, to, idToName = {}) {
  if (!maps || !from || !to) return null;
  if (from === to) return 0;
  const nameKey = `${from}|${to}`;
  if (maps.byName?.[nameKey] != null) return maps.byName[nameKey];

  const nameToId = {};
  for (const [id, name] of Object.entries(idToName || {})) {
    nameToId[name] = id;
    nameToId[String(name).toLowerCase()] = id;
  }
  const fid = nameToId[from] || nameToId[from.toLowerCase()];
  const tid = nameToId[to] || nameToId[to.toLowerCase()];
  if (fid && tid && maps.byId?.[`${fid}>${tid}`] != null) {
    return maps.byId[`${fid}>${tid}`];
  }
  return null;
}

export function isFaresReady() {
  return pack != null;
}

/** Loaded fare pack (for route catalog / tools). */
export function getFarePack() {
  return pack;
}

export async function initFares() {
  if (pack) return pack;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // Bus–bus BBI compact map (KMB/LWB offline summary) — parallel with fares pack
    void loadBbiCompactPairs();
    const base =
      (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
    // Cache-bust so student/child matrices are not stuck on an old adult-only pack
    const url = new URL(`${base}fares/hk-fares.json`, window.location.href);
    url.searchParams.set("v", "5");
    const res = await fetch(url.href, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Fare data missing (${res.status}) — run npm run build:fares`);
    pack = await res.json();
    const adultMaps = mapsFor(pack.mtr, "octopus_adult");
    const stuN = Object.keys(pack.mtr?.byType?.octopus_student?.byId || {}).length;
    const childN = Object.keys(pack.mtr?.byType?.octopus_child?.byId || {}).length;
    console.info(
      "[fares] loaded",
      pack.updated_at,
      "v" + (pack.version || 1),
      "mtr pairs",
      Object.keys(adultMaps.byId || {}).length,
      "student",
      stuN,
      "child",
      childN,
      "type",
      activeFareType,
    );
    if (stuN < 100 || childN < 100) {
      console.warn(
        "[fares] concession matrices missing/incomplete — run npm run build:fares",
      );
    }
    return pack;
  })();
  try {
    return await loadPromise;
  } catch (e) {
    loadPromise = null;
    throw e;
  }
}

/** Strip platform / parentheticals → base station name for MTR matrix. */
export function normalizeStationName(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  // "Tung Chung (Platform 1)" → "Tung Chung"
  s = s.replace(/\s*\([^)]*platform[^)]*\)\s*/gi, "").trim();
  s = s.replace(/\s*\([^)]*月台[^)]*\)\s*/gi, "").trim();
  // leftover parens content often bilingual noise
  s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  // "元朗站 Yuen Long Station" → try English token
  const eng = s.match(/[A-Za-z][A-Za-z\s\-']+[A-Za-z]/);
  if (eng && /[\u4e00-\u9fff]/.test(s)) {
    s = eng[0].trim();
  }
  // Drop trailing "Station" / "站" for matching
  s = s.replace(/\s+station$/i, "").replace(/站$/u, "").trim();
  return s;
}

const STATION_ALIASES = {
  // Common GTFS / display variants → MTR CSV English names
  hku: "HKU",
  "hong kong university": "HKU",
  "hong kong": "Hong Kong",
  "hongkong": "Hong Kong",
  "tsim sha tsui": "Tsim Sha Tsui",
  "east tsim sha tsui": "East Tsim Sha Tsui",
  "exhibition centre": "Exhibition Centre",
  "exhibition center": "Exhibition Centre",
  "disneyland resort": "Disneyland Resort",
  "disneyland": "Disneyland Resort",
  "asiaworld-expo": "AsiaWorld-Expo",
  "asia world expo": "AsiaWorld-Expo",
  "awe": "AsiaWorld-Expo",
  "airport": "Airport",
  "lok ma chau": "Lok Ma Chau",
  "lo wu": "Lo Wu",
  "racecourse": "Racecourse",
};

function resolveMtrStationKey(raw) {
  const n = normalizeStationName(raw);
  if (!n || !pack) return null;
  const lower = n.toLowerCase();
  if (STATION_ALIASES[lower]) return STATION_ALIASES[lower];

  // Exact match against known names
  const names = Object.values(pack.mtr.idToName || {});
  for (const name of names) {
    if (name.toLowerCase() === lower) return name;
  }
  // Prefix / contains
  for (const name of names) {
    const nl = name.toLowerCase();
    if (lower.startsWith(nl) || nl.startsWith(lower)) return name;
    if (lower.includes(nl) || nl.includes(lower)) return name;
  }
  // AEL names (v2/v3 use byType)
  const aelNames = new Set();
  const aelMaps =
    pack.ael?.byType?.octopus_adult?.byName || pack.ael?.byName || {};
  for (const k of Object.keys(aelMaps)) {
    const [a, b] = k.split("|");
    if (a) aelNames.add(a);
    if (b) aelNames.add(b);
  }
  for (const name of aelNames) {
    if (name.toLowerCase() === lower) return name;
    if (name.replace(/\s/g, "").toLowerCase() === lower.replace(/\s/g, "")) return name;
  }
  return n; // last resort raw normalized
}

/** AEL CSV uses HongKong (no space), Kowloon, Tsing Yi, Airport, AsiaWorld-Expo */
function aelStationKey(raw) {
  const n = resolveMtrStationKey(raw) || normalizeStationName(raw);
  if (!n) return null;
  if (/^hong\s*kong$/i.test(n)) return "HongKong";
  if (/asia\s*world/i.test(n) || /^awe$/i.test(n)) return "AsiaWorld-Expo";
  if (/^airport$/i.test(n)) return "Airport";
  if (/^kowloon$/i.test(n)) return "Kowloon";
  if (/^tsing\s*yi$/i.test(n)) return "Tsing Yi";
  return n.replace(/\s+/g, "");
}

/**
 * Resolve LRT official Stop ID from GTFS stop id / name.
 * @param {object | null | undefined} stop  { stop_id, stop_name, id, name }
 * @returns {string | null}
 */
function resolveLrtStationId(stop) {
  if (!stop || !pack) return null;
  const rawId = String(stop.stop_id || stop.id || "").trim();
  const name = stop.stop_name || stop.name || "";

  // Direct fare-matrix id
  if (rawId && pack.lrt?.byType?.octopus_adult?.byId?.[`${rawId}>${rawId}`] != null) {
    return rawId;
  }
  if (rawId && pack.lrt?.idToName?.[rawId]) return rawId;

  // Digits from GTFS ids like "LR-15" / "lrt_15"
  const digits = rawId.match(/(\d{1,4})$/);
  if (digits && pack.lrt?.idToName?.[digits[1]]) return digits[1];

  // Official code map
  const code = String(rawId || "")
    .replace(/^lr[_-]?/i, "")
    .toUpperCase();
  if (code && pack.lrt?.codeToId?.[code]) return pack.lrt.codeToId[code];

  // Name via pack
  const n = normalizeStationName(name);
  if (n && pack.lrt?.nameToId) {
    const k = n.toLowerCase();
    if (pack.lrt.nameToId[k]) return pack.lrt.nameToId[k];
    if (pack.lrt.nameToId[k.replace(/\s+/g, "")]) {
      return pack.lrt.nameToId[k.replace(/\s+/g, "")];
    }
    if (pack.lrt.nameToId[n]) return pack.lrt.nameToId[n];
  }

  // Local LRT_STOPS directory
  const hit = matchLrtStop(name, null, null, 0);
  if (hit?.stop_id) return String(hit.stop_id);
  for (const s of LRT_STOPS) {
    if (s.name_en.toLowerCase() === n.toLowerCase()) return String(s.stop_id);
    if (s.name_zh && name.includes(s.name_zh)) return String(s.stop_id);
    if (s.code && s.code.toUpperCase() === code) return String(s.stop_id);
  }
  return null;
}

/**
 * @param {string} fromRaw
 * @param {string} toRaw
 * @param {FareType} [type]
 */
function mtrOdFare(fromRaw, toRaw, type = activeFareType) {
  if (!pack) return null;
  const from = resolveMtrStationKey(fromRaw);
  const to = resolveMtrStationKey(toRaw);
  if (!from || !to) return null;
  if (from === to) return 0;

  const idToName = pack.mtr.idToName || {};
  // JoyYou 65+ / 60–64: excluded border / Racecourse ODs → adult
  if (type === "octopus_joyyou_65" && joyYouOdExcluded(from, to, "65")) {
    return lookupOdFare(mapsFor(pack.mtr, "octopus_adult"), from, to, idToName);
  }
  if (type === "octopus_joyyou_60" && joyYouOdExcluded(from, to, "60")) {
    return lookupOdFare(mapsFor(pack.mtr, "octopus_adult"), from, to, idToName);
  }

  const matrix = matrixKeyForType(type);
  let amount = lookupOdFare(mapsFor(pack.mtr, matrix), from, to, idToName);
  if (amount != null) return amount;

  // JoyYou 65+ elderly column missing → try child concession as last resort, then adult
  if (type === "octopus_joyyou_65") {
    amount = lookupOdFare(mapsFor(pack.mtr, "octopus_elderly"), from, to, idToName);
    if (amount != null) return amount;
    return lookupOdFare(mapsFor(pack.mtr, "octopus_adult"), from, to, idToName);
  }

  if (type === "octopus_student") {
    amount = lookupOdFare(mapsFor(pack.mtr, "octopus_child"), from, to, idToName);
    if (amount != null) return amount;
  }
  if (type === "octopus_child" || type === "qr_child") {
    amount = lookupOdFare(mapsFor(pack.mtr, "octopus_student"), from, to, idToName);
    if (amount != null) return amount;
  }

  // Adult fallback with rough concessions when pack incomplete
  amount = lookupOdFare(mapsFor(pack.mtr, "octopus_adult"), from, to, idToName);
  if (amount == null) return null;
  if (type === "octopus_student" || type === "octopus_child" || type === "qr_child") {
    return Math.round(amount * 0.5 * 10) / 10;
  }
  if (type === "single_ride") {
    return Math.round(amount * 1.15 * 10) / 10;
  }
  return amount;
}

/**
 * @param {string} fromRaw
 * @param {string} toRaw
 * @param {FareType} [type]
 */
function aelOdFare(fromRaw, toRaw, type = activeFareType) {
  if (!pack) return null;
  const a = aelStationKey(fromRaw);
  const b = aelStationKey(toRaw);
  if (!a || !b) return null;
  if (a === b) return 0;

  const lookup = (maps) => {
    if (!maps) return null;
    if (maps.byName?.[`${a}|${b}`] != null) return maps.byName[`${a}|${b}`];
    for (const [k, v] of Object.entries(maps.byName || {})) {
      const [x, y] = k.split("|");
      if (
        x.replace(/\s/g, "").toLowerCase() === a.replace(/\s/g, "").toLowerCase() &&
        y.replace(/\s/g, "").toLowerCase() === b.replace(/\s/g, "").toLowerCase()
      ) {
        return v;
      }
    }
    return null;
  };

  // JoyYou / elderly concessions do not apply on AEL — full adult (or child/single)
  const aelType =
    type === "octopus_joyyou_65" || type === "octopus_joyyou_60"
      ? "octopus_adult"
      : type === "qr_adult" || type === "contactless" || type === "china_tunion"
        ? "octopus_adult"
        : type === "qr_child"
          ? "octopus_child"
          : type === "single_ride"
            ? "single_adult"
            : type;

  const matrix = matrixKeyForType(/** @type {FareType} */ (aelType === "single_adult" ? "single_ride" : aelType));
  let amount = lookup(mapsFor(pack.ael, matrix));
  if (amount != null) return amount;

  if (type === "octopus_child" || type === "qr_child") {
    amount = lookup(mapsFor(pack.ael, "octopus_child"));
    if (amount != null) return amount;
    amount = lookup(mapsFor(pack.ael, "octopus_adult"));
    return amount != null ? Math.round(amount * 0.5 * 10) / 10 : null;
  }
  if (type === "single_ride") {
    amount = lookup(mapsFor(pack.ael, "single_adult"));
    if (amount != null) return amount;
    amount = lookup(mapsFor(pack.ael, "octopus_adult"));
    return amount != null ? Math.round(amount * 1.15 * 10) / 10 : null;
  }
  // Student / others: adult AEL (no student column)
  return lookup(mapsFor(pack.ael, "octopus_adult"));
}

/**
 * @param {string} fromId
 * @param {string} toId
 * @param {FareType} [type]
 */
function lrtOdFare(fromId, toId, type = activeFareType) {
  if (!pack || !fromId || !toId) return null;
  const matrix = matrixKeyForType(type);
  const maps = mapsFor(pack.lrt, matrix);
  const key = `${fromId}>${toId}`;
  if (maps.byId?.[key] != null) return maps.byId[key];
  if (matrix !== "octopus_adult") {
    const adult = mapsFor(pack.lrt, "octopus_adult");
    return adult.byId?.[key] ?? null;
  }
  return null;
}

/**
 * @param {string} routeShort
 * @param {FareType} [type]
 */
function mtrBusFare(routeShort, type = activeFareType) {
  if (!pack || !routeShort) return null;
  const id = String(routeShort).trim().toUpperCase();
  const matrix = matrixKeyForType(type);
  const maps = mapsFor(pack.mtrBus, matrix, "bus");
  if (maps && typeof maps === "object" && !maps.byId) {
    if (maps[id] != null) return maps[id];
  }
  if (pack.mtrBus?.[id] != null) return pack.mtrBus[id];
  const adult = mapsFor(pack.mtrBus, "octopus_adult", "bus");
  return adult?.[id] ?? null;
}

/**
 * Apply ticket-type scaling for bus/ferry when only adult full fare is known.
 * JoyYou is applied later via {@link joyYouPayableFromAdult} on each leg.
 * @param {number | null} adult
 * @param {FareType} type
 */
function scaleAdultFare(adult, type) {
  if (adult == null) return null;
  if (type === "octopus_child" || type === "qr_child") {
    return Math.round(adult * 0.5 * 10) / 10;
  }
  // Student / QR adult / contactless / JoyYou base: adult full-journey
  // (JoyYou 60 formula applied later per leg)
  return adult;
}

/**
 * JoyYou Card payable amount from the normal adult Octopus fare.
 *
 * Rules:
 *  - Original ≤ HK$10 → flat HK$2 (or the original fare if already &lt; $2)
 *  - Original &gt; HK$10 → 20% of adult fare, rounded to the nearest 10 cents
 *  - Interchanges: apply the same rule per leg on the adult fare after
 *    free MTR↔LRT / operator free legs (BBI cash concessions not modelled)
 *
 * @param {number | null | undefined} adultHkd
 * @returns {number | null}
 */
export function joyYouPayableFromAdult(adultHkd) {
  if (adultHkd == null || Number.isNaN(Number(adultHkd))) return null;
  const a = Number(adultHkd);
  if (a <= 0) return 0;
  if (a <= 10) return Math.min(a, 2);
  // 20% of adult, nearest $0.10
  return Math.round(a * 0.2 * 10) / 10;
}

/**
 * Convert every priced leg to JoyYou payable (keeps nulls / free $0).
 * @param {FarePart[]} parts
 */
function applyJoyYouToParts(parts) {
  for (const p of parts) {
    if (p.amount == null) continue;
    // Walk / already-free legs stay $0
    if (p.kind === "walk" || p.amount === 0) continue;
    // AEL is excluded from JoyYou concessions
    if (p.kind === "ael") continue;
    // First-class premium line items stay adult
    if (/1st\s*class|first\s*class/i.test(p.label || "")) continue;
    const adult = p.amount;
    p.amount = joyYouPayableFromAdult(adult);
    if (p.amount != null && adult !== p.amount) {
      p.adult_amount = adult;
    }
  }
}

/** Normalize bus stop label for TD RSTOP name matching. */
function normBusStopName(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .toUpperCase()
    // TD embeds bilingual "EN / / Zh" or "EN / EN"
    .replace(/\s*\/+\s*/g, " ")
    .replace(/[()[\],.\-]/g, " ")
    .replace(/\b(BUS\s*)?(TERMINUS|TERM|STATION|STN|STOP|BT)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Expand a raw label into match candidates (split bilingual TD / ETA forms).
 * @param {string} raw
 * @returns {string[]}
 */
function expandStopLabelParts(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const parts = s
    .split(/\s*\/+\s*|<br\s*\/?>/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set([s, ...parts])];
}

/**
 * Score how well a plan stop matches a TD stop name (higher = better).
 * @param {string} tdName
 * @param {string} planName
 */
function busStopMatchScore(tdName, planName) {
  const a = normBusStopName(tdName);
  const b = normBusStopName(planName);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (a.startsWith(b) || b.startsWith(a)) return 800;
  if (a.includes(b) || b.includes(a)) return 600;
  // Token overlap
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = b.split(" ").filter((t) => t.length > 2);
  if (!ta.size || !tb.length) return 0;
  let hit = 0;
  for (const t of tb) if (ta.has(t)) hit += 1;
  if (hit === 0) return 0;
  return 200 + Math.round((400 * hit) / Math.max(ta.size, tb.length));
}

/**
 * Candidate labels for a plan stop (EN preferred — TD pack is English).
 * @param {{ stop_name?: string, name?: string, name_en?: string, name_tc?: string, stop_name_en?: string } | null | undefined} planStop
 * @returns {string[]}
 */
function planStopLabelCandidates(planStop) {
  if (!planStop) return [];
  const out = [];
  for (const k of [
    planStop.name_en,
    planStop.stop_name_en,
    planStop.stop_name,
    planStop.name,
    planStop.name_tc,
  ]) {
    for (const part of expandStopLabelParts(k)) {
      if (!out.includes(part)) out.push(part);
    }
  }
  return out;
}

/**
 * Best 0-based index of plan stop in TD ordered stop list.
 * @param {string[]} tdStops
 * @param {{ stop_name?: string, name?: string, name_en?: string } | null | undefined} planStop
 * @returns {{ index: number, score: number } | null}
 */
function matchTdStopIndexScored(tdStops, planStop, opts = {}) {
  if (!tdStops?.length) return null;
  const names = planStopLabelCandidates(planStop);
  if (!names.length) return null;
  const minI = opts.minIndex != null ? opts.minIndex : 0;
  const maxI =
    opts.maxIndex != null ? opts.maxIndex : tdStops.length - 1;
  let best = null;
  let bestScore = 0;
  for (let i = Math.max(0, minI); i <= Math.min(tdStops.length - 1, maxI); i++) {
    // Also expand TD bilingual labels
    const tdParts = expandStopLabelParts(tdStops[i]);
    for (const tdPart of tdParts.length ? tdParts : [tdStops[i]]) {
      for (const name of names) {
        const sc = busStopMatchScore(tdPart, name);
        if (sc > bestScore) {
          bestScore = sc;
          best = i;
        }
      }
    }
  }
  // Slightly lower threshold: 400 was too strict for partial EN matches
  return bestScore >= 400 && best != null ? { index: best, score: bestScore } : null;
}

/**
 * Best 0-based index of plan stop in TD ordered stop list.
 * @param {string[]} tdStops
 * @param {{ stop_name?: string, name?: string } | null | undefined} planStop
 */
function matchTdStopIndex(tdStops, planStop) {
  return matchTdStopIndexScored(tdStops, planStop)?.index ?? null;
}

/**
 * Map a 0-based index on the plan sequence onto a TD stop list (uniform).
 * @param {number} planI
 * @param {number} planN
 * @param {number} tdN
 */
function mapPlanIndexToTd(planI, planN, tdN) {
  if (tdN <= 1) return 0;
  if (planN <= 1) return 0;
  if (planN === tdN) return Math.min(tdN - 1, Math.max(0, planI));
  return Math.min(
    tdN - 1,
    Math.max(0, Math.round((planI / (planN - 1)) * (tdN - 1))),
  );
}

/**
 * Align every plan stop to a TD stop index.
 * Uses name matches as anchors (monotonic), fills gaps by local interpolation.
 * This keeps section-fare steps on the correct stops when EN/zh lists differ in length.
 *
 * @param {object[]} planStops
 * @param {string[]} tdStops
 * @returns {{ tdIndex: number[], anchors: number, score: number }}
 */
function alignPlanStopsToTd(planStops, tdStops) {
  const planN = planStops?.length || 0;
  const tdN = tdStops?.length || 0;
  /** @type {(number | null)[]} */
  const raw = Array(planN).fill(null);
  if (!planN || !tdN) {
    return { tdIndex: [], anchors: 0, score: 0 };
  }

  let anchorScore = 0;
  let anchors = 0;
  // Sequential forward match: each stop must map at/after the previous TD index
  let minI = 0;
  for (let i = 0; i < planN; i++) {
    const hit = matchTdStopIndexScored(tdStops, planStops[i], {
      minIndex: minI,
      maxIndex: tdN - 1,
    });
    if (hit && hit.score >= 400) {
      raw[i] = hit.index;
      anchors += 1;
      anchorScore += hit.score;
      minI = hit.index; // allow same stop if lists denser; next can equal
    }
  }

  // Force endpoints when missing (route start / terminus)
  if (raw[0] == null) raw[0] = 0;
  if (raw[planN - 1] == null) raw[planN - 1] = tdN - 1;

  // Enforce non-decreasing TD indices (forward direction)
  /** @type {number[]} */
  const mono = raw.map((v) => (v == null ? -1 : v));
  let last = 0;
  for (let i = 0; i < planN; i++) {
    if (mono[i] < 0) continue;
    if (mono[i] < last) mono[i] = last;
    last = mono[i];
  }
  let next = tdN - 1;
  for (let i = planN - 1; i >= 0; i--) {
    if (mono[i] < 0) continue;
    if (mono[i] > next) mono[i] = next;
    next = mono[i];
  }

  // Interpolate holes between anchors
  /** @type {number[]} */
  const out = Array(planN).fill(0);
  let i = 0;
  while (i < planN) {
    if (mono[i] >= 0) {
      out[i] = mono[i];
      i += 1;
      continue;
    }
    let j = i;
    while (j < planN && mono[j] < 0) j += 1;
    const leftI = i - 1;
    const rightI = j;
    const leftV = leftI >= 0 ? out[leftI] : 0;
    const rightV = rightI < planN ? mono[rightI] : tdN - 1;
    const span = Math.max(1, rightI - leftI);
    for (let k = i; k < j; k++) {
      const t = (k - leftI) / span;
      out[k] = Math.round(leftV + (rightV - leftV) * t);
      if (k > 0 && out[k] < out[k - 1]) out[k] = out[k - 1];
    }
    i = j;
  }
  for (let k = 0; k < planN; k++) {
    out[k] = Math.max(0, Math.min(tdN - 1, out[k]));
    if (k > 0 && out[k] < out[k - 1]) out[k] = out[k - 1];
  }
  if (planN >= 2) {
    out[planN - 1] = Math.min(tdN - 1, Math.max(out[planN - 1], out[planN - 2]));
  }

  return { tdIndex: out, anchors, score: anchorScore };
}

/**
 * Score how well a TD bound matches our plan sequence (for O vs I).
 * @param {object[]} planStops
 * @param {string[]} tdStops
 */
function scoreTdBoundForPlan(planStops, tdStops) {
  if (!planStops?.length || !tdStops?.length) return 0;
  const first = matchTdStopIndexScored(tdStops, planStops[0]);
  const last = matchTdStopIndexScored(
    tdStops,
    planStops[planStops.length - 1],
  );
  let sc = 0;
  if (first) sc += first.score + (first.index <= 2 ? 200 : 0);
  if (last) {
    sc += last.score;
    if (last.index >= tdStops.length - 3) sc += 200;
  }
  // Prefer similar length
  const ratio =
    Math.min(planStops.length, tdStops.length) /
    Math.max(planStops.length, tdStops.length);
  sc += Math.round(ratio * 100);
  return sc;
}

/**
 * Triangular index for 0-based on < off among n stops.
 * Row-major: for on in 0..n-2, off in on+1..n-1
 */
function triFareIndex(on, off, n) {
  // number of pairs before row `on`: sum_{k=0}^{on-1} (n-1-k)
  return (on * (2 * n - on - 1)) / 2 + (off - on - 1);
}

/**
 * Company|route keys for TD bus section lookup.
 * @param {object} opt
 * @param {string} route
 * @returns {string[]}
 */
function tdBusSectionKeys(opt, route) {
  const cos = agencyCompanies(opt);
  const keys = [];
  const push = (co) => {
    const c = String(co || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (!c || c === "bus") return;
    // LWB shares KMB TD tables often under kmb
    const list = c === "lwb" ? ["lwb", "kmb"] : [c];
    for (const x of list) {
      const k = `${x}|${route}`;
      if (!keys.includes(k)) keys.push(k);
    }
  };
  for (const co of cos) push(co);
  push(opt?.agency?.id);
  push(opt?.agency?.name);
  // Scan pack for any company with this route number (covers missing agency)
  if (pack?.busSection) {
    const suf = `|${route}`;
    for (const k of Object.keys(pack.busSection)) {
      if (k.endsWith(suf) && !keys.includes(k)) keys.push(k);
    }
  }
  if (!keys.length) {
    for (const co of ["kmb", "ctb", "nlb", "lrtfeeder", "gmb", "lwb"]) {
      push(co);
    }
  }
  return keys;
}

/**
 * Read triangular fare cell; if missing, walk toward terminus / origin for a value.
 * @param {number[]} tri
 * @param {number} on
 * @param {number} off
 * @param {number} n
 * @returns {number | null} cents
 */
function triFareCentsFlexible(tri, on, off, n) {
  if (!tri?.length || n < 2) return null;
  let i = Math.max(0, Math.min(n - 2, on));
  let j = Math.max(i + 1, Math.min(n - 1, off));
  const tryCell = (a, b) => {
    if (a < 0 || b <= a || b >= n) return null;
    const idx = triFareIndex(a, b, n);
    const c = tri[idx];
    return c != null && c >= 0 ? c : null;
  };
  let c = tryCell(i, j);
  if (c != null) return c;
  // Prefer ride to terminus from this board
  for (let b = n - 1; b > i; b--) {
    c = tryCell(i, b);
    if (c != null) return c;
  }
  // Soften board index slightly
  for (let a = i; a >= 0; a--) {
    c = tryCell(a, n - 1);
    if (c != null) return c;
  }
  for (let a = i; a < n - 1; a++) {
    c = tryCell(a, n - 1);
    if (c != null) return c;
  }
  return null;
}

/**
 * TD section fare (HKD) for a bus leg using FARE_BUS.mdb pack.
 * Aligns the full plan stop list onto TD stops (name anchors + monotonic
 * interpolation) so section steps start on the correct boarding stop.
 *
 * Optional: opt.boardIndex / opt.alightIndex on the full `opt.stops` sequence.
 *
 * @param {object} opt
 * @returns {number | null}
 */
function tdBusSectionFare(opt) {
  if (!pack?.busSection || !opt) return null;
  const route = String(opt.route_short_name || opt.route_name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!route) return null;

  const keys = tdBusSectionKeys(opt, route);

  const planStops =
    opt.stops?.length >= 2
      ? opt.stops
      : [opt.from, opt.to].filter(Boolean);
  if (planStops.length < 1) return null;

  const planN = planStops.length;
  let boardIdx =
    typeof opt.boardIndex === "number" && Number.isFinite(opt.boardIndex)
      ? Math.max(0, Math.min(planN - 1, Math.round(opt.boardIndex)))
      : 0;
  let alightIdx =
    typeof opt.alightIndex === "number" && Number.isFinite(opt.alightIndex)
      ? Math.max(0, Math.min(planN - 1, Math.round(opt.alightIndex)))
      : planN - 1;
  if (opt.boardIndex == null && opt.from) {
    const fi = planStops.findIndex(
      (s) =>
        s === opt.from ||
        (opt.from.stop_id &&
          (s.stop_id === opt.from.stop_id || s.id === opt.from.stop_id)) ||
        (opt.from.name &&
          (s.name === opt.from.name || s.stop_name === opt.from.name)),
    );
    if (fi >= 0) boardIdx = fi;
  }
  if (alightIdx <= boardIdx) alightIdx = planN - 1;
  if (alightIdx <= boardIdx) return null;

  let bestPrice = null;
  let bestScore = -1;
  let fullFallback = null;

  for (const key of keys) {
    const variants = pack.busSection[key];
    if (!variants?.length) continue;
    for (const variant of variants) {
      if (fullFallback == null && variant.full != null) {
        fullFallback = variant.full / 10;
      }
      const bounds = variant.b || {};
      // Prefer the bound that best matches plan endpoints (correct O/I).
      // TD keys are ROUTE_SEQ "1"/"2" — map O→1, I→2 when known.
      const wantSeq = (() => {
        const b = String(opt.bound || opt.headsign_bound || "").toUpperCase();
        if (b.startsWith("I") || b === "2" || b === "INBOUND") return "2";
        if (b.startsWith("O") || b === "1" || b === "OUTBOUND") return "1";
        return "";
      })();
      /** @type {Array<{ stops: string[], tri: number[], boundSc: number }>} */
      const boundList = [];
      for (const [bKey, bound] of Object.entries(bounds)) {
        const stops = bound.s || bound.stops || [];
        const tri = bound.t || bound.tri || [];
        if (stops.length < 2 || !tri.length) continue;
        let boundSc = scoreTdBoundForPlan(planStops, stops);
        if (wantSeq && String(bKey) === wantSeq) boundSc += 500;
        boundList.push({ stops, tri, boundSc });
      }
      boundList.sort((a, b) => b.boundSc - a.boundSc);

      for (const { stops, tri, boundSc } of boundList) {
        const n = stops.length;
        const align = alignPlanStopsToTd(planStops, stops);
        if (!align.tdIndex.length) continue;

        let on = align.tdIndex[boardIdx] ?? mapPlanIndexToTd(boardIdx, planN, n);
        let off =
          align.tdIndex[alightIdx] ?? mapPlanIndexToTd(alightIdx, planN, n);
        // Riding to end of this bound when alight is plan terminus
        if (alightIdx >= planN - 1) off = n - 1;
        if (off <= on) off = Math.min(n - 1, on + 1);

        const cents = triFareCentsFlexible(tri, on, off, n);
        if (cents == null) continue;

        // Score: bound fit + alignment anchors + prefer earlier board mapping consistency
        const sc =
          boundSc * 2 +
          align.score +
          align.anchors * 50 +
          (align.anchors >= 2 ? 300 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          bestPrice = cents / 10;
        }
        // Top bound is enough when it scored well
        if (boundSc >= 400 && align.anchors >= 1) break;
      }
    }
  }

  if (bestPrice != null) return bestPrice;
  if (fullFallback != null) return fullFallback;

  for (const key of keys) {
    const variants = pack.busSection[key];
    if (!variants?.length) continue;
    const regular = variants.find((v) => v.mode === "R" && v.full != null);
    const any = variants.find((v) => v.full != null);
    const full = (regular || any)?.full;
    if (full != null) return full / 10;
  }
  return null;
}

/**
 * Franchised bus / GMB / ferry fare (TD section when possible).
 * @param {object} opt
 * @param {FareType} [type]
 */
function busOrFerryFare(opt, type = activeFareType) {
  if (!pack || !opt) return null;
  const route = String(opt.route_short_name || opt.route_name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!route) return null;

  // Official MTR Bus table first (has multi-type)
  if (isMtrBusRoute(route)) {
    const m = mtrBusFare(route, type);
    if (m != null) return m;
  }

  // TD FARE_BUS.mdb section fares (board→alight)
  if (!isFerryOption(opt)) {
    const section = tdBusSectionFare(opt);
    if (section != null) return scaleAdultFare(section, type);
  }

  const bus = pack.bus;
  if (!bus) return null;
  const cos = agencyCompanies(opt);
  for (const co of cos) {
    const k = `${co}|${route}`;
    if (bus.byCoRoute?.[k] != null) {
      return scaleAdultFare(bus.byCoRoute[k], type);
    }
  }
  // Try all cos with route if agency unknown
  if (!cos.length && bus.byCoRoute) {
    const hits = Object.entries(bus.byCoRoute)
      .filter(([k]) => k.endsWith(`|${route}`))
      .map(([, v]) => v);
    if (hits.length === 1) return scaleAdultFare(hits[0], type);
    if (hits.length > 1) return scaleAdultFare(Math.min(...hits), type);
  }
  if (bus.byRoute?.[route] != null) {
    return scaleAdultFare(bus.byRoute[route], type);
  }
  // lrtfeeder fallback for K-routes
  if (bus.byCoRoute?.[`lrtfeeder|${route}`] != null) {
    return scaleAdultFare(bus.byCoRoute[`lrtfeeder|${route}`], type);
  }
  return null;
}

function lineCode(opt) {
  return detectMtrLineCode(opt) || String(opt?.route_short_name || "").toUpperCase();
}

function isAel(opt) {
  return lineCode(opt) === "AEL" || /airport\s*express/i.test(opt?.route_long_name || "");
}

function isLrt(opt) {
  // Agency LR / LRT route codes — not all mode=tram (HK Island tramways)
  return isLightRailOption(opt) || lineCode(opt) === "LRT";
}

/**
 * Official free MTR ↔ Light Rail interchange hubs (Octopus).
 * @see https://www.mtr.com.hk — Free interchange with Light Rail at
 * Tuen Mun, Siu Hong, Tin Shui Wai, Yuen Long.
 */
function isLrtMtrFreeHubName(name) {
  const s = String(name || "");
  if (!s.trim()) return false;
  // Exclude non-hub LRT stops that share the district name
  if (/ferry\s*pier|碼頭|hospital|醫院|town\s*centre|市中心/i.test(s)) {
    return false;
  }
  if (/siu\s*hong|兆康/i.test(s)) return true;
  if (/tin\s*shui\s*wai|天水圍/i.test(s)) return true;
  if (/yuen\s*long|元朗/i.test(s)) return true;
  // Tuen Mun Station (not Ferry Pier / Hospital / Town Centre)
  if (/tuen\s*mun|屯門/i.test(s)) return true;
  return false;
}

/** Free LRT↔MTR section only with Octopus-family (not single-ride cash). */
function octopusSupportsLrtFreeInterchange(type) {
  return (
    type === "octopus_adult" ||
    type === "octopus_student" ||
    type === "octopus_child" ||
    type === "octopus_joyyou_65" ||
    type === "octopus_joyyou_60"
  );
}

function isEalOption(opt) {
  if (!opt) return false;
  const code = lineCode(opt);
  if (code === "EAL") return true;
  const blob = `${opt.route_short_name || ""} ${opt.route_long_name || ""} ${opt.route_name || ""}`;
  return /east\s*rail|東鐵/i.test(blob);
}

/**
 * Collect board→alight span of all EAL legs in a plan (for first-class premium).
 * @param {object[]} legs
 * @returns {{ from: string, to: string } | null}
 */
function ealSpanFromLegs(legs) {
  let from = null;
  let to = null;
  for (const leg of legs || []) {
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    if (!opt || !isEalOption(opt)) continue;
    const f = opt.from?.stop_name;
    const t = opt.to?.stop_name;
    if (!from && f) from = f;
    if (t) to = t;
  }
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Free domestic MTR when interchanging with Airport Express
 * (Octopus / QR / contactless within 1 hour — we model fare only).
 * Does not free LRT, MTR Bus, or First Class premium.
 * @param {FarePart[]} parts
 * @param {object[]} legs
 * @param {FareType} type
 */
function applyAelFreeMtrConnection(parts, legs, type) {
  if (!supportsAelFreeMtrConnection(type)) return;
  if (!parts.some((p) => p.kind === "ael")) return;
  if (!parts.some((p) => p.kind === "mtr")) return;
  // Require AEL and domestic MTR both present in the itinerary
  let hasAel = false;
  let hasDomesticMtr = false;
  for (const leg of legs || []) {
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    if (!opt) continue;
    if (isAel(opt)) hasAel = true;
    else if (isMtrTransitOption(opt) && !isAel(opt) && !isLrt(opt)) {
      hasDomesticMtr = true;
    }
  }
  if (!hasAel || !hasDomesticMtr) return;

  for (const p of parts) {
    if (p.kind !== "mtr") continue;
    if (p.amount == null) continue;
    if (p.amount === 0) continue;
    p.adult_amount = p.adult_amount ?? p.amount;
    p.amount = 0;
    if (!/free\s*AEL/i.test(p.label)) {
      p.label = `${p.label} · free AEL connection`;
    }
  }
}

/**
 * East Rail Line First Class: add premium ≈ ordinary EAL OD fare
 * (official: first-class fare − ordinary for the EAL section).
 * @param {FarePart[]} parts
 * @param {object[]} legs
 * @param {FareType} type
 * @param {boolean} enabled
 */
function applyEalFirstClassPremium(parts, legs, type, enabled) {
  if (!enabled) return;
  const span = ealSpanFromLegs(legs);
  if (!span) return;
  // Premium from adult ordinary EAL OD (first class not sold as concession)
  const premium = mtrOdFare(span.from, span.to, "octopus_adult");
  if (premium == null || premium <= 0) return;

  // Prefer attaching to the MTR part; else add a separate line item
  const mtrPart = parts.find((p) => p.kind === "mtr" && p.amount != null);
  if (mtrPart) {
    mtrPart.amount = Math.round((Number(mtrPart.amount) + premium) * 10) / 10;
    if (!/1st\s*class|first\s*class/i.test(mtrPart.label)) {
      mtrPart.label = `${mtrPart.label} · EAL 1st class +$${premium.toFixed(1)}`;
    }
  } else {
    parts.push({
      kind: "mtr",
      label: `EAL First Class ${normalizeStationName(span.from)} → ${normalizeStationName(span.to)}`,
      amount: premium,
    });
  }
}

/**
 * True when the itinerary connects LRT ↔ MTR heavy rail at a free hub
 * (walk/wait between allowed).
 * @param {object[]} legs
 */
function planHasLrtMtrFreeInterchange(legs) {
  if (!legs?.length) return false;
  /** @type {{ kind: "lrt"|"mtr", from?: object, to?: object } | null} */
  let prev = null;
  for (const leg of legs) {
    if (leg.type === "wait" || leg.type === "walk") continue;
    if (leg.type !== "transit") {
      prev = null;
      continue;
    }
    const opt = leg.route_options?.[0];
    if (!opt) continue;

    let kind = null;
    if (isLrt(opt)) kind = "lrt";
    else if (isMtrTransitOption(opt) && !isAel(opt) && !isLrt(opt)) kind = "mtr";
    else {
      prev = null;
      continue;
    }

    if (prev && prev.kind !== kind) {
      const alight = prev.to;
      const board = opt.from;
      const alightName = alight?.stop_name || alight?.name || "";
      const boardName = board?.stop_name || board?.name || "";
      // Free when the transfer is at an official hub (either side of the walk)
      if (
        isLrtMtrFreeHubName(alightName) ||
        isLrtMtrFreeHubName(boardName)
      ) {
        return true;
      }
    }
    prev = { kind, from: opt.from, to: opt.to };
  }
  return false;
}

/**
 * Zero LRT parts when free MTR↔LRT interchange applies (Octopus).
 * @param {FarePart[]} parts
 * @param {object[]} legs
 * @param {FareType} type
 */
function applyLrtMtrFreeInterchange(parts, legs, type) {
  if (!octopusSupportsLrtFreeInterchange(type)) return;
  if (!parts.some((p) => p.kind === "lrt")) return;
  if (!parts.some((p) => p.kind === "mtr")) return;
  if (!planHasLrtMtrFreeInterchange(legs)) return;

  for (const p of parts) {
    if (p.kind !== "lrt") continue;
    p.amount = 0;
    if (!/\bfree\b/i.test(p.label)) {
      p.label = `${p.label} · free MTR interchange`;
    }
  }
}

/**
 * MTR↔PT Octopus interchange rules live in
 * {@link ./data/interchange-schemes.json} (edit there when operators change).
 *
 * Modelled: same itinerary has MTR heavy rail + eligible bus/ferry.
 * Not modelled: wall-clock 90/1.5h timer, voiding rides, Early Bird, Monthly Pass.
 *
 * @typedef {import('./interchangeSchemes.js').MtrIxRule} MtrIxRule
 */

function isGmbOption(opt) {
  if (!opt) return false;
  if (agencyCompanies(opt).includes("gmb")) return true;
  const blob = `${opt.agency?.id || ""} ${opt.agency?.name || ""} ${opt.route_long_name || ""}`;
  return /\bgmb\b|green\s*mini|minibus|專線小巴|專線/i.test(blob);
}

/** Octopus-family tickets that can receive GMB $0.5 (all Octopus per T&C). */
function octopusSupportsGmbInterchange(type) {
  return (
    type === "octopus_adult" ||
    type === "octopus_child" ||
    type === "octopus_student" ||
    type === "octopus_joyyou_65" ||
    type === "octopus_joyyou_60" ||
    type === "qr_adult" ||
    type === "qr_child" ||
    type === "contactless" ||
    type === "china_tunion"
  );
}

function isAdultOctopusFamily(type) {
  return (
    type === "octopus_adult" ||
    type === "qr_adult" ||
    type === "contactless" ||
    type === "china_tunion"
  );
}

function isStudentOctopus(type) {
  return type === "octopus_student";
}

/**
 * Domestic heavy-rail MTR station names touched by the plan (board + alight).
 * Excludes AEL / LRT stops.
 * @param {object[]} legs
 * @returns {string[]}
 */
function domesticMtrStationNames(legs) {
  /** @type {string[]} */
  const names = [];
  for (const leg of legs || []) {
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    if (!opt) continue;
    if (!isMtrTransitOption(opt) || isAel(opt) || isLrt(opt)) continue;
    for (const n of [opt.from?.stop_name, opt.to?.stop_name]) {
      if (n && String(n).trim()) names.push(String(n));
    }
  }
  return names;
}

/**
 * @param {string[]} stationNames
 * @param {RegExp[] | null} patterns
 */
function mtrStationsMatch(stationNames, patterns) {
  if (!patterns) return true; // any domestic MTR
  const blob = stationNames.join(" · ");
  return patterns.some((re) => re.test(blob));
}

/**
 * @param {string} route
 * @param {string[]} cos
 * @param {MtrIxRule} rule
 */
function routeMatchesIxRule(route, cos, rule) {
  const r = String(route || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const coOk = cos.some((c) => rule.cos.includes(c));
  if (!coOk) return false;
  if (rule.routes.includes("*")) return true;
  if (!r) return false;
  return rule.routes.some(
    (rr) => rr.toUpperCase().replace(/\s+/g, "") === r,
  );
}

/**
 * Discount HKD for this ticket type under a rule (null = not eligible).
 * @param {MtrIxRule} rule
 * @param {FareType} type
 * @param {number | null} adultFareHint
 */
function discountForIxRule(rule, type, adultFareHint) {
  // Student-specific rate (e.g. Kam Sheung 78 / 792M)
  if (isStudentOctopus(type) && rule.student != null) {
    return rule.student;
  }
  if (isAdultOctopusFamily(type)) {
    if (rule.fareBands?.length && adultFareHint != null) {
      const bands = [...rule.fareBands].sort(
        (a, b) => b.minAdultFare - a.minAdultFare,
      );
      for (const b of bands) {
        if (adultFareHint >= b.minAdultFare) return b.adult;
      }
    }
    return rule.adult;
  }
  // Adult-only franchised / kaito offers
  if (rule.adultOnly) return null;
  // Other Octopus (child / JoyYou / etc.) — GMB network $0.5 and GMB “other”
  if (rule.other == null) return null;
  if (!octopusSupportsGmbInterchange(type)) return null;
  return rule.other;
}

/**
 * Apply MTR↔GMB / designated PT Octopus interchange discounts to bus/ferry parts.
 * Skipped when AEL free MTR connection already zeroed all MTR fares (T&C).
 *
 * @param {FarePart[]} parts
 * @param {object[]} legs
 * @param {FareType} type
 */
function applyMtrInterchangeDiscounts(parts, legs, type) {
  if (!isMtrInterchangeEnabled()) return;
  if (!octopusSupportsGmbInterchange(type) && !isAdultOctopusFamily(type)) {
    return;
  }
  const mtrStations = domesticMtrStationNames(legs);
  if (!mtrStations.length) return;

  // T&C: not eligible right after AEL free MTR connection
  const mtrParts = parts.filter((p) => p.kind === "mtr");
  const aelParts = parts.filter((p) => p.kind === "ael");
  if (
    excludeIxAfterAelFreeMtr() &&
    aelParts.length &&
    mtrParts.length &&
    mtrParts.every((p) => p.amount === 0)
  ) {
    return;
  }

  // Need a paid domestic MTR component (or at least MTR present if incomplete)
  const hasPaidOrUnknownMtr = mtrParts.some(
    (p) => p.amount == null || p.amount > 0,
  );
  if (!hasPaidOrUnknownMtr && mtrParts.length) return;
  if (!mtrParts.length) return;

  const rules = getMtrInterchangeRules();
  if (!rules.length) return;

  for (const p of parts) {
    if (p.amount == null || p.amount <= 0) continue;
    if (p.kind !== "bus" && p.kind !== "gmb" && p.kind !== "ferry") continue;
    if (p._mtr_ix_applied) continue;

    const route = String(p.route || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
    const cos = Array.isArray(p.companies) && p.companies.length
      ? p.companies
      : p.kind === "gmb"
        ? ["gmb"]
        : p.kind === "ferry"
          ? ["hkkf", "fortuneferry", "sunferry"]
          : [];
    if (!route && p.kind !== "ferry") continue;

    let best = 0;
    /** @type {MtrIxRule | null} */
    let bestRule = null;
    for (const rule of rules) {
      if (!routeMatchesIxRule(route || "*", cos, rule)) continue;
      if (!mtrStationsMatch(mtrStations, rule.stations)) continue;
      // Adult fare hint for GMB 52 bands: use pre-discount amount
      const adultHint =
        p.adult_amount != null ? Number(p.adult_amount) : Number(p.amount);
      const d = discountForIxRule(rule, type, adultHint);
      if (d == null || d <= 0) continue;
      if (d > best) {
        best = d;
        bestRule = rule;
      }
    }
    if (best <= 0 || !bestRule) continue;

    // Cap: discount ≤ fare of this leg (and not higher than remaining amount)
    const before = Number(p.amount);
    const save = Math.min(best, before);
    if (save <= 0) continue;
    if (p.adult_amount == null) p.adult_amount = before;
    p.amount = Math.round((before - save) * 10) / 10;
    p._mtr_ix_applied = true;
    p.mtr_ix_discount = save;
    if (!/MTR\s*ix|interchange\s*−|−\$/i.test(p.label)) {
      p.label = `${p.label} · −$${save.toFixed(1)} MTR ix`;
    }
  }
}

/**
 * Same-itinerary bus–bus BBI.
 * Primary: compact pair map from offline KMB/LWB summarize (public/fares/bbi-compact.json).
 * Secondary: hand rules in interchange-schemes.json bus_bus.rules.
 * Applies discount to the *second* matching bus leg.
 * @param {FarePart[]} parts
 * @param {FareType} type
 */
function applyBusBusInterchangeDiscounts(parts, type) {
  // Octopus / contactless family — cash single-ride skipped
  if (
    type === "single_ride" ||
    (!octopusSupportsGmbInterchange(type) && !isAdultOctopusFamily(type))
  ) {
    return;
  }

  const busParts = parts.filter(
    (p) =>
      (p.kind === "bus" || p.kind === "gmb" || p.kind === "mtr_bus") &&
      p.amount != null &&
      p.amount > 0 &&
      !p._bbi_applied,
  );
  if (busParts.length < 2) return;

  const handRules = getBusBusInterchangeRules();

  for (let i = 0; i < busParts.length - 1; i++) {
    const a = busParts[i];
    const b = busParts[i + 1];
    const aRoute = String(a.route || "").toUpperCase().replace(/\s+/g, "");
    const bRoute = String(b.route || "").toUpperCase().replace(/\s+/g, "");
    if (!aRoute || !bRoute) continue;

    let best = lookupBbiDiscount(aRoute, bRoute);

    // Optional hand rules (Citybus curated, etc.)
    const aCos = a.companies || [];
    const bCos = b.companies || [];
    for (const rule of handRules) {
      if (rule.adultOnly && !isAdultOctopusFamily(type)) continue;
      const fromOk =
        (!rule.fromCos.length || aCos.some((c) => rule.fromCos.includes(c))) &&
        (rule.fromRoutes.includes("*") || rule.fromRoutes.includes(aRoute));
      const toOk =
        (!rule.toCos.length || bCos.some((c) => rule.toCos.includes(c))) &&
        (rule.toRoutes.includes("*") || rule.toRoutes.includes(bRoute));
      if (!fromOk || !toOk) continue;
      if (rule.discount > best) best = rule.discount;
    }

    if (best <= 0) continue;
    // Apply to second leg (typical “next journey” discount)
    const target = b;
    const before = Number(target.amount);
    const save = Math.min(best, before);
    if (save <= 0) continue;
    if (target.adult_amount == null) target.adult_amount = before;
    target.amount = Math.round((before - save) * 10) / 10;
    target._bbi_applied = true;
    if (!/BBI|bus.?bus|−\$/i.test(target.label)) {
      target.label = `${target.label} · −$${save.toFixed(1)} BBI`;
    }
  }
}

/**
 * Estimate fare for a planned journey using the active (or given) ticket type.
 * Continuous MTR heavy-rail legs share one OD fare (network pricing).
 * Continuous LRT legs share one OD fare. AEL / bus / ferry are separate legs.
 * LRT is free when interchanging with MTR at Tuen Mun / Siu Hong /
 * Tin Shui Wai / Yuen Long (Octopus free-interchange scheme).
 * GMB (and designated CTB/KMB/NLB/ferry) get MTR Octopus interchange discounts.
 *
 * JoyYou Card: priced from adult Octopus via {@link joyYouPayableFromAdult}
 * (≤$10 → $2; &gt;$10 → 20% rounded to 10¢), applied per leg after free legs.
 *
 * @param {import('./router.ts').Plan} plan
 * @param {FareType} [fareType]
 * @returns {PlanFare}
 */
export function estimatePlanFare(plan, fareType = activeFareType) {
  const type = normalizeFareType(fareType);
  // JoyYou 60–64: price from adult matrices, then formula
  // JoyYou 65+: elderly matrix (with exclusions handled in mtrOdFare / aelOdFare)
  const lookupType =
    type === "octopus_joyyou_60" ? "octopus_adult" : type;
  /** @type {FarePart[]} */
  const parts = [];
  let incomplete = false;

  if (!pack) {
    return {
      total: null,
      currency: "HKD",
      parts: [],
      incomplete: true,
      fare_type: type,
      eal_first_class: ealFirstClassOn,
    };
  }

  const legs = plan.legs || [];
  let i = 0;
  while (i < legs.length) {
    const leg = legs[i];
    // Walk / wait: always $0 (not missing)
    if (leg.type === "walk") {
      const meters = leg.distance_meters;
      const dist =
        meters != null && Number.isFinite(meters)
          ? meters < 1000
            ? `${Math.round(meters)} m`
            : `${(meters / 1000).toFixed(1)} km`
          : "";
      parts.push({
        kind: "walk",
        label: dist ? `Walk ${dist}` : "Walk",
        amount: 0,
      });
      i += 1;
      continue;
    }
    if (leg.type !== "transit") {
      i += 1;
      continue;
    }
    const opt = leg.route_options?.[0];
    if (!opt) {
      i += 1;
      continue;
    }

    // ── Airport Express (separate matrix) ──
    if (isAel(opt)) {
      const from = opt.from?.stop_name;
      const to = opt.to?.stop_name;
      const amount = aelOdFare(from, to, lookupType);
      parts.push({
        kind: "ael",
        label: `AEL ${normalizeStationName(from)} → ${normalizeStationName(to)}`,
        amount,
      });
      if (amount == null) incomplete = true;
      i += 1;
      continue;
    }

    // ── Light Rail: collapse consecutive LRT into one OD ──
    if (isLrt(opt)) {
      const startStop = opt.from;
      let endStop = opt.to;
      let j = i + 1;
      while (j < legs.length) {
        const L = legs[j];
        if (L.type === "wait") {
          j += 1;
          continue;
        }
        if (L.type === "walk") {
          const dist = L.distance_meters ?? 0;
          if (dist <= 250) {
            j += 1;
            continue;
          }
          break;
        }
        if (L.type === "transit") {
          const o2 = L.route_options?.[0];
          if (o2 && isLrt(o2)) {
            endStop = o2.to;
            j += 1;
            continue;
          }
        }
        break;
      }
      const fromId = resolveLrtStationId(startStop);
      const toId = resolveLrtStationId(endStop);
      const amount =
        fromId && toId ? lrtOdFare(fromId, toId, lookupType) : null;
      parts.push({
        kind: "lrt",
        label: `Light Rail ${normalizeStationName(startStop?.stop_name)} → ${normalizeStationName(endStop?.stop_name)}`,
        amount,
      });
      if (amount == null) incomplete = true;
      i = j;
      continue;
    }

    // ── MTR heavy rail: collapse consecutive MTR (non-AEL) legs into one OD ──
    if (isMtrTransitOption(opt) && !isAel(opt) && !isLrt(opt)) {
      const start = opt.from?.stop_name;
      let end = opt.to?.stop_name;
      let j = i + 1;
      while (j < legs.length) {
        const L = legs[j];
        if (L.type === "wait") {
          j += 1;
          continue;
        }
        if (L.type === "walk") {
          const wtype = String(L.walk_type || "");
          const dist = L.distance_meters ?? 0;
          if (wtype === "station_transfer" || dist <= 400) {
            j += 1;
            continue;
          }
          break;
        }
        if (L.type === "transit") {
          const o2 = L.route_options?.[0];
          if (
            o2 &&
            isMtrTransitOption(o2) &&
            !isAel(o2) &&
            !isLrt(o2)
          ) {
            end = o2.to?.stop_name;
            j += 1;
            continue;
          }
        }
        break;
      }
      const amount = mtrOdFare(start, end, lookupType);
      parts.push({
        kind: "mtr",
        label: `MTR ${normalizeStationName(start)} → ${normalizeStationName(end)}`,
        amount,
      });
      if (amount == null) incomplete = true;
      i = j;
      continue;
    }

    // ── Bus / GMB / MTR Bus / Ferry ──
    if (isBusTransitOption(opt) || isFerryOption(opt)) {
      const code = String(opt.route_short_name || opt.route_name || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
      const amount = busOrFerryFare(opt, lookupType);
      const cos = agencyCompanies(opt);
      const gmb = isGmbOption(opt) || cos.includes("gmb");
      const kind = isFerryOption(opt)
        ? "ferry"
        : isMtrBusRoute(code)
          ? "mtr_bus"
          : gmb
            ? "gmb"
            : "bus";
      const labelPrefix =
        kind === "ferry"
          ? "Ferry"
          : kind === "mtr_bus"
            ? "MTR Bus"
            : kind === "gmb"
              ? "GMB"
              : "Bus";
      parts.push({
        kind,
        label: `${labelPrefix} ${code || opt.route_name || ""}`.trim(),
        amount,
        route: code,
        companies: cos.length ? cos : gmb ? ["gmb"] : [],
      });
      // Bus fares are full-journey estimates (not section OD) — mark soft incomplete
      if (amount == null) incomplete = true;
      i += 1;
      continue;
    }

    // HK Tramways flat adult ~$3.0 (not in open OD pack)
    const blob = `${opt.route_long_name || ""} ${opt.agency?.name || ""}`;
    if (/tramways|香港電車|hk\s*tram/i.test(blob) || String(opt.mode).toLowerCase() === "tram") {
      const tramAdult = 3.0;
      const amount =
        lookupType === "octopus_child" || lookupType === "qr_child"
          ? 1.5
          : tramAdult;
      parts.push({
        kind: "tram",
        label: "Hong Kong Tramways",
        amount,
      });
      i += 1;
      continue;
    }

    parts.push({
      kind: "bus_unknown",
      label: opt.route_short_name || opt.route_name || "Transit",
      amount: null,
    });
    incomplete = true;
    i += 1;
  }

  // Octopus free interchange: LRT section $0 when connecting to MTR at hub
  applyLrtMtrFreeInterchange(parts, legs, type);

  // Free domestic MTR when also riding Airport Express (same card privilege)
  applyAelFreeMtrConnection(parts, legs, type);

  // MTR↔GMB $0.5+ / designated CTB·KMB·NLB·ferry (rules: interchange-schemes.json)
  applyMtrInterchangeDiscounts(parts, legs, type);

  // Optional same-operator bus–bus BBI when rules enabled in schemes file
  applyBusBusInterchangeDiscounts(parts, type);

  // EAL First Class premium (after free connection so premium still applies)
  applyEalFirstClassPremium(parts, legs, type, ealFirstClassOn);

  // JoyYou 60–64: per-leg formula on adult fares (after free legs / discounts)
  // Does not re-discount AEL (already adult) or free $0 legs
  if (type === "octopus_joyyou_60") {
    applyJoyYouToParts(parts);
  }

  // Total = sum of known amounts (walk $0 counts; missing transit = N/A, not $0)
  const known = parts.map((p) => p.amount).filter((a) => a != null);
  const hasPricedTransit = parts.some(
    (p) => p.kind !== "walk" && p.amount != null,
  );
  const hasMissingTransit = parts.some(
    (p) => p.kind !== "walk" && p.amount == null,
  );
  const walkOnly =
    parts.length > 0 && parts.every((p) => p.kind === "walk");

  let total = null;
  if (walkOnly) {
    total = 0;
  } else if (hasPricedTransit) {
    // Include walk $0 in the sum when other legs are priced
    total = Math.round(known.reduce((s, a) => s + a, 0) * 100) / 100;
  }
  // else: only missing transit (N/A) — even if walks are $0, headline is N/A

  return {
    total,
    currency: pack.currency || "HKD",
    parts,
    incomplete: hasMissingTransit,
    fare_type: type,
    eal_first_class: ealFirstClassOn,
  };
}

export function formatHkd(amount) {
  if (amount == null || Number.isNaN(amount)) return "N/A";
  return `$${Number(amount).toFixed(1).replace(/\.0$/, ".0")}`;
}

/**
 * Section fare (HKD) if boarding a bus at stop index `boardIndex` and
 * riding to the terminus (last stop). Rail / ferry → null.
 * Uses TD FARE_BUS section table; index-maps when names don’t match (zh vs en).
 *
 * @param {object} baseOpt  route option shell (route_short_name, agency, mode…)
 * @param {object[] | null | undefined} stops full stop sequence
 * @param {number} boardIndex index into `stops`
 * @param {FareType} [fareType]
 * @returns {number | null}
 */
/**
 * Board → terminus fare when only the boarding stop is known (search cards).
 * Matches the stop into TD by name and reads the triangle cell to terminus.
 *
 * @param {object} baseOpt
 * @param {{ name?: string, name_en?: string, stop_name?: string, nameEn?: string } | null} boardStop
 * @param {FareType} [fareType]
 * @returns {number | null}
 */
export function estimateBusBoardToTerminusByStop(
  baseOpt,
  boardStop,
  fareType = activeFareType,
) {
  if (!baseOpt || !boardStop) return null;
  if (isFerryOption(baseOpt) || isMtrTransitOption(baseOpt)) return null;
  const route = String(baseOpt.route_short_name || baseOpt.route_name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!route) return null;

  // Flat MTR Bus fares (opendata mtr_bus_fares.csv) — no section triangle
  if (isMtrBusRoute(route) || isMtrBusAgency(baseOpt)) {
    const m = mtrBusFare(route, fareType);
    if (m != null) return m;
  }

  if (!pack?.busSection) return null;
  const keys = tdBusSectionKeys(
    { ...baseOpt, bound: baseOpt.bound || "" },
    route,
  );
  const wantSeq = (() => {
    const b = String(baseOpt.bound || "").toUpperCase();
    if (b.startsWith("I") || b === "2") return "2";
    if (b.startsWith("O") || b === "1") return "1";
    return "";
  })();

  let best = null;
  let bestSc = -1;
  for (const key of keys) {
    const variants = pack.busSection[key];
    if (!variants?.length) continue;
    for (const variant of variants) {
      for (const [bKey, bound] of Object.entries(variant.b || {})) {
        const stops = bound.s || bound.stops || [];
        const tri = bound.t || bound.tri || [];
        if (stops.length < 2 || !tri.length) continue;
        const hit = matchTdStopIndexScored(stops, boardStop);
        if (!hit) continue;
        let sc = hit.score;
        if (wantSeq && String(bKey) === wantSeq) sc += 200;
        // Prefer earlier matches on outbound-like bounds
        if (hit.index < stops.length - 1) sc += 10;
        const cents = triFareCentsFlexible(
          tri,
          hit.index,
          stops.length - 1,
          stops.length,
        );
        if (cents == null) continue;
        if (sc > bestSc) {
          bestSc = sc;
          best = cents / 10;
        }
      }
      if (best == null && variant.full != null) {
        best = variant.full / 10;
        bestSc = 1;
      }
    }
  }
  if (best == null) return null;
  return scaleAdultFare(best, fareType);
}

export function estimateBusBoardFare(
  baseOpt,
  stops,
  boardIndex = 0,
  fareType = activeFareType,
) {
  // Back-compat: old signature (baseOpt, board, stops, alight, fareType)
  if (
    stops &&
    !Array.isArray(stops) &&
    arguments.length >= 3 &&
    Array.isArray(arguments[2])
  ) {
    const board = stops;
    const seq = arguments[2];
    const alight = arguments[3] ?? null;
    const type = arguments[4] ?? activeFareType;
    let idx = 0;
    if (board && seq?.length) {
      const found = seq.findIndex(
        (s) =>
          s === board ||
          (board.stopId &&
            (s.stopId === board.stopId || s.stop_id === board.stopId)) ||
          (board.name && (s.name === board.name || s.stop_name === board.name)),
      );
      if (found >= 0) idx = found;
    }
    return estimateBusBoardFare(baseOpt, seq, idx, type);
  }

  if (!baseOpt || !pack) return null;
  if (isFerryOption(baseOpt) || isMtrTransitOption(baseOpt)) return null;

  const routeShort = String(
    baseOpt.route_short_name || baseOpt.route_name || "",
  )
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  // Flat MTR Bus table (mtr_bus_fares.csv)
  if (isMtrBusRoute(routeShort) || isMtrBusAgency(baseOpt)) {
    const m = mtrBusFare(routeShort, fareType);
    if (m != null) return m;
  }

  const mode = String(baseOpt.mode || "").toLowerCase();
  if (mode && mode !== "bus" && mode !== "trolleybus") {
    if (
      !isBusTransitOption(baseOpt) &&
      !isMtrBusRoute(baseOpt.route_short_name)
    ) {
      return null;
    }
  }
  const seq = Array.isArray(stops) ? stops : [];
  if (seq.length < 2) return null;
  const bi = Math.max(
    0,
    Math.min(seq.length - 1, Math.round(Number(boardIndex) || 0)),
  );
  // Terminus: show full journey fare from first stop when possible, else null
  const alightI = seq.length - 1;
  const boardI = bi >= alightI ? Math.max(0, alightI - 1) : bi;

  const pts = seq.map((s, i) => ({
    stop_id: s.stopId || s.stop_id || s.id || String(i),
    id: s.stopId || s.stop_id || s.id || String(i),
    stop_name: s.name || s.stop_name || "",
    name: s.name || s.stop_name || "",
    name_en: s.nameEn || s.name_en || s.stop_name_en || "",
    name_tc: s.nameTc || s.name_tc || "",
    lon: s.lon,
    lat: s.lat,
    location: { lon: s.lon, lat: s.lat },
  }));

  const opt = {
    ...baseOpt,
    mode: baseOpt.mode || "bus",
    from: pts[boardI],
    to: pts[alightI],
    stops: pts,
    boardIndex: boardI,
    alightIndex: alightI,
    // Pass direction so O/I bound can be preferred in TD tables
    bound: baseOpt.bound || baseOpt.headsign_bound || "",
  };
  // Prefer scaled TD section (incl. index fallback) over generic bus table
  const section = tdBusSectionFare(opt);
  if (section != null) return scaleAdultFare(section, fareType);
  const generic = busOrFerryFare(opt, fareType);
  if (generic != null) return generic;
  // Absolute last resort: full fare for route without stop pairing
  const route = String(baseOpt.route_short_name || baseOpt.route_name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (route && pack?.busSection) {
    for (const key of tdBusSectionKeys(opt, route)) {
      const variants = pack.busSection[key];
      const full = variants?.find((v) => v.full != null)?.full;
      if (full != null) return scaleAdultFare(full / 10, fareType);
    }
  }
  if (route && pack?.bus?.byCoRoute) {
    for (const key of tdBusSectionKeys(opt, route)) {
      if (pack.bus.byCoRoute[key] != null) {
        return scaleAdultFare(pack.bus.byCoRoute[key], fareType);
      }
    }
  }
  return null;
}

/**
 * Display helper:
 *  - missing total / no data → "N/A"
 *  - walk-only or free → "$0.0"
 *  - partial unknown transit → "$12.5+" (known sum; missing legs are N/A in breakdown)
 */
export function formatPlanFare(fare) {
  if (!fare || fare.total == null) {
    return "N/A";
  }
  const base = `$${Number(fare.total).toFixed(1)}`;
  return fare.incomplete ? `${base}+` : base;
}

/** Format a single fare part: missing → N/A, walk/free → $0.0 */
export function formatFarePartAmount(part) {
  if (part == null || part.amount == null) return "N/A";
  return `$${Number(part.amount).toFixed(1)}`;
}
