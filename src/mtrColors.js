/**
 * Official MTR line brand colours (frontend override).
 *
 * HK GTFS often sets every MTR route_color to a generic #003DA5.
 * Prefer these brand hex values only for real MTR rail lines —
 * never for buses that merely serve a district of the same name
 * (e.g. NLB/KMB routes through Tung Chung must not become TCL orange).
 *
 * Sources: MTR line branding (public maps / Wikipedia station tables).
 */

/** @type {Record<string, string>} short code → #RRGGBB */
export const MTR_LINE_COLORS = {
  // Heavy rail — brand colours
  AEL: "#00888A", // Airport Express — teal
  TCL: "#F7943E", // Tung Chung Line — orange
  TWL: "#E2231A", // Tsuen Wan Line — red
  ISL: "#007DC5", // Island Line — blue
  KTL: "#00A040", // Kwun Tong Line — green
  TKL: "#7D499D", // Tseung Kwan O Line — purple
  EAL: "#5EB6E4", // East Rail Line — light blue
  // Tuen Ma Line is brown (not legacy West Rail purple)
  TML: "#923011", // Tuen Ma Line — brown
  MOL: "#9A338E", // legacy Ma On Shan Line — rose brown (now TML)
  WRL: "#B33D98", // legacy West Rail Line — purple (now TML)
  SIL: "#B5BD00", // South Island Line — lime
  DRL: "#F550A6", // Disneyland Resort Line — pink
  LRT: "#D3A809", // Light Rail — amber/gold
};

/**
 * Long-name patterns — require "Line" / "Express" / "Rail" so bus routes
 * like "Tsuen Wan Station - Yuen Long" do not match TWL.
 */
const LONG_NAME_HINTS = [
  [/airport\s*express/i, "AEL"],
  [/tung\s*chung\s*line/i, "TCL"],
  [/tsuen\s*wan\s*line/i, "TWL"],
  [/island\s*line/i, "ISL"],
  [/kwun\s*tong\s*line/i, "KTL"],
  [/tseung\s*kwan\s*o\s*line/i, "TKL"],
  [/east\s*rail(\s*line)?/i, "EAL"],
  [/tuen\s*ma\s*line/i, "TML"],
  [/ma\s*on\s*shan\s*line/i, "MOL"],
  [/west\s*rail(\s*line)?/i, "WRL"],
  [/south\s*island\s*line/i, "SIL"],
  [/disneyland\s*(resort\s*)?line/i, "DRL"],
  [/light\s*rail/i, "LRT"],
];

const RAIL_MODES = new Set([
  "subway",
  "rail",
  "tram",
  "light_rail",
  "cable_tram",
  "funicular",
  "monorail",
]);

/**
 * @param {{ route_short_name?: string, route_name?: string, route_long_name?: string, route_id?: string, color?: string, mode?: string, agency?: { id?: string, name?: string } }} opt
 * @returns {string | null} #rrggbb or null
 */
export function resolveRouteColor(opt) {
  if (!opt) return null;

  // Buses / non-rail: always trust GTFS (NLB orange, KMB red, etc.)
  if (!isMtrRailCandidate(opt)) {
    return normalizeHex(opt.color);
  }

  const code = detectMtrLineCode(opt);
  if (code && MTR_LINE_COLORS[code]) {
    // Prefer TML brand brown over legacy WRL/MOL codes when the long name says Tuen Ma
    if (
      (code === "WRL" || code === "MOL") &&
      /tuen\s*ma/i.test(String(opt.route_long_name || opt.route_name || ""))
    ) {
      return MTR_LINE_COLORS.TML;
    }
    return MTR_LINE_COLORS[code];
  }

  // Known generic MTR GTFS blue → still try long-name map once more is rail
  const gtfs = normalizeHex(opt.color);
  if (gtfs && gtfs.toUpperCase() === "#003DA5") {
    const fromLong = detectMtrLineCodeFromLongName(opt);
    if (fromLong && MTR_LINE_COLORS[fromLong]) {
      return MTR_LINE_COLORS[fromLong];
    }
  }

  return gtfs;
}

/**
 * Only treat as MTR rail when mode/agency/name clearly indicate a line —
 * not every bus that stops at "Tung Chung" or "Tsuen Wan".
 */
function isMtrRailCandidate(opt) {
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "bus" || mode === "ferry" || mode === "trolleybus") {
    return false;
  }
  if (RAIL_MODES.has(mode)) return true;
  if (isLightRailOption(opt)) return true;

  const agency = String(opt.agency?.name || opt.agency?.id || "").toLowerCase();
  if (agency === "lr" || /light\s*rail/.test(agency)) return true;
  if (/\bmtr\b/.test(agency) && /rail|subway|train|light/.test(agency + mode)) {
    return true;
  }

  const short = String(opt.route_short_name || "").trim().toUpperCase();
  // Exact line codes (TCL, TML, …) — only when not a pure bus mode
  if (MTR_LINE_COLORS[short] && mode !== "bus") {
    // If mode is missing, require long name to look like a line
    if (!mode) {
      return /\bline\b|express|rail/i.test(
        String(opt.route_long_name || opt.route_name || ""),
      );
    }
    return true;
  }

  return /\bline\b/i.test(String(opt.route_long_name || "")) && /\bmtr\b/i.test(agency);
}

/**
 * @param {{ route_short_name?: string, route_name?: string, route_long_name?: string, route_id?: string, mode?: string, agency?: { id?: string, name?: string } }} opt
 * @returns {string | null} e.g. "TCL"
 */
/**
 * HK MTR Light Rail (not Hong Kong Island tramways).
 * GTFS usually tags LRT as mode=tram with agency id "LR".
 */
export function isLightRailOption(opt) {
  if (!opt) return false;
  const agency = String(opt.agency?.id || opt.agency?.name || "").toLowerCase();
  if (agency === "lr" || /light\s*rail|輕鐵/.test(agency)) return true;
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "light_rail") return true;
  // Mode tram + MTR Light Rail naming (exclude HK Tramways / 電車)
  if (mode === "tram" || mode === "cable_tram") {
    const blob = `${opt.route_long_name || ""} ${opt.route_name || ""} ${opt.route_id || ""}`;
    if (/light\s*rail|輕鐵|\blr\b/i.test(blob)) return true;
    if (/tramways|香港電車|hk\s*tram/i.test(blob)) return false;
    // Numeric LRT route codes (505–761P family) with non-tramways agency
    const short = String(opt.route_short_name || "").trim().toUpperCase();
    if (/^(505|507|610|614|614P|615|615P|705|706|751|751P|761P)$/i.test(short)) {
      return true;
    }
  }
  return false;
}

export function detectMtrLineCode(opt) {
  if (!opt || !isMtrRailCandidate(opt)) return null;

  // Light Rail before short-name numeric codes (610 ≠ a heavy-rail code)
  if (isLightRailOption(opt)) return "LRT";

  const short = String(opt.route_short_name || "")
    .trim()
    .toUpperCase();
  if (short && MTR_LINE_COLORS[short]) {
    // TML supersedes legacy short codes when long name is Tuen Ma
    if (
      (short === "WRL" || short === "MOL") &&
      /tuen\s*ma/i.test(String(opt.route_long_name || ""))
    ) {
      return "TML";
    }
    return short;
  }

  // "MTR TCL" / "TCL-1"
  const shortToken = short.replace(/^MTR[\s-]*/, "").split(/[\s/_-]/)[0];
  if (shortToken && MTR_LINE_COLORS[shortToken]) return shortToken;

  const fromLong = detectMtrLineCodeFromLongName(opt);
  if (fromLong) return fromLong;

  // route_id often contains the code, e.g. "MTR_TCL" — only with rail context
  const id = String(opt.route_id || "").toUpperCase();
  for (const code of Object.keys(MTR_LINE_COLORS)) {
    if (
      id === code ||
      id === `MTR_${code}` ||
      id === `MTR-${code}` ||
      id.endsWith(`_${code}`) ||
      id.endsWith(`-${code}`)
    ) {
      return code === "WRL" || code === "MOL"
        ? /tuen\s*ma/i.test(String(opt.route_long_name || id))
          ? "TML"
          : code
        : code;
    }
  }

  return null;
}

function detectMtrLineCodeFromLongName(opt) {
  const blob = [opt.route_long_name, opt.route_name].filter(Boolean).join(" ");
  if (!blob) return null;

  // Prefer Tuen Ma before West Rail / Ma On Shan fragments
  if (/tuen\s*ma\s*line/i.test(blob)) return "TML";

  for (const [re, code] of LONG_NAME_HINTS) {
    if (re.test(blob)) {
      if (code === "WRL" || code === "MOL") {
        // If somehow both match, Tuen Ma already returned above
        return code;
      }
      return code;
    }
  }
  return null;
}

function normalizeHex(color) {
  if (!color) return null;
  const c = String(color).replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
  return `#${c.toUpperCase()}`;
}
