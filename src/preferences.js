/**
 * User routing preferences (persisted in localStorage).
 * Multi-select: ranking goals, bus companies, traffic methods.
 */

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
/** @typedef {"kmb_lwb" | "ctb" | "nlb" | "gmb"} BusCompanyId */
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
  return SERVICE_DAY_LABELS[day] || SERVICE_DAY_LABELS.usual;
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
 * @param {ServiceDayId} day
 * @param {Date} [now]
 * @param {DepartTimeValue} [time] "now" or "HH:MM" Hong Kong local
 * @returns {string} e.g. "2026-07-29T12:00:00Z" meaning noon service time
 */
export function departAtForServiceDay(day, now = new Date(), time = "now") {
  const hk = getHongKongParts(now);
  let hour = hk.hour;
  let minute = hk.minute;
  const hm = time === "now" ? null : parseDepartTimeHm(time);
  if (hm) {
    const [hh, mm] = hm.split(":").map((x) => Number(x));
    hour = hh;
    minute = mm;
  }
  // 0 = Sunday (holiday-like), 3 = Wednesday (typical weekday)
  const targetDow = day === "holiday" ? 0 : 3;
  const delta = targetDow - hk.weekday;
  // Shift calendar day in civil arithmetic (Date.UTC handles month roll)
  const shifted = new Date(Date.UTC(hk.year, hk.month - 1, hk.day + delta, 12, 0, 0));
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
        if (list.length) return [...new Set(list)];
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

/**
 * Short label for result meta, e.g. "Fastest + Simplest"
 * @param {RoutePreference[]} prefs
 */
export function formatPreferencesLabel(prefs) {
  const list = (prefs || []).filter(isPref);
  if (!list.length) return PREF_LABELS.fastest;
  return list.map((p) => PREF_LABELS[p]).join(" + ");
}

/**
 * @param {BusCompanyId[]} cos
 */
export function formatBusCompaniesLabel(cos) {
  const all = BUS_COMPANIES.map((c) => c.id);
  const list = (cos || []).filter(isBusCompany);
  if (!list.length || list.length === all.length) return "All operators";
  return list.map((id) => BUS_COMPANY_LABELS[id] || id).join(", ");
}

/**
 * @param {TrafficMethodId[]} methods
 */
export function formatTrafficMethodsLabel(methods) {
  const all = TRAFFIC_METHODS.map((m) => m.id);
  const list = (methods || []).filter(isTrafficMethod);
  if (!list.length || list.length === all.length) return "All modes";
  return list.map((id) => TRAFFIC_METHOD_LABELS[id] || id).join(", ");
}

/**
 * Classify a transit option into a bus company id (or null if not bus/GMB).
 * @param {{ agency?: { id?: string, name?: string }, mode?: string } | null | undefined} opt
 * @returns {BusCompanyId | null}
 */
export function classifyBusCompany(opt) {
  if (!opt) return null;
  const blob = `${opt.agency?.id || ""} ${opt.agency?.name || ""}`.toLowerCase();
  if (/gmb|green\s*mini|minibus|專線|专线/.test(blob)) return "gmb";
  if (/\bnlb\b|new\s*lanto/.test(blob)) return "nlb";
  if (/\bctb\b|citybus|nwfb|new\s*world/.test(blob)) return "ctb";
  if (
    /\bkmb\b|lwb|long\s*win|kowloon\s*motor|lrt\s*feeder|mtr\s*bus|港鐵巴士/.test(
      blob,
    )
  ) {
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
