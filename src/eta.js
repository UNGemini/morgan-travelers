/**
 * Live ETA from Hong Kong open data (KMB/LWB, Citybus, NLB, MTR, LRT).
 * Fetched via same-origin /eta proxy (COEP require-corp safe).
 */

import { LRT_STOPS } from "./lrtStops.js";
import { isLightRailOption, detectMtrLineCode } from "./mtrColors.js";
import {
  formatServiceClock,
  parseServiceDayIso,
  getHongKongParts,
} from "./preferences.js";

/** Same-origin proxy prefix */
const ETA_BASE = "/eta";

/** @type {Map<string, { t: number, data: any }>} */
const cache = new Map();
const CACHE_MS = 25_000;

/** @type {Promise<Map<string, string>> | null} */
let nlbRouteMapPromise = null;

/**
 * @param {string} url
 * @param {{ ttlMs?: number }} [opts]
 */
async function fetchJson(url, opts = {}) {
  const ttl = opts.ttlMs ?? CACHE_MS;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ETA ${res.status} ${url}`);
  const data = await res.json();
  cache.set(url, { t: Date.now(), data });
  return data;
}

/**
 * @param {string | null | undefined} raw
 */
export function stripOperatorStopId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // KMB-HEX, CTB-001859, NLB-6, GMB-…, MTR-PLATFORM-TUC-1
  const m = /^(?:KMB|CTB|NLB|GMB|LWB|NWFB|MTRBUS|LRTFEEDER)-(.+)$/i.exec(s);
  if (m) return m[1];
  return s;
}

/**
 * @param {object} [opt]
 * @returns {"kmb"|"ctb"|"nlb"|"mtr"|"lrt"|"unknown"}
 */
export function etaOperator(opt) {
  if (!opt) return "unknown";
  if (isLightRailOption(opt)) return "lrt";
  const agency = `${opt.agency?.id || ""} ${opt.agency?.name || ""}`.toLowerCase();
  const routeId = String(opt.route_id || "");
  const mode = String(opt.mode || "").toLowerCase();
  if (
    mode === "subway" ||
    mode === "rail" ||
    mode === "monorail" ||
    /^MTR-/i.test(routeId) ||
    /\bmtr\s*rail\b|\bairport\s*express\b/.test(agency)
  ) {
    if (/lrt\s*feeder|mtr\s*bus|港鐵巴士/.test(agency)) return "kmb";
    return "mtr";
  }
  if (/\bnlb\b|new\s*lanto/.test(agency) || /^NLB-/i.test(routeId)) return "nlb";
  if (/\bctb\b|citybus|nwfb|new\s*world/.test(agency) || /^CTB-/i.test(routeId))
    return "ctb";
  if (
    /\bkmb\b|lwb|long\s*win|kowloon\s*motor|lrt\s*feeder|mtr\s*bus/.test(agency) ||
    /^KMB-/i.test(routeId) ||
    /^LWB-/i.test(routeId)
  ) {
    return "kmb";
  }
  if (mode === "bus" || mode === "trolleybus") return "kmb";
  return "unknown";
}

/**
 * @param {object} stop
 */
function stopIdOf(stop) {
  if (!stop) return "";
  return String(stop.stop_id || stop.id || "").trim();
}

/**
 * @param {object} [opt]
 */
function routeShort(opt) {
  return String(opt?.route_short_name || opt?.route_name || "")
    .trim()
    .toUpperCase();
}

/**
 * KMB direction + service type from trip_id like KMB-E31-I-1-287
 * @param {object} [opt]
 * @returns {{ dir: string | null, serviceType: number }}
 */
function kmbTripMeta(opt) {
  const trip = String(opt?.trip_id || "");
  const m = /-(I|O)-(\d+)(?:-|$)/i.exec(trip);
  if (m) {
    return { dir: m[1].toUpperCase(), serviceType: Number(m[2]) || 1 };
  }
  // route_id sometimes encodes bound
  const rid = String(opt?.route_id || "");
  if (/-I(?:-|$)/i.test(rid) || /inbound/i.test(trip)) return { dir: "I", serviceType: 1 };
  if (/-O(?:-|$)/i.test(rid) || /outbound/i.test(trip)) return { dir: "O", serviceType: 1 };
  return { dir: null, serviceType: 1 };
}

/**
 * @param {string | null | undefined} iso
 * @param {number} [nowMs]
 * @returns {number | null} minutes until eta (floor), 0 if due/arrived
 */
export function waitMinutesFromIso(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((t - nowMs) / 60_000);
  return mins < 0 ? 0 : mins;
}

/**
 * Normalize ISO-ish timestamps from various APIs to ISO with offset.
 * @param {string} raw
 */
function normalizeEtaIso(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // Already ISO with offset
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  // "2026-07-31 18:09:05" → treat as HKT
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(s);
  if (m) {
    const sec = m[2].length === 5 ? `${m[2]}:00` : m[2];
    return `${m[1]}T${sec}+08:00`;
  }
  return s;
}

/**
 * @typedef {{
 *   waitMins: number | null,
 *   etaIso?: string | null,
 *   dest?: string,
 *   remark?: string,
 *   platform?: string | null,
 *   scheduled?: boolean,
 *   clock?: string,
 * }} EtaSlot
 * @typedef {{
 *   operator: string,
 *   route: string,
 *   stopId: string,
 *   etas: EtaSlot[],
 *   waitMins: number | null,
 *   etaIso: string | null,
 *   error?: string | null,
 *   unsupported?: boolean,
 *   servingPlatforms?: string[],
 *   multiPlatform?: boolean,
 *   fetchedAt?: number,
 *   scheduled?: boolean,
 * }} LegEtaResult
 */

/**
 * Wait minutes from a RAPTOR/GTFS service-day ISO clock vs Hong Kong "now".
 * @param {string | null | undefined} serviceIso
 * @param {Date} [now]
 * @returns {number | null}
 */
export function waitMinsFromServiceClock(serviceIso, now = new Date()) {
  const p = parseServiceDayIso(serviceIso || "");
  if (!p) return null;
  const hk = getHongKongParts(now);
  const scheduled = p.hour * 60 + p.minute + (p.second || 0) / 60;
  const current = hk.hour * 60 + hk.minute + (hk.second || 0) / 60;
  let diff = scheduled - current;
  // Overnight / next service day
  if (diff < -6 * 60) diff += 24 * 60;
  if (diff < 0) return 0;
  return Math.round(diff);
}

/**
 * Build a single scheduled departure slot from a transit route option (timetable).
 * @param {object} [opt]
 * @param {object} [plan]
 * @param {number} [legIdx]
 * @param {Date} [now]
 * @returns {EtaSlot | null}
 */
export function scheduledSlotFromPlanLeg(opt, plan = null, legIdx = 0, now = new Date()) {
  let iso = opt?.start_time || null;
  if (!iso && plan?.start_time) {
    // Accumulate prior leg durations onto plan depart (service clock arithmetic)
    let addSec = 0;
    const legs = plan.legs || [];
    for (let i = 0; i < legIdx && i < legs.length; i++) {
      addSec += legDurationSeconds(legs[i]);
    }
    const p = parseServiceDayIso(plan.start_time);
    if (p) {
      let total = p.hour * 3600 + p.minute * 60 + p.second + addSec;
      // Wrap within day for display
      total = ((total % 86400) + 86400) % 86400;
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = Math.floor(total % 60);
      const pad = (n) => String(n).padStart(2, "0");
      iso = `${p.date}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`;
    }
  }
  if (!iso) return null;
  const clock = formatServiceClock(iso);
  if (!clock || clock === "—") return null;
  const waitMins = waitMinsFromServiceClock(iso, now);
  const dest =
    opt?.headsign ||
    opt?.to?.stop_name ||
    (opt?.stops?.length
      ? opt.stops[opt.stops.length - 1]?.stop_name
      : "") ||
    "";
  return {
    waitMins,
    etaIso: null,
    clock,
    dest: String(dest || "").trim(),
    scheduled: true,
    platform: null,
  };
}

/**
 * Normalize platform token to short id ("1", "2", "A").
 * @param {unknown} raw
 * @returns {string}
 */
export function platformToken(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/^platform\s+/i, "").trim();
  return s;
}

/**
 * Sorted unique short platform ids from slots / list.
 * @param {Array<{ platform?: string | null, plat?: string | null } | string>} items
 * @returns {string[]}
 */
export function collectServingPlatforms(items) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const it of items || []) {
    const tok =
      typeof it === "string"
        ? platformToken(it)
        : platformToken(it?.platform ?? it?.plat);
    if (tok) set.add(tok);
  }
  return [...set].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

/**
 * Strip trailing platform suffixes from a stop label.
 * @param {string} label
 */
export function stationBaseName(label) {
  return String(label || "")
    .replace(/\s*[-–—]\s*Platform\s+[\dA-Za-z/,]+$/i, "")
    .replace(/\s*\(\s*Platform\s*[^)]*\)/gi, "")
    .replace(/\s*月台\s*[\dA-Za-z/,]+/g, "")
    .trim();
}

/**
 * "Tung Chung - Platform 1/2" when multiple platforms serve the destination.
 * @param {string} label current or base name
 * @param {string[] | null | undefined} platforms short ids e.g. ["1","2"]
 */
export function stationNameWithPlatforms(label, platforms) {
  const base = stationBaseName(label) || String(label || "").trim();
  const plats = collectServingPlatforms(platforms || []);
  if (!base) {
    return plats.length ? `Platform ${plats.join("/")}` : "";
  }
  if (!plats.length) return base;
  return `${base} - Platform ${plats.join("/")}`;
}

/**
 * Platform label from stop / API fields.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function formatPlatformLabel(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^platform\s+/i.test(s)) return s.replace(/^platform\s+/i, "Platform ");
  // Numeric / letter bay
  if (/^[A-Za-z0-9]{1,4}$/.test(s)) return `Platform ${s}`;
  return s;
}

/**
 * Platform from board stop object (MTR platform field / name).
 * @param {object} [stop]
 */
function platformFromStop(stop) {
  if (!stop) return null;
  if (stop.platform != null && String(stop.platform).trim()) {
    return formatPlatformLabel(stop.platform);
  }
  const name = String(stop.stop_name || stop.name || stop.address || "");
  const m = /\((?:Platform|P|月台)\s*([A-Za-z0-9]+)\)/i.exec(name);
  if (m) return formatPlatformLabel(m[1]);
  return null;
}

/**
 * @param {EtaSlot[]} slots
 * @returns {LegEtaResult} partial
 */
function packSlots(base, slots) {
  const sorted = [...slots].sort(
    (a, b) => Date.parse(a.etaIso) - Date.parse(b.etaIso),
  );
  const first = sorted[0] || null;
  const servingPlatforms =
    base.servingPlatforms?.length
      ? collectServingPlatforms(base.servingPlatforms)
      : collectServingPlatforms(sorted);
  return {
    ...base,
    etas: sorted.slice(0, 3),
    waitMins: first ? first.waitMins : null,
    etaIso: first ? first.etaIso : null,
    servingPlatforms,
    multiPlatform:
      base.multiPlatform != null
        ? base.multiPlatform
        : servingPlatforms.length > 1,
    fetchedAt: base.fetchedAt ?? Date.now(),
    error: null,
  };
}

/** @param {object} opt @param {object} board */
async function fetchKmbEta(opt, board) {
  const stopRaw = stopIdOf(board);
  const stopId = stripOperatorStopId(stopRaw);
  const route = routeShort(opt);
  const { dir, serviceType } = kmbTripMeta(opt);
  if (!stopId || !route) {
    return {
      operator: "kmb",
      route,
      stopId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: "missing stop/route",
    };
  }
  // Prefer route-specific ETA; fall back to stop-eta filtered by route
  let rows = [];
  try {
    const url = `${ETA_BASE}/kmb/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}/${serviceType}`;
    const data = await fetchJson(url);
    rows = Array.isArray(data?.data) ? data.data : [];
  } catch {
    rows = [];
  }
  if (!rows.length) {
    try {
      const data = await fetchJson(
        `${ETA_BASE}/kmb/stop-eta/${encodeURIComponent(stopId)}`,
      );
      rows = (Array.isArray(data?.data) ? data.data : []).filter(
        (r) => String(r.route || "").toUpperCase() === route,
      );
    } catch (e) {
      return {
        operator: "kmb",
        route,
        stopId,
        etas: [],
        waitMins: null,
        etaIso: null,
        error: e instanceof Error ? e.message : "KMB fetch failed",
      };
    }
  }
  if (dir) {
    const filtered = rows.filter((r) => String(r.dir || "").toUpperCase() === dir);
    if (filtered.length) rows = filtered;
  }
  const now = Date.now();
  const plat = platformFromStop(board);
  const slots = [];
  for (const r of rows) {
    const iso = normalizeEtaIso(r.eta);
    if (!iso) continue;
    const waitMins = waitMinutesFromIso(iso, now);
    if (waitMins == null) continue;
    slots.push({
      waitMins,
      etaIso: iso,
      dest: r.dest_en || r.dest_tc || "",
      remark: r.rmk_en || r.rmk_tc || "",
      platform: formatPlatformLabel(r.plat || r.platform) || plat,
    });
  }
  return packSlots({ operator: "kmb", route, stopId }, slots);
}

/** @param {object} opt @param {object} board */
async function fetchCtbEta(opt, board) {
  const stopId = stripOperatorStopId(stopIdOf(board));
  const route = routeShort(opt);
  if (!stopId || !route) {
    return {
      operator: "ctb",
      route,
      stopId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: "missing stop/route",
    };
  }
  // Try padded and unpadded stop ids
  const candidates = [stopId];
  if (/^\d+$/.test(stopId)) {
    candidates.push(stopId.padStart(6, "0"));
    candidates.push(String(Number(stopId)));
  }
  let rows = [];
  let usedStop = stopId;
  for (const sid of [...new Set(candidates)]) {
    try {
      const data = await fetchJson(
        `${ETA_BASE}/ctb/eta/CTB/${encodeURIComponent(sid)}/${encodeURIComponent(route)}`,
      );
      const list = Array.isArray(data?.data) ? data.data : [];
      if (list.length) {
        rows = list;
        usedStop = sid;
        break;
      }
    } catch {
      /* try next */
    }
  }
  const now = Date.now();
  const plat = platformFromStop(board);
  const slots = [];
  for (const r of rows) {
    const iso = normalizeEtaIso(r.eta);
    if (!iso) continue;
    const waitMins = waitMinutesFromIso(iso, now);
    if (waitMins == null) continue;
    slots.push({
      waitMins,
      etaIso: iso,
      dest: r.dest_en || r.dest_tc || "",
      remark: r.rmk_en || r.rmk_tc || "",
      platform: formatPlatformLabel(r.plat || r.platform) || plat,
    });
  }
  return packSlots({ operator: "ctb", route, stopId: usedStop }, slots);
}

/**
 * NLB routeNo → variants (each direction is its own routeId).
 * @returns {Promise<Map<string, Array<{ routeId: string, nameE: string, nameC: string }>>>}
 */
async function nlbRouteVariantsMap() {
  if (!nlbRouteMapPromise) {
    nlbRouteMapPromise = (async () => {
      /** @type {Map<string, Array<{ routeId: string, nameE: string, nameC: string }>>} */
      const map = new Map();
      try {
        const data = await fetchJson(
          `${ETA_BASE}/nlb/route.php?action=list`,
          { ttlMs: 6 * 60 * 60_000 },
        );
        const list = Array.isArray(data?.routes)
          ? data.routes
          : Array.isArray(data)
            ? data
            : [];
        for (const r of list) {
          const no = String(r.routeNo || r.route_no || "")
            .trim()
            .toUpperCase();
          const id = String(r.routeId || r.route_id || "").trim();
          if (!no || !id) continue;
          if (!map.has(no)) map.set(no, []);
          map.get(no).push({
            routeId: id,
            nameE: String(r.routeName_e || r.routeName_en || ""),
            nameC: String(r.routeName_c || r.routeName_tc || ""),
          });
        }
      } catch {
        /* empty map */
      }
      return map;
    })();
  }
  return nlbRouteMapPromise;
}

/**
 * Pick NLB routeId(s) for a public route number, preferring OD/direction match.
 * @param {string} routeNo
 * @param {object} [opt]
 * @returns {Promise<string[]>}
 */
async function nlbRouteIdsForOption(routeNo, opt) {
  const variants = await nlbRouteVariantsMap();
  const list = variants.get(String(routeNo || "").toUpperCase()) || [];
  if (!list.length) {
    const fromOpt = stripOperatorStopId(String(opt?.route_id || ""));
    return fromOpt ? [fromOpt] : [];
  }
  const toName = String(
    opt?.to?.stop_name ||
      opt?.headsign ||
      (opt?.stops?.length ? opt.stops[opt.stops.length - 1]?.stop_name : "") ||
      "",
  ).toLowerCase();
  const fromName = String(
    opt?.from?.stop_name || opt?.stops?.[0]?.stop_name || "",
  ).toLowerCase();
  if (toName || fromName) {
    const scored = list
      .map((v) => {
        const blob = `${v.nameE} ${v.nameC}`.toLowerCase();
        let score = 0;
        const parts = v.nameE.split(/\s*>\s*/);
        const dest = (parts[1] || parts[0] || "").toLowerCase();
        const orig = (parts[0] || "").toLowerCase();
        if (
          toName &&
          dest &&
          (dest.includes(toName.slice(0, 8)) || toName.includes(dest.slice(0, 8)))
        ) {
          score += 30;
        }
        if (
          fromName &&
          orig &&
          (orig.includes(fromName.slice(0, 8)) ||
            fromName.includes(orig.slice(0, 8)))
        ) {
          score += 20;
        }
        if (toName && blob.includes(toName.slice(0, 6))) score += 10;
        return { id: v.routeId, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.score > 0) {
      return [...new Set(scored.map((s) => s.id))];
    }
  }
  return list.map((v) => v.routeId);
}

/**
 * NLB open data ETA:
 * GET …/nlb/stop.php?action=estimatedArrivals&routeId={routeId}&stopId={stopId}&language={languageCode}
 * noGPS=1 → timetable-based estimate (not live GPS).
 * @param {object} opt
 * @param {object} board
 */
async function fetchNlbEta(opt, board) {
  const stopId = stripOperatorStopId(stopIdOf(board));
  const route = routeShort(opt);
  if (!stopId || !route) {
    return {
      operator: "nlb",
      route,
      stopId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: "missing stop/route",
    };
  }
  const routeIds = await nlbRouteIdsForOption(route, opt);
  if (!routeIds.length) {
    return {
      operator: "nlb",
      route,
      stopId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: "NLB route id unknown",
    };
  }

  const now = Date.now();
  /** @type {any[]} */
  const slots = [];
  let usedRouteId = routeIds[0];
  let apiMessage = "";

  for (const routeId of routeIds) {
    try {
      const data = await fetchJson(
        `${ETA_BASE}/nlb/stop.php?action=estimatedArrivals&routeId=${encodeURIComponent(routeId)}&stopId=${encodeURIComponent(stopId)}&language=en`,
      );
      const rows = Array.isArray(data?.estimatedArrivals)
        ? data.estimatedArrivals
        : Array.isArray(data?.data)
          ? data.data
          : [];
      if (data?.message) {
        apiMessage = String(data.message).replace(/<br\s*\/?>/gi, " ");
      }
      if (!rows.length) continue;
      usedRouteId = routeId;
      for (const r of rows) {
        if (String(r.departed) === "1" || r.departed === true) continue;
        const iso = normalizeEtaIso(
          r.estimatedArrivalTime || r.estimatedArrival || r.eta,
        );
        if (!iso) continue;
        const waitMins = waitMinutesFromIso(iso, now);
        if (waitMins == null) continue;
        const noGps =
          r.noGPS === 1 ||
          r.noGPS === "1" ||
          r.noGps === 1 ||
          r.noGps === "1";
        slots.push({
          waitMins,
          etaIso: iso,
          dest: r.routeVariantName || r.dest || "",
          remark: noGps ? "Timetable" : "",
          platform: null,
          scheduled: !!noGps,
        });
      }
      if (slots.length) break;
    } catch {
      /* try next routeId (other direction) */
    }
  }

  if (!slots.length) {
    return {
      operator: "nlb",
      route,
      stopId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: apiMessage || "No NLB arrivals",
    };
  }

  const packed = packSlots({ operator: "nlb", route, stopId }, slots);
  if (slots.every((s) => s.scheduled)) {
    packed.scheduled = true;
    if (apiMessage) packed.error = apiMessage;
  }
  packed.nlbRouteId = usedRouteId;
  return packed;
}

/**
 * MTR Next Train API line station order (index increases with API "UP").
 * Used to pick UP vs DOWN toward the passenger’s alight station.
 * Sources: live getSchedule.php UP/DOWN polarity + official line maps.
 */
const MTR_LINE_ORDER = {
  // UP → Tung Chung, DOWN → Hong Kong
  TCL: ["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"],
  // UP → AsiaWorld-Expo, DOWN → Hong Kong (AEL)
  AEL: ["HOK", "KOW", "TSY", "AIR", "AWE"],
  // UP → Chai Wan, DOWN → Kennedy Town
  ISL: [
    "KET", "HKU", "SYP", "SHW", "CEN", "ADM", "WAC", "CAB", "TIH", "FOH",
    "NOP", "QUB", "TAK", "SWH", "SKW", "HFC", "CHW",
  ],
  // UP → Tsuen Wan, DOWN → Central
  TWL: [
    "CEN", "ADM", "TST", "JOR", "YMT", "MOK", "PRE", "SSP", "CSW", "LCK",
    "MEF", "LAK", "KWF", "KWH", "TWH", "TSW",
  ],
  // UP → LO Wu / Lok Ma Chau side of EAL is complex; basic spine
  EAL: [
    "ADM", "EXC", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", "RAC", "UNI",
    "TAP", "TWO", "FAN", "SHS", "LOW", "LMC",
  ],
  // UP → Wu Kai Sha / toward Ma On Shan branch simplified as TML eastbound
  TML: [
    "WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", "TAW", "HIK",
    "DIH", "KAT", "SUW", "TKW", "HOM", "HUH", "ETS", "AUS", "NAC", "MEF",
    "TWW", "KSR", "YUL", "LOP", "TIS", "SIH", "TUM",
  ],
  TKL: ["NOP", "QUB", "YAT", "TIK", "TKO", "HAH", "POA", "LHP"],
  SIL: ["ADM", "OCP", "WCH", "LET", "SOH"],
  KTL: [
    "WHA", "HOM", "YMT", "MOK", "PRE", "SKM", "KOT", "LOF", "WTS", "DIH",
    "CHH", "KOB", "NTK", "KWT", "LAT", "YAT", "TIK",
  ],
  DRL: ["SUN", "DIS"],
};

/**
 * MTR station code from platform stop id / name.
 * @param {object} stop
 * @param {object} [opt]
 */
function mtrStationCode(stop, opt) {
  const id = stopIdOf(stop);
  // MTR-PLATFORM-TUC-1 or MTR-TUC
  let m = /MTR-(?:PLATFORM-)?([A-Z]{3})(?:-|$)/i.exec(id);
  if (m) return m[1].toUpperCase();
  m = /^([A-Z]{3})$/i.exec(id);
  if (m) return m[1].toUpperCase();
  const name = String(stop?.stop_name || stop?.name || stop?.address || "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
  // Common English names → codes (board/alight labels)
  const NAME_TO_CODE = {
    "tung chung": "TUC",
    "hong kong": "HOK",
    kowloon: "KOW",
    olympic: "OLY",
    "nam cheong": "NAC",
    "lai king": "LAK",
    "tsing yi": "TSY",
    "sunny bay": "SUN",
    airport: "AIR",
    "asiaworld-expo": "AWE",
    "asia world expo": "AWE",
    admiralty: "ADM",
    central: "CEN",
    "tsim sha tsui": "TST",
  };
  if (NAME_TO_CODE[name]) return NAME_TO_CODE[name];
  for (const [n, code] of Object.entries(NAME_TO_CODE)) {
    if (name.includes(n)) return code;
  }
  void opt;
  return null;
}

/**
 * @param {object} [opt]
 */
function mtrLineCode(opt) {
  const fromDetect = detectMtrLineCode?.(opt);
  if (fromDetect && fromDetect !== "LRT") return String(fromDetect).toUpperCase();
  const rid = String(opt?.route_id || "");
  const m = /MTR-([A-Z]{3})/i.exec(rid);
  if (m) return m[1].toUpperCase();
  const short = routeShort(opt);
  if (/^[A-Z]{3}$/.test(short) && short !== "LRT") return short;
  return null;
}

/**
 * Which API direction (UP/DOWN) takes passengers from board → alight.
 * @param {string} line
 * @param {string} boardSta
 * @param {string | null} alightSta
 * @returns {"UP" | "DOWN" | null}
 */
export function mtrTravelDirection(line, boardSta, alightSta) {
  const order = MTR_LINE_ORDER[String(line || "").toUpperCase()];
  if (!order || !boardSta) return null;
  const bi = order.indexOf(String(boardSta).toUpperCase());
  if (bi < 0) return null;
  if (!alightSta) return null;
  const ai = order.indexOf(String(alightSta).toUpperCase());
  if (ai < 0 || ai === bi) return null;
  // Order arrays are oriented so larger index = API UP (see MTR_LINE_ORDER comments)
  return ai > bi ? "UP" : "DOWN";
}

/**
 * Filter MTR Next Train rows for the passenger trip.
 *
 * - Prefer the UP/DOWN direction toward alight (via line order).
 * - **Fixed platform** (one platform serves that direction): only that platform.
 * - **Flexible platform** (e.g. Tung Chung P1+P2 both to HOK): show all platforms
 *   for that direction — do NOT lock to the RAPTOR board pin’s platform number.
 *
 * @param {{ UP?: object[], DOWN?: object[] }} block
 * @param {string} line
 * @param {string} boardSta
 * @param {string | null} alightSta
 * @returns {{ trains: object[], direction: string | null, multiPlatform: boolean }}
 */
export function filterMtrTrainsForTrip(block, line, boardSta, alightSta) {
  const up = Array.isArray(block?.UP) ? block.UP : [];
  const down = Array.isArray(block?.DOWN) ? block.DOWN : [];
  const dir = mtrTravelDirection(line, boardSta, alightSta);

  /** @type {object[]} */
  let pool = [];
  /** @type {string | null} */
  let direction = dir;

  if (dir === "UP" && up.length) {
    pool = up;
  } else if (dir === "DOWN" && down.length) {
    pool = down;
  } else if (alightSta) {
    // Fallback: direction whose dests match alight / terminus past alight
    const alight = String(alightSta).toUpperCase();
    const upHit = up.filter((t) => String(t.dest || "").toUpperCase() === alight);
    const downHit = down.filter((t) => String(t.dest || "").toUpperCase() === alight);
    if (upHit.length && !downHit.length) {
      pool = up;
      direction = "UP";
    } else if (downHit.length && !upHit.length) {
      pool = down;
      direction = "DOWN";
    } else if (upHit.length || downHit.length) {
      // Both sides claim dest (rare) — take matching trains only
      pool = [...upHit, ...downHit];
      direction = null;
    } else {
      // Intermediate alight: use line order if possible, else both dirs
      pool = dir === "UP" ? up : dir === "DOWN" ? down : [...up, ...down];
      if (!pool.length) pool = [...up, ...down];
    }
  } else {
    pool = [...up, ...down];
  }

  // Drop invalid
  pool = pool.filter((t) => String(t.valid || "Y").toUpperCase() !== "N");

  // Platforms used in this travel direction
  const platSet = new Set(
    pool.map((t) => String(t.plat ?? "").trim()).filter(Boolean),
  );
  const multiPlatform = platSet.size > 1;

  // Fixed platform direction: only one platform serves the destination direction
  // (already true if platSet.size === 1). Multi-platform: keep all platforms.
  // Never filter by RAPTOR board platform pin when multiPlatform.
  if (!multiPlatform && platSet.size === 1) {
    const only = [...platSet][0];
    pool = pool.filter((t) => String(t.plat ?? "").trim() === only);
  }

  return { trains: pool, direction, multiPlatform };
}

/** @param {object} opt @param {object} board @param {object} [alight] */
async function fetchMtrEta(opt, board, alight) {
  const line = mtrLineCode(opt);
  const sta = mtrStationCode(board, opt);
  if (!line || !sta) {
    return {
      operator: "mtr",
      route: line || routeShort(opt),
      stopId: sta || stopIdOf(board),
      etas: [],
      waitMins: null,
      etaIso: null,
      error: "missing MTR line/station",
    };
  }
  try {
    const data = await fetchJson(
      `${ETA_BASE}/mtr/getSchedule.php?line=${encodeURIComponent(line)}&sta=${encodeURIComponent(sta)}`,
    );
    const key = `${line}-${sta}`;
    const block = data?.data?.[key] || data?.data?.[`${sta}`] || {};
    const alightCode = alight ? mtrStationCode(alight, opt) : null;

    const { trains, multiPlatform } = filterMtrTrainsForTrip(
      block,
      line,
      sta,
      alightCode,
    );

    const servingPlatforms = collectServingPlatforms(trains);
    const now = Date.now();
    const slots = [];
    for (const t of trains) {
      const iso = normalizeEtaIso(t.time);
      let waitMins =
        t.ttnt != null && t.ttnt !== ""
          ? Math.max(0, Number(t.ttnt))
          : waitMinutesFromIso(iso, now);
      if (waitMins == null && !iso) continue;
      if (waitMins == null) waitMins = 0;
      // Prefer API platform; never force RAPTOR board pin when multi-platform
      const platLabel = formatPlatformLabel(t.plat);
      const realIso = iso
        ? iso
        : new Date(now + waitMins * 60_000).toISOString();
      slots.push({
        waitMins,
        etaIso: realIso,
        dest: t.dest || "",
        remark: platLabel || "",
        platform: platLabel,
      });
    }
    return packSlots(
      {
        operator: "mtr",
        route: line,
        stopId: sta,
        multiPlatform,
        servingPlatforms,
        fetchedAt: now,
      },
      slots,
    );
  } catch (e) {
    return {
      operator: "mtr",
      route: line,
      stopId: sta,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: e instanceof Error ? e.message : "MTR fetch failed",
    };
  }
}

/**
 * @param {object} stop
 * @param {object} [opt]
 */
function lrtStationId(stop, opt) {
  const id = stopIdOf(stop);
  if (/^\d+$/.test(stripOperatorStopId(id))) return stripOperatorStopId(id);
  const name = String(stop?.stop_name || stop?.name || "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
  for (const s of LRT_STOPS) {
    if (
      name &&
      (name === s.name_en.toLowerCase() ||
        name.includes(s.name_en.toLowerCase()) ||
        (s.name_zh && name.includes(s.name_zh)))
    ) {
      return String(s.stop_id || "");
    }
  }
  // route option may carry stop codes
  void opt;
  return "";
}

/** @param {object} opt @param {object} board */
async function fetchLrtEta(opt, board) {
  const stationId = lrtStationId(board, opt);
  const route = routeShort(opt);
  if (!stationId) {
    return {
      operator: "lrt",
      route,
      stopId: stationId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: "LRT station unknown",
    };
  }
  try {
    const data = await fetchJson(
      `${ETA_BASE}/mtr/lrt/getSchedule?station_id=${encodeURIComponent(stationId)}`,
    );
    const platforms = Array.isArray(data?.platform_list) ? data.platform_list : [];
    const now = Date.now();
    const slots = [];
    for (const p of platforms) {
      const plat = formatPlatformLabel(p.platform_id ?? p.platform);
      for (const r of p.route_list || []) {
        const rno = String(r.route_no || r.routeNo || "").toUpperCase();
        if (route && rno && rno !== route) continue;
        const timeEn = String(r.time_en || r.time_ch || "").trim();
        let waitMins = null;
        if (/arriving|departing|即將|正在/i.test(timeEn)) waitMins = 0;
        else {
          const m = /(\d+)\s*min/i.exec(timeEn);
          if (m) waitMins = Number(m[1]);
        }
        if (waitMins == null) continue;
        slots.push({
          waitMins,
          etaIso: new Date(now + waitMins * 60_000).toISOString(),
          dest: r.dest_en || r.dest_ch || "",
          remark: rno ? `Route ${rno}` : "",
          platform: plat || platformFromStop(board),
        });
      }
    }
    return packSlots({ operator: "lrt", route, stopId: stationId }, slots);
  } catch (e) {
    return {
      operator: "lrt",
      route,
      stopId: stationId,
      etas: [],
      waitMins: null,
      etaIso: null,
      error: e instanceof Error ? e.message : "LRT fetch failed",
    };
  }
}

/**
 * Fetch live ETAs for boarding stop of a transit option.
 * @param {object} opt route option
 * @param {object} [alight] alight stop (helps MTR direction)
 * @returns {Promise<LegEtaResult>}
 */
export async function fetchBoardEta(opt, alight) {
  const board = opt?.from || (Array.isArray(opt?.stops) ? opt.stops[0] : null);
  if (!opt || !board) {
    return {
      operator: "unknown",
      route: "",
      stopId: "",
      etas: [],
      waitMins: null,
      etaIso: null,
      unsupported: true,
      error: "no board stop",
    };
  }
  const op = etaOperator(opt);
  try {
    if (op === "kmb") return await fetchKmbEta(opt, board);
    if (op === "ctb") return await fetchCtbEta(opt, board);
    if (op === "nlb") return await fetchNlbEta(opt, board);
    if (op === "mtr") return await fetchMtrEta(opt, board, alight || opt.to);
    if (op === "lrt") return await fetchLrtEta(opt, board);
  } catch (e) {
    return {
      operator: op,
      route: routeShort(opt),
      stopId: stopIdOf(board),
      etas: [],
      waitMins: null,
      etaIso: null,
      error: e instanceof Error ? e.message : "ETA failed",
    };
  }
  return {
    operator: op,
    route: routeShort(opt),
    stopId: stopIdOf(board),
    etas: [],
    waitMins: null,
    etaIso: null,
    unsupported: true,
    error: "operator not supported",
  };
}

/**
 * Collect transit legs from a plan with board indices.
 * @param {object} plan
 * @returns {Array<{ legIndex: number, opt: object, alight: object | null }>}
 */
export function planTransitBoards(plan) {
  const out = [];
  const legs = plan?.legs || [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg?.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    if (!opt) continue;
    const alight =
      opt.to ||
      (Array.isArray(opt.stops) && opt.stops.length
        ? opt.stops[opt.stops.length - 1]
        : null);
    out.push({ legIndex: i, opt, alight });
  }
  return out;
}

/**
 * True when open-data returned usable *live GPS* departures (not timetable-only).
 * @param {LegEtaResult | null | undefined} result
 */
export function hasLiveEtaSlots(result) {
  if (!result || result.unsupported || result.scheduled) return false;
  const slots = Array.isArray(result.etas) ? result.etas : [];
  return slots.some(
    (s) =>
      !s?.scheduled &&
      (s.waitMins != null || (s.etaIso && String(s.etaIso).length > 0)),
  );
}

/**
 * Any usable arrival rows (live GPS or operator timetable like NLB noGPS).
 * @param {LegEtaResult | null | undefined} result
 */
export function hasAnyEtaSlots(result) {
  if (!result || result.unsupported) return false;
  const slots = Array.isArray(result.etas) ? result.etas : [];
  return slots.some(
    (s) =>
      s.waitMins != null ||
      (s.etaIso && String(s.etaIso).length > 0) ||
      (s.clock && s.clock !== "—"),
  );
}

/**
 * Attach RAPTOR/GTFS timetable board when open-data ETA is fully N/A.
 * Keeps NLB/operator timetable rows (noGPS) — does not overwrite them.
 * @param {LegEtaResult} result
 * @param {object} opt
 * @param {object} plan
 * @param {number} legIndex
 * @returns {LegEtaResult}
 */
export function withScheduledFallback(result, opt, plan, legIndex) {
  if (hasLiveEtaSlots(result)) return result;
  // Operator already returned arrivals (possibly all timetable / noGPS)
  if (hasAnyEtaSlots(result)) {
    return {
      ...result,
      scheduled: result.scheduled || result.etas.every((s) => s?.scheduled),
      unsupported: false,
    };
  }
  const sched = scheduledSlotFromPlanLeg(opt, plan, legIndex);
  if (!sched) return result;
  return {
    ...result,
    etas: [sched],
    waitMins: sched.waitMins,
    etaIso: null,
    scheduled: true,
    unsupported: false,
    error: result?.error || null,
    fetchedAt: result?.fetchedAt ?? Date.now(),
  };
}

/**
 * @param {object} plan
 * @returns {Promise<Map<number, LegEtaResult>>} map legIndex → eta
 */
export async function fetchPlanBoardEtas(plan) {
  const boards = planTransitBoards(plan);
  /** @type {Map<number, LegEtaResult>} */
  const map = new Map();
  await Promise.all(
    boards.map(async ({ legIndex, opt, alight }) => {
      let result = await fetchBoardEta(opt, alight);
      // No live open-data → compute wait/clock from trip plan timetable
      result = withScheduledFallback(result, opt, plan, legIndex);
      map.set(legIndex, result);
    }),
  );
  return map;
}

/**
 * Leg duration in seconds (fallback from stop offsets).
 * @param {object} leg
 */
export function legDurationSeconds(leg) {
  if (typeof leg?.duration_seconds === "number" && leg.duration_seconds > 0) {
    return leg.duration_seconds;
  }
  if (leg?.type === "transit") {
    const opt = leg.route_options?.[0];
    const stops = opt?.stops;
    if (Array.isArray(stops) && stops.length >= 2) {
      const a = Number(stops[0]?.departure_offset_minutes ?? stops[0]?.arrival_offset_minutes);
      const b = Number(
        stops[stops.length - 1]?.arrival_offset_minutes ??
          stops[stops.length - 1]?.departure_offset_minutes,
      );
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
        return Math.max(60, (b - a) * 60);
      }
    }
  }
  if (leg?.type === "walk" && typeof leg.distance_meters === "number") {
    return Math.max(30, Math.round(leg.distance_meters / 1.25));
  }
  return 0;
}

/**
 * Minutes from vehicle board for each stop (relative to first stop).
 * Uses GTFS-style offsets when present; otherwise spreads ride time evenly.
 * @param {object} opt
 * @param {object[]} stops
 * @param {number} rideSec total ride seconds board→alight
 * @returns {number[]} minutes from board for each stop
 */
export function stopOffsetMinutesFromBoard(opt, stops, rideSec) {
  const n = stops?.length || 0;
  if (n === 0) return [];
  const rideMins = Math.max(1, Math.round((rideSec || 0) / 60) || 1);

  /** @type {(number | null)[]} */
  const raw = stops.map((st) => {
    const dep = Number(st?.departure_offset_minutes);
    const arr = Number(st?.arrival_offset_minutes);
    if (Number.isFinite(dep)) return dep;
    if (Number.isFinite(arr)) return arr;
    return null;
  });

  const known = raw.filter((v) => v != null);
  if (known.length >= 2) {
    const base = Number(raw[0] ?? known[0]);
    return raw.map((v, i) => {
      if (v != null) return Math.max(0, v - base);
      // interpolate holes
      let prevI = i - 1;
      while (prevI >= 0 && raw[prevI] == null) prevI--;
      let nextI = i + 1;
      while (nextI < n && raw[nextI] == null) nextI++;
      const prevV = prevI >= 0 ? raw[prevI] - base : 0;
      const nextV = nextI < n ? raw[nextI] - base : rideMins;
      if (prevI < 0 && nextI >= n) return (i / Math.max(n - 1, 1)) * rideMins;
      const span = Math.max(nextI - prevI, 1);
      const t = (i - Math.max(prevI, 0)) / span;
      return Math.max(0, (prevV ?? 0) + ((nextV ?? rideMins) - (prevV ?? 0)) * t);
    });
  }

  // No offsets — even spacing board→alight
  if (n === 1) return [0];
  return stops.map((_, i) => (i / (n - 1)) * rideMins);
}

/**
 * @typedef {{ stopIndex: number, role: "board" | "passby" | "alight", roleLabel: string, ms: number, clock: string }} StopTimePoint
 */

/**
 * Build wall-clock times for every board / pass-by / alight stop in the plan,
 * anchored on live board ETAs (and walk/wait between legs).
 *
 * @param {object} plan
 * @param {Map<number, LegEtaResult>} etaByLeg
 * @param {number} [nowMs]
 * @returns {{
 *   byLeg: Map<number, StopTimePoint[]>,
 *   arriveMs: number,
 *   leaveMs: number | null,
 *   usedLive: boolean,
 * }}
 */
export function buildPlanStopTimes(plan, etaByLeg, nowMs = Date.now()) {
  /** @type {Map<number, StopTimePoint[]>} */
  const byLeg = new Map();
  let t = nowMs;
  let leaveMs = null;
  let usedLive = false;
  const legs = plan?.legs || [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (!leg) continue;
    if (leg.type === "walk" || leg.type === "wait") {
      t += legDurationSeconds(leg) * 1000;
      continue;
    }
    if (leg.type !== "transit") continue;

    const opt = leg.route_options?.[0] || {};
    const stops =
      Array.isArray(opt.stops) && opt.stops.length >= 2
        ? opt.stops
        : [opt.from, opt.to].filter(Boolean);
    const rideSec = legDurationSeconds(leg);
    const live = etaByLeg?.get(i);
    const liveOk = hasLiveEtaSlots(live);

    let boardMs = t;
    if (liveOk && live.waitMins != null && Number.isFinite(live.waitMins)) {
      boardMs = Math.max(t, nowMs + live.waitMins * 60_000);
      usedLive = true;
    } else if (liveOk && live?.etaIso) {
      const parsed = Date.parse(live.etaIso);
      if (Number.isFinite(parsed)) {
        boardMs = Math.max(t, parsed);
        usedLive = true;
      }
    } else {
      // Timetable: prefer scheduled wait from plan / injected scheduled slot
      const schedWait =
        live?.scheduled && live.waitMins != null && Number.isFinite(live.waitMins)
          ? live.waitMins
          : waitMinsFromServiceClock(opt?.start_time, new Date(nowMs));
      if (schedWait != null && Number.isFinite(schedWait)) {
        boardMs = Math.max(t, nowMs + schedWait * 60_000);
      } else if (opt?.start_time) {
        // Service-clock face without reliable "now" delta — keep chain from t
        // but still surface clock via stop points below
        boardMs = t;
      }
    }
    if (leaveMs == null) leaveMs = boardMs;

    const offsets = stopOffsetMinutesFromBoard(opt, stops, rideSec);
    /** @type {StopTimePoint[]} */
    const points = [];
    const last = Math.max(stops.length - 1, 0);
    for (let s = 0; s < stops.length; s++) {
      const role =
        s === 0 ? "board" : s === last ? "alight" : "passby";
      const roleLabel =
        role === "board" ? "BOARD" : role === "alight" ? "ALIGHT" : "PASS BY";
      const minsFromBoard = offsets[s] ?? (s === last ? rideSec / 60 : 0);
      const ms = boardMs + Math.round(minsFromBoard * 60_000);
      points.push({
        stopIndex: s,
        role,
        roleLabel,
        ms,
        clock: formatHkClock(ms),
      });
    }
    // Ensure alight is at least board + ride when only 2 points / zero offsets
    if (points.length >= 2) {
      const alight = points[points.length - 1];
      const minAlight = boardMs + Math.max(rideSec, 60) * 1000;
      if (alight.ms < minAlight && offsets.every((o, idx) => idx === 0 || o === 0)) {
        // even spacing already applied; if rideSec was 0, bump alight
        alight.ms = minAlight;
        alight.clock = formatHkClock(alight.ms);
      }
    }

    byLeg.set(i, points);
    const alightMs = points[points.length - 1]?.ms;
    t =
      alightMs != null
        ? alightMs
        : boardMs + Math.max(rideSec, 60) * 1000;
  }

  if (t <= nowMs && typeof plan?.duration_seconds === "number") {
    t = nowMs + plan.duration_seconds * 1000;
  }
  return { byLeg, arriveMs: t, leaveMs, usedLive };
}

/**
 * Estimate wall-clock arrival using live board waits + plan ride/walk durations.
 * @param {object} plan
 * @param {Map<number, LegEtaResult>} etaByLeg
 * @param {number} [nowMs]
 * @returns {{ arriveMs: number, leaveMs: number | null, usedLive: boolean }}
 */
export function estimateTripArrival(plan, etaByLeg, nowMs = Date.now()) {
  const { arriveMs, leaveMs, usedLive } = buildPlanStopTimes(
    plan,
    etaByLeg,
    nowMs,
  );
  return { arriveMs, leaveMs, usedLive };
}

/**
 * Format wait for UI: "N/A", "Now", "1 min", "12 min"
 * @param {number | null | undefined} mins
 */
export function formatWaitMins(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return "N/A";
  const n = Math.round(Number(mins));
  if (n <= 0) return "Now";
  if (n === 1) return "1 min";
  return `${n} min`;
}

/**
 * Bus / GMB / ferry — no platform in live status lines.
 * @param {string | null | undefined} operator
 */
export function etaOperatorShowsPlatform(operator) {
  const op = String(operator || "").toLowerCase();
  if (!op) return true;
  if (
    op === "kmb" ||
    op === "lwb" ||
    op === "ctb" ||
    op === "nlb" ||
    op === "gmb" ||
    op === "bus" ||
    op === "mtr_bus" ||
    op === "mtr-bus" ||
    op === "lrtfeeder"
  ) {
    return false;
  }
  return true; // mtr, lrt, …
}

/**
 * One line in the trip-detail ETA card:
 *   Rail: Platform 1 · 3 min · 18:16
 *   Bus/GMB: 3 min · 18:16  (no Platform)
 *   Scheduled: 12 min · 18:30  (or just 18:30)
 * @param {EtaSlot} slot
 * @param {{ fallbackPlatform?: string | null, operator?: string, showPlatform?: boolean }} [opts]
 */
export function formatEtaCardLine(slot, opts = {}) {
  const waitText = formatWaitMins(slot?.waitMins);
  const clock = slot?.clock || formatHkClock(slot?.etaIso);
  const showPlat =
    !slot?.scheduled &&
    (opts.showPlatform != null
      ? !!opts.showPlatform
      : etaOperatorShowsPlatform(opts.operator));

  if (slot?.scheduled) {
    if (waitText === "N/A") return clock && clock !== "—" ? clock : "N/A";
    if (clock && clock !== "—") return `${waitText} · ${clock}`;
    return waitText;
  }

  if (!showPlat) {
    return clock && clock !== "—" ? `${waitText} · ${clock}` : waitText;
  }
  const plat =
    formatPlatformLabel(slot?.platform) ||
    formatPlatformLabel(opts.fallbackPlatform) ||
    null;
  if (plat)
    return `${plat} · ${waitText}${clock && clock !== "—" ? ` · ${clock}` : ""}`;
  return clock && clock !== "—" ? `${waitText} · ${clock}` : waitText;
}

/**
 * ETA card title: Live Status (Last Update: 12 seconds ago)
 * @param {number | null | undefined} fetchedAt epoch ms
 * @param {number} [nowMs]
 */
export function formatLiveStatusHead(fetchedAt, nowMs = Date.now()) {
  if (fetchedAt == null || !Number.isFinite(fetchedAt)) {
    return "Live Status (Last Update: —)";
  }
  const sec = Math.max(0, Math.floor((nowMs - fetchedAt) / 1000));
  const unit = sec === 1 ? "second" : "seconds";
  return `Live Status (Last Update: ${sec} ${unit} ago)`;
}

/**
 * Format absolute clock in Hong Kong.
 * @param {number | string | Date} msOrIso
 */
export function formatHkClock(msOrIso) {
  try {
    const d =
      typeof msOrIso === "number"
        ? new Date(msOrIso)
        : msOrIso instanceof Date
          ? msOrIso
          : new Date(msOrIso);
    if (!Number.isFinite(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    return "—";
  }
}
