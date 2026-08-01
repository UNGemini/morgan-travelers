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
  return /^(K\d+[A-Z]?|506)$/.test(c);
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
    .replace(/[()[\],./]/g, " ")
    .replace(/\b(BUS\s*)?(TERMINUS|TERM|STATION|STN|STOP|BT)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
 * Best 0-based index of plan stop in TD ordered stop list.
 * @param {string[]} tdStops
 * @param {{ stop_name?: string, name?: string } | null | undefined} planStop
 */
function matchTdStopIndex(tdStops, planStop) {
  const name = planStop?.stop_name || planStop?.name || "";
  if (!name || !tdStops?.length) return null;
  let best = null;
  let bestScore = 0;
  for (let i = 0; i < tdStops.length; i++) {
    const sc = busStopMatchScore(tdStops[i], name);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  }
  return bestScore >= 200 ? best : null;
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
 * TD section fare (HKD) for a bus leg using FARE_BUS.mdb pack.
 * Matches company|route, board/alight stop names → ON_SEQ/OFF_SEQ → PRICE.
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

  const cos = agencyCompanies(opt);
  const keys = [];
  for (const co of cos) keys.push(`${co}|${route}`);
  // Also try common co keys if agency unknown
  if (!cos.length) {
    for (const co of ["kmb", "ctb", "nlb", "lrtfeeder", "gmb"]) {
      keys.push(`${co}|${route}`);
    }
  }

  const planStops =
    opt.stops?.length >= 2
      ? opt.stops
      : [opt.from, opt.to].filter(Boolean);

  let bestPrice = null;
  let bestScore = -1;

  for (const key of keys) {
    const variants = pack.busSection[key];
    if (!variants?.length) continue;
    for (const variant of variants) {
      const bounds = variant.b || {};
      for (const bound of Object.values(bounds)) {
        const stops = bound.s || bound.stops || [];
        const tri = bound.t || bound.tri || [];
        if (stops.length < 2 || !tri.length) continue;

        const board = planStops[0];
        const alight = planStops[planStops.length - 1];
        const on = matchTdStopIndex(stops, board);
        const off = matchTdStopIndex(stops, alight);
        if (on == null || off == null) continue;
        if (off === on) {
          // same stop index — treat as free / zero hop
          continue;
        }
        // Direction: if off < on, try reverse interpretation (wrong bound)
        let i = on;
        let j = off;
        if (j < i) {
          // This bound may be the opposite direction
          continue;
        }
        const n = stops.length;
        const idx = triFareIndex(i, j, n);
        const cents = tri[idx];
        if (cents == null || cents < 0) continue;

        const sc =
          busStopMatchScore(stops[i], board?.stop_name || board?.name) +
          busStopMatchScore(stops[j], alight?.stop_name || alight?.name);
        if (sc > bestScore) {
          bestScore = sc;
          bestPrice = cents / 10;
        }
      }
    }
  }

  if (bestPrice != null) return bestPrice;

  // Full fare from TD variant when stops couldn't be matched
  for (const key of keys) {
    const variants = pack.busSection[key];
    if (!variants?.length) continue;
    // Prefer regular (mode R) full fare
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
 * Official MTR Octopus interchange discounts (GMB $0.5 network-wide + designated
 * higher savings). Source: MTR “Interchange discount for Green Minibus / other PT”.
 *
 * Modelled: same itinerary has MTR heavy rail + eligible bus/ferry.
 * Not modelled: 1.5h timer, other rides voiding discount, Early Bird, Monthly Pass,
 * Fare Saver stack, positive Octopus balance.
 *
 * @typedef {{
 *   cos: string[],
 *   routes: string[],
 *   stations: RegExp[] | null,
 *   adult: number,
 *   other: number | null,
 *   student?: number | null,
 *   adultOnly?: boolean,
 *   fareBands?: { minAdultFare: number, adult: number }[],
 * }} MtrIxRule
 */

/** @type {MtrIxRule[]} */
const MTR_INTERCHANGE_RULES = [
  // ── Designated higher discounts (checked before default GMB $0.5) ──
  {
    cos: ["gmb"],
    routes: ["52"],
    stations: [/ocean\s*park|海洋公園/i],
    adult: 0.5,
    other: 0.5,
    fareBands: [
      { minAdultFare: 8.1, adult: 1.0 },
      { minAdultFare: 0, adult: 0.5 },
    ],
  },
  {
    cos: ["gmb"],
    routes: ["4M", "5M"],
    stations: [/wong\s*chuk\s*hang|黃竹坑/i],
    adult: 0.7,
    other: 0.5,
  },
  {
    cos: ["gmb"],
    routes: ["8M"],
    stations: [/ho\s*man\s*tin|何文田/i],
    adult: 1.0,
    other: 0.5,
  },
  {
    cos: ["gmb"],
    routes: ["78", "78A"],
    stations: [/kam\s*sheung\s*road|錦上路/i],
    adult: 2.5,
    other: 1.5,
    student: 2.5,
  },
  {
    cos: ["gmb"],
    routes: ["508"],
    stations: [/sheung\s*shui|上水/i],
    adult: 0.6,
    other: 0.5,
  },
  // Citybus — Adult Octopus only
  {
    cos: ["ctb"],
    routes: ["1M"],
    stations: [/exhibition\s*centre|會展/i],
    adult: 2.0,
    other: null,
    adultOnly: true,
  },
  {
    cos: ["ctb"],
    routes: ["22", "22M"],
    stations: [/kai\s*tak|sung\s*wong\s*toi|啟德|宋皇臺/i],
    adult: 0.6,
    other: null,
    adultOnly: true,
  },
  {
    cos: ["ctb"],
    routes: ["581"],
    stations: [/ma\s*on\s*shan|wu\s*kai\s*sha|馬鞍山|烏溪沙/i],
    adult: 0.6,
    other: null,
    adultOnly: true,
  },
  {
    cos: ["ctb"],
    routes: ["56", "56A"],
    stations: [/sheung\s*shui|上水/i],
    adult: 1.0,
    other: null,
    adultOnly: true,
  },
  {
    cos: ["ctb"],
    routes: ["792M"],
    stations: [/tiu\s*keng\s*leng|tseung\s*kwan\s*o|調景嶺|將軍澳/i],
    adult: 1.0,
    other: null,
    student: 0.5,
    adultOnly: true,
  },
  // KMB
  {
    cos: ["kmb"],
    routes: ["19"],
    stations: [/diamond\s*hill|鑽石山/i],
    adult: 1.0,
    other: null,
    adultOnly: true,
  },
  {
    cos: ["kmb"],
    routes: ["72K"],
    stations: [/tai\s*wo|太和/i],
    adult: 1.0,
    other: null,
    adultOnly: true,
  },
  // NLB Tung Chung
  {
    cos: ["nlb"],
    routes: ["37", "37P", "37H", "37M", "38", "38X", "N38"],
    stations: [/tung\s*chung|東涌/i],
    adult: 1.0,
    other: null,
    adultOnly: true,
  },
  {
    cos: ["nlb"],
    routes: ["37A", "39M", "N37"],
    stations: [/tung\s*chung|東涌/i],
    adult: 1.0,
    other: null,
    adultOnly: true,
  },
  // Kaito — Lei Tung / Aberdeen–Ap Lei Chau
  {
    cos: ["hkkf", "fortuneferry", "sunferry"],
    routes: ["*"],
    stations: [/lei\s*tung|利東/i],
    adult: 0.5,
    other: null,
    adultOnly: true,
  },
  // Default: most GMB routes · $0.5 · any MTR except LRT / AEL
  {
    cos: ["gmb"],
    routes: ["*"],
    stations: null,
    adult: 0.5,
    other: 0.5,
  },
];

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
  if (!octopusSupportsGmbInterchange(type) && !isAdultOctopusFamily(type)) {
    return;
  }
  const mtrStations = domesticMtrStationNames(legs);
  if (!mtrStations.length) return;

  // T&C: not eligible right after AEL free MTR connection
  const mtrParts = parts.filter((p) => p.kind === "mtr");
  const aelParts = parts.filter((p) => p.kind === "ael");
  if (
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
    for (const rule of MTR_INTERCHANGE_RULES) {
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

  // MTR↔GMB $0.5+ / designated CTB·KMB·NLB·ferry Octopus interchange discounts
  // (after free AEL so those journeys are excluded per T&C)
  applyMtrInterchangeDiscounts(parts, legs, type);

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
