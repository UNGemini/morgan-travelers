/**
 * User routing preferences (persisted in localStorage).
 * Multi-select: ranking goals, bus companies, traffic methods.
 */
import { t } from "./lang.js";

export const PREF_STORAGE_KEY = "morgan.routePreferences";
/** @deprecated single-value key — migrated on load */
const PREF_STORAGE_KEY_LEGACY = "morgan.routePreference";
export const BUS_COMPANY_STORAGE_KEY = "morgan.busCompanies";
export const TRAFFIC_METHOD_STORAGE_KEY = "morgan.trafficMethods";
export const SERVICE_DAY_STORAGE_KEY = "morgan.serviceDay";
/** "now" or "HH:MM" (24h local) */
export const DEPART_TIME_STORAGE_KEY = "morgan.departTime";
/** Service-worker data cache (router graph, fares, map data) */
export const DATA_CACHE_STORAGE_KEY = "morgan.dataCache";
/** Update stamp of the data edge recorded at the last offline download */
export const DATA_UPDATED_AT_STORAGE_KEY = "morgan.dataUpdatedAt";

/** @typedef {"fastest" | "simplest" | "cheapest"} RoutePreference */
/** @typedef {"kmb_lwb" | "ctb" | "nlb" | "gmb" | "mtr_bus" | "rbs"} BusCompanyId */
/** @typedef {"bus" | "gmb" | "lrt" | "mtr" | "walk" | "ael"} TrafficMethodId */
/** @typedef {"usual" | "holiday"} ServiceDayId */
/** @typedef {"now" | string} DepartTimeValue  "now" or "HH:MM" */

/** @type {RoutePreference[]} */
export const ROUTE_PREFERENCES = ["fastest", "simplest", "cheapest"];

export const PREF_LABELS = {
  fastest: "Fastest",
  simplest: "Simplest",
  cheapest: "Least fare",
};

export const PREF_HINTS = {
  fastest: "Minimise journey time",
  simplest: "Fewer transfers preferred",
  cheapest: "Lower fare preferred",
};

/** @type {{ id: BusCompanyId, label: string }[]} */
export const BUS_COMPANIES = [
  { id: "kmb_lwb", label: "KMB/LWB" },
  { id: "ctb", label: "CTB" },
  { id: "nlb", label: "NLB" },
  { id: "gmb", label: "GMB" },
  { id: "mtr_bus", label: "MTR Bus" },
  { id: "rbs", label: "RBS" },
];

/** @type {{ id: TrafficMethodId, label: string }[]} */
export const TRAFFIC_METHODS = [
  { id: "bus", label: "Bus" },
  { id: "gmb", label: "GMB" },
  { id: "lrt", label: "LRT" },
  { id: "mtr", label: "MTR" },
  { id: "walk", label: "Walk" },
  { id: "ael", label: "AEL" },
];

export const BUS_COMPANY_LABELS = Object.fromEntries(
  BUS_COMPANIES.map((c) => [c.id, c.label]),
);
export const TRAFFIC_METHOD_LABELS = Object.fromEntries(
  TRAFFIC_METHODS.map((m) => [m.id, m.label]),
);

/** @type {{ id: ServiceDayId, label: string }[]} */
export const SERVICE_DAYS = [
  { id: "usual", label: "Usual" },
  { id: "holiday", label: "Holiday" },
];

export const SERVICE_DAY_LABELS = Object.fromEntries(
  SERVICE_DAYS.map((d) => [d.id, d.label]),
);

/**
 * @param {unknown} v
 * @returns {v is RoutePreference}
 */
function isPref(v) {
  return v === "fastest" || v === "simplest" || v === "cheapest";
}

/**
 * @param {unknown} v
 * @returns {v is BusCompanyId}
 */
export function isBusCompany(v) {
  return BUS_COMPANIES.some((c) => c.id === v);
}

/**
 * @param {unknown} v
 * @returns {v is TrafficMethodId}
 */
export function isTrafficMethod(v) {
  return TRAFFIC_METHODS.some((m) => m.id === v);
}

/**
 * @param {unknown} v
 * @returns {v is ServiceDayId}
 */
export function isServiceDay(v) {
  return v === "usual" || v === "holiday";
}

/**
 * @returns {ServiceDayId}
 */
export function loadServiceDay() {
  try {
    const raw = localStorage.getItem(SERVICE_DAY_STORAGE_KEY);
    if (isServiceDay(raw)) return raw;
  } catch {
    /* ignore */
  }
  return "usual";
}

/**
 * @param {ServiceDayId} day
 * @returns {ServiceDayId}
 */
export function saveServiceDay(day) {
  const next = isServiceDay(day) ? day : "usual";
  try {
    localStorage.setItem(SERVICE_DAY_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * @param {ServiceDayId} [day]
 */
export function formatServiceDayLabel(day = "usual") {
  return t(SERVICE_DAY_LABELS[day] || SERVICE_DAY_LABELS.usual);
}

/**
 * Parse "HH:MM" or "HH:MM:SS" (some browsers) → "HH:MM", or null.
 * @param {unknown} v
 * @returns {string | null}
 */
export function parseDepartTimeHm(v) {
  if (typeof v !== "string") return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(v.trim());
  if (!m) return null;
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = String(Number(m[2])).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * @param {unknown} v
 * @returns {boolean} true for "HH:MM" or "HH:MM:SS" 24h
 */
export function isDepartTimeHm(v) {
  return parseDepartTimeHm(v) != null;
}

/**
 * @returns {DepartTimeValue}
 */
export function loadDepartTime() {
  try {
    const raw = localStorage.getItem(DEPART_TIME_STORAGE_KEY);
    if (raw === "now" || raw == null || raw === "") return "now";
    const hm = parseDepartTimeHm(raw);
    if (hm) return hm;
  } catch {
    /* ignore */
  }
  return "now";
}

/**
 * @param {DepartTimeValue} value
 * @returns {DepartTimeValue}
 */
export function saveDepartTime(value) {
  if (value === "now") {
    try {
      localStorage.setItem(DEPART_TIME_STORAGE_KEY, "now");
    } catch {
      /* ignore */
    }
    return "now";
  }
  const hm = parseDepartTimeHm(value);
  const next = hm || "now";
  try {
    localStorage.setItem(DEPART_TIME_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * @param {DepartTimeValue} [value]
 */
export function formatDepartTimeLabel(value = "now") {
  if (value === "now" || !isDepartTimeHm(value)) return "Now (UTC+8)";
  return `${value} (UTC+8)`;
}

/** Hong Kong has no DST — fixed UTC+8. */
export const HK_TZ = "Asia/Hong_Kong";

/**
 * Wall-clock parts in Hong Kong (UTC+8).
 * @param {Date} [date]
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 *   weekday: 0=Sun … 6=Sat (Hong Kong calendar)
 */
export function getHongKongParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: HK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  /** @param {Intl.DateTimeFormatPartTypes} type */
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const wd = get("weekday"); // Mon, Tue, …
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: map[wd] ?? 0,
  };
}

/**
 * Current Hong Kong clock as HH:MM.
 * @param {Date} [date]
 */
export function hongKongHmString(date = new Date()) {
  const p = getHongKongParts(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Pad number to 2 digits.
 * @param {number} n
 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Extract service-day wall clock from a wheels-router ISO string.
 * wheels-router-nano strips "Z" and treats the clock face as local service time
 * (GTFS seconds-since-midnight) — it is NOT real UTC.
 *
 * @param {string} iso
 * @returns {{ date: string, hour: number, minute: number, second: number } | null}
 */
export function parseServiceDayIso(iso) {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(iso.trim());
  if (!m) return null;
  return {
    date: m[1],
    hour: Number(m[2]),
    minute: Number(m[3]),
    second: Number(m[4] || 0),
  };
}

/**
 * Format wheels-router start_time for UI (HH:MM, Hong Kong service clock).
 * @param {string} [iso]
 * @returns {string}
 */
export function formatServiceClock(iso) {
  const p = parseServiceDayIso(iso || "");
  if (!p) return "—";
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Build RAPTOR `depart_at` for Usual (weekday) vs Holiday (Sunday),
 * with optional fixed clock time in **Hong Kong wall time**.
 *
 * IMPORTANT: wheels-router-nano does NOT interpret real time zones. It strips a
 * trailing `Z` and uses the HH:MM:SS as GTFS local seconds-since-midnight on
 * that calendar date. So we emit the HKT clock face as the ISO time portion
 * (with a decorative `Z`), NOT a true UTC conversion (which was 8h early).
 *
 * Calendar day is Hong Kong **today** (or tomorrow if the clock already
 * passed). MTR/LRT `calendar_dates` are a short rolling window from today —
 * jumping to next Monday/Sunday often has no rail trips at all.
 *
 * RAPTOR only waits 3 hours for a trip. After last train (~01:15) “Now”
 * cannot see first trains (~05:30), so we search from 05:30 instead.
 *
 * @param {ServiceDayId} day
 * @param {Date} [now]
 * @param {DepartTimeValue} [time] "now" or "HH:MM" Hong Kong local
 * @returns {string} e.g. "2026-07-29T12:00:00Z" meaning noon service time
 */
export function departAtForServiceDay(day, now = new Date(), time = "now") {
  const hk = getHongKongParts(now);
  const nowMins = (hk.hour || 0) * 60 + (hk.minute || 0);
  let hour = hk.hour;
  let minute = hk.minute;
  const hm = time === "now" ? null : parseDepartTimeHm(time);
  if (hm) {
    const [hh, mm] = hm.split(":").map((x) => Number(x));
    hour = hh;
    minute = mm;
  } else if (nowMins >= 75 && nowMins < 5 * 60 + 30) {
    // 01:15–05:29: last train gone, first train not yet in the 3h wait window
    hour = 5;
    minute = 30;
  }
  let dayOffset = 0;
  if (hm) {
    const req = hour * 60 + minute;
    if (req + 1 < nowMins) dayOffset = 1;
  }
  // Holiday on Saturday → tomorrow (Sunday). Do not jump 2–6 days ahead.
  if (day === "holiday" && hk.weekday !== 0) {
    if (hk.weekday === 6) dayOffset = Math.max(dayOffset, 1);
  }
  const shifted = new Date(
    Date.UTC(hk.year, hk.month - 1, hk.day + dayOffset, 12, 0, 0),
  );
  const y = shifted.getUTCFullYear();
  const mo = pad2(shifted.getUTCMonth() + 1);
  const da = pad2(shifted.getUTCDate());
  return `${y}-${mo}-${da}T${pad2(hour)}:${pad2(minute)}:00Z`;
}

/**
 * @returns {RoutePreference[]}
 */
export function loadRoutePreferences() {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.filter(isPref);
        if (list.length) return [...new Set(list)];
      }
    }
    const legacy = localStorage.getItem(PREF_STORAGE_KEY_LEGACY);
    if (isPref(legacy)) {
      const list = [legacy];
      saveRoutePreferences(list);
      return list;
    }
  } catch {
    /* private mode / bad JSON */
  }
  return ["fastest"];
}

/**
 * @param {RoutePreference[]} prefs
 */
export function saveRoutePreferences(prefs) {
  const list = [...new Set((prefs || []).filter(isPref))];
  const final = list.length ? list : ["fastest"];
  try {
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(final));
  } catch {
    /* ignore */
  }
  return final;
}

/**
 * @returns {BusCompanyId[]}
 */
export function loadBusCompanies() {
  try {
    const raw = localStorage.getItem(BUS_COMPANY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.filter(isBusCompany);
        if (list.length) {
          const uniq = [...new Set(list)];
          // Migration: the old four-company list was the default "all" — keep
          // MTR Bus + RBS enabled for those users instead of silently dropping
          // the newly added companies from their plans.
          const LEGACY_ALL = ["kmb_lwb", "ctb", "nlb", "gmb"];
          if (LEGACY_ALL.every((id) => uniq.includes(id))) {
            return BUS_COMPANIES.map((c) => c.id);
          }
          return uniq;
        }
      }
    }
  } catch {
    /* ignore */
  }
  // Default: all companies on
  return BUS_COMPANIES.map((c) => c.id);
}

/**
 * @param {BusCompanyId[]} list
 */
export function saveBusCompanies(list) {
  const final = [...new Set((list || []).filter(isBusCompany))];
  const out = final.length ? final : BUS_COMPANIES.map((c) => c.id);
  try {
    localStorage.setItem(BUS_COMPANY_STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @returns {TrafficMethodId[]}
 */
export function loadTrafficMethods() {
  try {
    const raw = localStorage.getItem(TRAFFIC_METHOD_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.filter(isTrafficMethod);
        if (list.length) return [...new Set(list)];
      }
    }
  } catch {
    /* ignore */
  }
  return TRAFFIC_METHODS.map((m) => m.id);
}

/**
 * @param {TrafficMethodId[]} list
 */
export function saveTrafficMethods(list) {
  const final = [...new Set((list || []).filter(isTrafficMethod))];
  const out = final.length ? final : TRAFFIC_METHODS.map((m) => m.id);
  try {
    localStorage.setItem(TRAFFIC_METHOD_STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @returns {boolean} user opted into service-worker data caching (default on)
 */
export function loadDataCachePref() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_STORAGE_KEY);
    if (raw === "1" || raw === "0") return raw === "1";
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * @param {boolean} v
 * @returns {boolean}
 */
export function saveDataCachePref(v) {
  const next = !!v;
  try {
    localStorage.setItem(DATA_CACHE_STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* ignore */
  }
  return next;
}

/** Data-source preference for transit data: cloud (live, default) or local (downloaded copy). */
export const DATA_SOURCE_STORAGE_KEY = "morgan.dataSource";

/** @typedef {"cloud" | "local"} DataSourcePref */

/**
 * @param {unknown} v
 * @returns {v is DataSourcePref}
 */
export function isDataSourcePref(v) {
  return v === "cloud" || v === "local";
}

/**
 * @returns {DataSourcePref}
 */
export function loadDataSourcePref() {
  try {
    const raw = localStorage.getItem(DATA_SOURCE_STORAGE_KEY);
    if (isDataSourcePref(raw)) return raw;
  } catch {
    /* ignore */
  }
  return "cloud";
}

/**
 * @param {DataSourcePref} v
 * @returns {DataSourcePref}
 */
export function saveDataSourcePref(v) {
  const next = isDataSourcePref(v) ? v : "cloud";
  try {
    localStorage.setItem(DATA_SOURCE_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}

/** Live bus positions Beta toggle (PRD 4.2) — default on */
export const LIVE_BUS_STORAGE_KEY = "morgan.liveBusPositions";

/**
 * @returns {boolean} user enabled live bus position markers (default on)
 */
export function loadLiveBusPref() {
  try {
    const raw = localStorage.getItem(LIVE_BUS_STORAGE_KEY);
    if (raw === "1" || raw === "0") return raw === "1";
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * @param {boolean} v
 * @returns {boolean}
 */
export function saveLiveBusPref(v) {
  const next = !!v;
  try {
    localStorage.setItem(LIVE_BUS_STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* ignore */
  }
  return next;
}

/** Fetch-more-live-data Beta option (PRD 4.2) — default off */
export const LIVE_BUS_MORE_STORAGE_KEY = "morgan.liveBusPositionsMore";

/**
 * @returns {boolean} user opted into extra ETA fetches for tighter positions
 */
export function loadLiveBusMorePref() {
  try {
    const raw = localStorage.getItem(LIVE_BUS_MORE_STORAGE_KEY);
    if (raw === "1" || raw === "0") return raw === "1";
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @param {boolean} v
 * @returns {boolean}
 */
export function saveLiveBusMorePref(v) {
  const next = !!v;
  try {
    localStorage.setItem(LIVE_BUS_MORE_STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* ignore */
  }
  return next;
}

/** Beta warning banner preference — hide the disclaimer card entirely (default on) */
export const BETA_BANNER_STORAGE_KEY = "morgan.betaBanner";

/**
 * @returns {boolean} user wants the beta banner shown while the engine runs
 */
export function loadBetaBannerPref() {
  try {
    const raw = localStorage.getItem(BETA_BANNER_STORAGE_KEY);
    if (raw === "1" || raw === "0") return raw === "1";
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * @param {boolean} v
 * @returns {boolean}
 */
export function saveBetaBannerPref(v) {
  const next = !!v;
  try {
    localStorage.setItem(BETA_BANNER_STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* ignore */
  }
  return next;
}

export const LANGUAGE_STORAGE_KEY = "morgan.language";

/**
 * Persisted UI language code (see src/lang.js LANG_META).
 * @returns {"en"|"zh-hk"|"zh-tw"|"zh-cn"|"ja"|"ko"}
 */
export function loadLanguagePref() {
  try {
    const v = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (v === "en" || v === "zh-hk" || v === "zh-tw" || v === "zh-cn" || v === "ja" || v === "ko") {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "en";
}

export function saveLanguagePref(code) {
  const v = code === "en" || code === "zh-hk" || code === "zh-tw" || code === "zh-cn" || code === "ja" || code === "ko" ? code : "en";
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
  return v;
}

/**
 * Short label for result meta, e.g. "Fastest + Simplest"
 * @param {RoutePreference[]} prefs
 */
export function formatPreferencesLabel(prefs) {
  const list = (prefs || []).filter(isPref);
  if (!list.length) return t(PREF_LABELS.fastest);
  return list.map((p) => t(PREF_LABELS[p])).join(" + ");
}

/**
 * @param {BusCompanyId[]} cos
 */
export function formatBusCompaniesLabel(cos) {
  const all = BUS_COMPANIES.map((c) => c.id);
  const list = (cos || []).filter(isBusCompany);
  if (!list.length || list.length === all.length) return t("All operators");
  return list.map((id) => t(BUS_COMPANY_LABELS[id] || id)).join(", ");
}

/**
 * @param {TrafficMethodId[]} methods
 */
export function formatTrafficMethodsLabel(methods) {
  const all = TRAFFIC_METHODS.map((m) => m.id);
  const list = (methods || []).filter(isTrafficMethod);
  if (!list.length || list.length === all.length) return t("All modes");
  return list.map((id) => t(TRAFFIC_METHOD_LABELS[id] || id)).join(", ");
}

/**
 * Classify a transit option into a bus company id (or null if not bus/GMB).
 * @param {{ agency?: { id?: string, name?: string }, mode?: string, route_short_name?: string } | null | undefined} opt
 * @returns {BusCompanyId | null}
 */
export function classifyBusCompany(opt) {
  if (!opt) return null;
  // Residents' Bus Services (NR / DB routes) — a route-level class that wins
  // over the operator: NR61/NR88 are CTB-operated but still RBS services.
  if (/^(NR|DB)\d/i.test(String(opt.route_short_name || ""))) return "rbs";
  const blob = `${opt.agency?.id || ""} ${opt.agency?.name || ""}`.toLowerCase();
  if (/gmb|green\s*mini|minibus|專線|专线/.test(blob)) return "gmb";
  if (/\bnlb\b|new\s*lanto/.test(blob)) return "nlb";
  if (/\bctb\b|citybus|nwfb|new\s*world/.test(blob)) return "ctb";
  if (/\bmtrb\b|mtr\s*bus|港鐵巴士/.test(blob)) return "mtr_bus";
  if (/\bkmb\b|lwb|long\s*win|kowloon\s*motor|lrt\s*feeder/.test(blob)) {
    return "kmb_lwb";
  }
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "bus" || mode === "trolleybus") return "kmb_lwb"; // unknown franchised → allow with bus
  return null;
}

/**
 * Classify a transit option into a traffic method.
 * @param {{ agency?: { id?: string, name?: string }, mode?: string, route_short_name?: string, route_long_name?: string, route_name?: string } | null | undefined} opt
 * @returns {TrafficMethodId | "other" | null}
 */
export function classifyTrafficMethod(opt) {
  if (!opt) return null;
  const mode = String(opt.mode || "").toLowerCase();
  const blob = `${opt.route_short_name || ""} ${opt.route_long_name || ""} ${opt.route_name || ""} ${opt.agency?.id || ""} ${opt.agency?.name || ""}`.toLowerCase();

  if (/airport\s*express|\bael\b/.test(blob)) return "ael";
  if (
    mode === "light_rail" ||
    mode === "tram" ||
    /light\s*rail|輕鐵|\blr\b/.test(blob)
  ) {
    // HK Island tramways are not LRT
    if (/tramways|電車|hk\s*tram/.test(blob) && !/light\s*rail|輕鐵/.test(blob)) {
      return "other";
    }
    return "lrt";
  }
  if (
    mode === "subway" ||
    mode === "rail" ||
    mode === "monorail" ||
    /\bmtr\b|港鐵|地鐵/.test(blob)
  ) {
    return "mtr";
  }
  if (/gmb|green\s*mini|minibus|專線/.test(blob)) return "gmb";
  if (mode === "bus" || mode === "trolleybus") return "bus";
  if (mode === "ferry") return "other";
  return "other";
}

/**
 * Build RAPTOR modes string from selected traffic methods.
 * @param {TrafficMethodId[]} methods
 * @param {string} fallback
 */
export function routerModesFromTrafficMethods(methods, fallback) {
  const set = new Set((methods || []).filter(isTrafficMethod));
  if (!set.size) return fallback;
  /** @type {string[]} */
  const parts = [];
  if (set.has("mtr") || set.has("ael")) {
    parts.push("subway", "rail", "monorail");
  }
  if (set.has("lrt")) {
    parts.push("tram", "light_rail", "cable_tram", "funicular");
  }
  if (set.has("bus") || set.has("gmb")) {
    parts.push("bus", "trolleybus");
  }
  // Ferry always available for island connectivity (not in UI list as filter-out)
  parts.push("ferry");
  return parts.length ? [...new Set(parts)].join(",") : fallback;
}

/** @deprecated use loadRoutePreferences */
export function loadRoutePreference() {
  return loadRoutePreferences()[0] || "fastest";
}

/** @deprecated use saveRoutePreferences */
export function saveRoutePreference(pref) {
  if (isPref(pref)) saveRoutePreferences([pref]);
}
