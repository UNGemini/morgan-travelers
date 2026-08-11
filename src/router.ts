/**
 * MORGAN Travelers — WASM RAPTOR router wrapper
 * Loads hk.wheelsrouter (or .gz) and plans trips via wheels-router-nano.
 *
 * Human ranking rules:
 *  - Bus: strongly prefer direct (heavy transfer penalty)
 *  - MTR: interchanges allowed (light penalty)
 *  - Both OD MTR stations: prefer MTR-network plans over bus
 *  - Prefer in-station MTR interchange over long street walks between lines
 *  - Drop / bury plans with impossible Victoria Harbour walks
 */
// @ts-expect-error wasm-pack JS glue has no ambient types in this tree
import init, { WasmRouter } from "./pkg/wheels_router_nano.js";
import { detectMtrLineCode, isLightRailOption } from "./mtrColors.js";
import {
  isLegacyKcrMtrInterchange,
  isFreeMtrInterchangeWalk,
  KCR_MTR_INTERCHANGE_EXTRA_SECONDS,
} from "./mtrInterchange.js";
import {
  planHasCrossHarbourWalk,
  countCrossHarbourWalks,
  CROSS_HARBOUR_WALK_PENALTY_SECONDS,
} from "./harbourWalk.js";
import {
  expandAccessPoints,
  stitchDualAccessPlan,
} from "./stationAccess.js";
import {
  injectShuttlePlans,
  routeOptionCompanyIds,
} from "./shuttleInject.js";
import { preferNameMatchedAlights } from "./alightPrefer.js";

export interface RouteQuery {
  origin: [number, number]; // [lat, lon]
  destination: [number, number]; // [lat, lon]
  departAt?: string; // ISO 8601 UTC
  maxResults?: number;
  maxTransfers?: number;
  maxWalkDistance?: number;
  walkingSpeed?: "slow" | "normal" | "fast";
  /** Hint: origin is an MTR / rail station (from search or label). */
  originIsMtr?: boolean;
  /** Hint: destination is an MTR / rail station. */
  destIsMtr?: boolean;
  /** Origin pin is a transit stop/station (MTR, LRT, bus stop). */
  originIsStation?: boolean;
  /** Destination pin is a transit stop/station (MTR, LRT, bus stop). */
  destIsStation?: boolean;
  /** Search / place label for dual-access matching (e.g. "Central Station"). */
  originLabel?: string;
  destLabel?: string;
  /**
   * Ranking preferences (multi-select). Any of:
   * fastest | simplest | cheapest — combine when several are set.
   */
  preferences?: Array<"fastest" | "simplest" | "cheapest">;
  /** @deprecated use preferences[] */
  preference?: "fastest" | "simplest" | "cheapest";
  /** Precomputed fares (same order as raw plans pool) for cheapest ranking */
  fareEstimator?: (plan: Plan) => number | null;
  /**
   * Allowed traffic methods (multi-select).
   * bus | gmb | lrt | mtr | walk | ael — empty/missing = all allowed.
   */
  trafficMethods?: string[];
  /**
   * Allowed bus companies (multi-select).
   * kmb_lwb | ctb | nlb | gmb | mtr_bus | rbs — empty/missing = all allowed.
   */
  busCompanies?: string[];
  /** Override RAPTOR modes string (comma-separated). */
  modes?: string;
}

export interface RankContext {
  originIsMtr?: boolean;
  destIsMtr?: boolean;
  /**
   * Destination is a transit stop/station pin (MTR/LRT/bus stop).
   * When true, “walk to destination” egress is not required under Walk-off.
   */
  destIsStation?: boolean;
  /** Origin is a transit stop/station pin. */
  originIsStation?: boolean;
  /**
   * Active ranking preferences (multi-select).
   * Empty / missing → fastest.
   */
  preferences?: Array<"fastest" | "simplest" | "cheapest">;
  /** @deprecated use preferences[] */
  preference?: "fastest" | "simplest" | "cheapest";
  /** Optional fare totals keyed by plan identity (index) for cheapest mode */
  fareByIndex?: Array<number | null | undefined>;
  trafficMethods?: string[];
  busCompanies?: string[];
}

function normalizePreferences(
  ctx: RankContext = {},
): Set<"fastest" | "simplest" | "cheapest"> {
  const raw = [
    ...(ctx.preferences || []),
    ...(ctx.preference ? [ctx.preference] : []),
  ].filter(
    (p): p is "fastest" | "simplest" | "cheapest" =>
      p === "fastest" || p === "simplest" || p === "cheapest",
  );
  if (!raw.length) return new Set(["fastest"]);
  return new Set(raw);
}

export interface RouterStats {
  stops: number;
  routes: number;
  trips: number;
  services: number;
}

export interface PlanResponse {
  plans: Plan[];
}

export interface Plan {
  duration_seconds: number;
  duration_seconds_min?: number;
  duration_seconds_max?: number;
  start_time: string;
  legs: Leg[];
  /** Populated by human-centric ranking (not from WASM). */
  human_score?: number;
  transfer_count?: number;
  bus_transfer_count?: number;
  mtr_transfer_count?: number;
  kcr_mtr_legacy_interchange_count?: number;
  walk_meters?: number;
  mtr_only?: boolean;
  is_recommended?: boolean;
}

export type Leg =
  | {
      type: "walk";
      duration_seconds: number;
      distance_meters?: number;
      path?: { lat: number; lon: number }[];
      from?: unknown;
      to?: unknown;
      walk_type?: string;
    }
  | { type: "transit"; route_options: RouteOption[] }
  | { type: "wait"; duration_seconds: number };

export interface RouteOption {
  route_id: string;
  route_name: string;
  route_short_name?: string;
  route_long_name?: string;
  headsign?: string;
  mode: string;
  duration_seconds: number;
  start_time?: string;
  color?: string;
  text_color?: string;
  from: StopInfo;
  to: StopInfo;
  stops: StopInfo[];
  agency: { id: string; name: string };
}

export interface StopInfo {
  location: { lat: number; lon: number };
  stop_name?: string;
  stop_id?: string;
  id?: string;
}

const DATA_BASE = "https://hk-gtfsdata.morgandev.cc";
const DEFAULT_GRAPH_URL = `${DATA_BASE}/hk.wheelsrouter`;
const DEFAULT_GRAPH_GZ_URL = `${DATA_BASE}/hk.wheelsrouter.gz`;

function localGraphCandidates(): string[] {
  return [new URL("data/hk.wheelsrouter.gz", window.location.href).href];
}

let routerInstance: InstanceType<typeof WasmRouter> | null = null;
let initPromise: Promise<void> | null = null;
let graphSource = "";

export function isRouterReady(): boolean {
  return routerInstance !== null;
}

export function getGraphSource(): string {
  return graphSource;
}

export function getRouterStats(): RouterStats | null {
  if (!routerInstance) return null;
  return routerInstance.stats() as RouterStats;
}

/**
 * Fetches the binary routing graph and initializes the WASM RAPTOR engine.
 */
export async function initRouter(
  dataUrl: string = DEFAULT_GRAPH_URL,
): Promise<void> {
  if (routerInstance) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await init();

    const candidates = uniqueUrls([
      ...localGraphCandidates(),
      dataUrl,
      DEFAULT_GRAPH_URL,
      DEFAULT_GRAPH_GZ_URL,
    ]);

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const buffer = await fetchGraphBytes(url);
        routerInstance = new WasmRouter(buffer);
        graphSource = url;
        const stats = routerInstance.stats() as RouterStats;
        console.log(
          "MORGAN Travelers WASM Router initialized.",
          graphSource,
          stats,
        );
        return;
      } catch (err) {
        lastError = err;
        console.warn("[router] graph load failed for", url, err);
      }
    }

    initPromise = null;
    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to download router graph from all candidates");
  })();

  return initPromise;
}

// ── Human ranking constants ──────────────────────────────────────────────────

/** Bus-to-bus (or bus after anything) transfer — strongly prefer direct bus. */
export const BUS_TRANSFER_PENALTY_SECONDS = 900; // 15 min

/** MTR line change (interchange) — allowed / lightly penalised. */
export const MTR_TRANSFER_PENALTY_SECONDS = 90; // 1.5 min

/** Bus ↔ MTR mixed transfer. */
export const MIXED_TRANSFER_PENALTY_SECONDS = 480; // 8 min

/** Long outdoor walk between two MTR legs (prefer paid in-station interchange). */
export const MTR_STREET_WALK_PENALTY_SECONDS = 720; // 12 min flat + distance

/** In-station MTR transfer walk (station_transfer) — small cost. */
export const MTR_STATION_TRANSFER_WALK_PENALTY = 30;

/** Official free links (CEN↔HOK, TST↔ETS, …) — slight bonus vs normal transfer. */
export const MTR_FREE_INTERCHANGE_BONUS_SECONDS = 90;

/**
 * Extra cost for former KCR↔MTR interchanges (not built as one station).
 * Exceptions: Nam Cheong, Ho Man Tin. Includes Diamond Hill.
 * @see mtrInterchange.js
 */
export const KCR_MTR_LEGACY_INTERCHANGE_EXTRA = KCR_MTR_INTERCHANGE_EXTRA_SECONDS;

/** Soft walk penalty per meter (access/egress + general). */
export const WALK_METER_PENALTY_SECONDS = 0.45;

/** Bonus (score reduction) when both OD are MTR and plan is MTR-only. */
export const MTR_NETWORK_BONUS_SECONDS = 1200; // 20 min preference

/** Prefer plans that use MTR Light Rail (NWNT) over pure bus feeders. */
export const LRT_NETWORK_BONUS_SECONDS = 480; // 8 min

/** Penalty when both OD are MTR but plan relies on bus. */
export const MTR_AVOID_BUS_PENALTY_SECONDS = 600;

/**
 * Modes string for WASM RAPTOR (comma-separated).
 * Explicitly includes tram + light_rail so HK MTR Light Rail is never dropped
 * if the graph/build supports mode filtering.
 */
export const ROUTER_MODES =
  "subway,rail,tram,light_rail,monorail,bus,trolleybus,ferry,cable_tram,funicular";

/** @deprecated use BUS_TRANSFER_PENALTY_SECONDS — kept for callers */
export const TRANSFER_PENALTY_SECONDS = BUS_TRANSFER_PENALTY_SECONDS;

export const DEFAULT_WALKING_SPEED: NonNullable<RouteQuery["walkingSpeed"]> =
  "slow";
export const DEFAULT_MAX_WALK_DISTANCE = 1200;

// ── Mode helpers ─────────────────────────────────────────────────────────────

export function isMtrTransitOption(opt?: RouteOption | null): boolean {
  if (!opt) return false;
  // MTR Light Rail (agency LR / mode tram|light_rail) — always rail network
  if (isLightRailOption(opt)) return true;
  const mode = String(opt.mode || "").toLowerCase();
  if (
    mode === "subway" ||
    mode === "rail" ||
    mode === "light_rail" ||
    mode === "tram" ||
    mode === "monorail" ||
    mode === "cable_tram" ||
    mode === "funicular"
  ) {
    return true;
  }
  if (detectMtrLineCode(opt)) return true;
  const agency = String(opt.agency?.name || opt.agency?.id || "").toLowerCase();
  if (agency === "lr") return true;
  if (/\bmtr\b/.test(agency) && mode !== "bus") return true;
  return false;
}

/** Re-export for callers that need LRT-specific UI / fares. */
export { isLightRailOption };

/**
 * Rough catchment of the MTR Light Rail network (Tuen Mun / Tin Shui Wai / Yuen Long).
 * Used to request more RAPTOR candidates so multi-leg LRT surfaces.
 */
export function isLrtCatchment(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 22.36 &&
    lat <= 22.505 &&
    lon >= 113.94 &&
    lon <= 114.065
  );
}

export function isBusTransitOption(opt?: RouteOption | null): boolean {
  if (!opt) return false;
  if (isMtrTransitOption(opt)) return false;
  const mode = String(opt.mode || "").toLowerCase();
  return mode === "bus" || mode === "trolleybus" || mode === "";
}

function isAelOption(opt?: RouteOption | null): boolean {
  if (!opt) return false;
  const blob =
    `${opt.route_short_name || ""} ${opt.route_long_name || ""} ${opt.route_name || ""} ${opt.route_id || ""}`.toLowerCase();
  return (
    blob.includes("airport express") ||
    /\bael\b/.test(blob) ||
    /mtr-ael/.test(blob)
  );
}

/** True when a plan uses Airport Express. */
export function planHasAel(plan: Plan): boolean {
  return (plan.legs || []).some(
    (l) => l.type === "transit" && isAelOption(l.route_options?.[0]),
  );
}

/** True when plan touches Airport / AsiaWorld corridor (for ranking). */
function planTouchesAelCorridor(plan: Plan): boolean {
  if (planHasAel(plan)) return true;
  for (const leg of plan.legs || []) {
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    const blob = `${opt?.from?.stop_name || ""} ${opt?.to?.stop_name || ""}`.toLowerCase();
    if (/\bairport\b|機場|asia\s*world|博覽/.test(blob)) return true;
  }
  return false;
}

function classifyBusCompanyId(opt?: RouteOption | null): string | null {
  if (!opt) return null;
  // Residents' Bus Services (NR / DB routes) — a route-level class that wins
  // over the operator: NR61/NR88 are CTB-operated but still RBS services.
  if (/^(NR|DB)\d/i.test(String(opt.route_short_name || ""))) return "rbs";
  const blob = `${opt.agency?.id || ""} ${opt.agency?.name || ""}`.toLowerCase();
  if (/gmb|green\s*mini|minibus|專線|专线/.test(blob)) return "gmb";
  if (/\bnlb\b|new\s*lanto/.test(blob)) return "nlb";
  if (/\bctb\b|citybus|nwfb|new\s*world/.test(blob)) return "ctb";
  if (/\bmtrb\b|mtr\s*bus|港鐵巴士/.test(blob)) return "mtr_bus";
  if (
    /\bkmb\b|lwb|long\s*win|kowloon\s*motor|lrt\s*feeder/.test(
      blob,
    )
  ) {
    return "kmb_lwb";
  }
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "bus" || mode === "trolleybus") return "kmb_lwb";
  return null;
}

function classifyTrafficMethodId(
  opt?: RouteOption | null,
): "bus" | "gmb" | "lrt" | "mtr" | "ael" | "other" | null {
  if (!opt) return null;
  if (isAelOption(opt)) return "ael";
  if (isLightRailOption(opt)) return "lrt";
  if (isMtrTransitOption(opt)) return "mtr";
  const co = classifyBusCompanyId(opt);
  if (co === "gmb") return "gmb";
  if (isBusTransitOption(opt) || co) return "bus";
  return "other";
}

/**
 * True when the itinerary already ends at a transit stop/station (no real
 * “walk to destination” beyond platform / pin noise).
 */
export function planEndsAtTransitStop(plan: Plan): boolean {
  const legs = plan?.legs || [];
  if (!legs.length) return false;
  const last = legs[legs.length - 1];
  if (last.type === "transit") return true;
  if (last.type !== "walk") return false;
  let prevTransit = false;
  for (let i = legs.length - 2; i >= 0; i--) {
    if (legs[i].type === "transit") {
      prevTransit = true;
      break;
    }
    if (legs[i].type === "walk" || legs[i].type === "wait") continue;
    break;
  }
  if (!prevTransit) return false;
  const wtype = String(
    // @ts-expect-error optional
    last.walk_type || "",
  ).toLowerCase();
  // @ts-expect-error optional stitch
  if (last.free_mtr_link || last.indoor_interchange) return true;
  if (
    wtype.includes("station") ||
    wtype === "egress" ||
    wtype === "station_egress" ||
    wtype === "station_access"
  ) {
    return true;
  }
  const dist =
    typeof last.distance_meters === "number"
      ? last.distance_meters
      : (last.duration_seconds || 0) * 0.8;
  const secs =
    typeof last.duration_seconds === "number" && last.duration_seconds > 0
      ? last.duration_seconds
      : dist / 0.8;
  // Short pin/platform snap → destination is the stop
  if (dist <= 200 || secs <= 150) return true;
  return false;
}

/**
 * Whether a plan uses only allowed traffic methods + bus companies.
 * Walk off: short station access still allowed; long “walk to destination”
 * egress (&gt; 3 min) is rejected — unless destination *is* the stop/station.
 */
export function planMatchesFilters(
  plan: Plan,
  trafficMethods?: string[] | null,
  busCompanies?: string[] | null,
  opts?: {
    destIsStation?: boolean;
    originIsStation?: boolean;
  } | null,
): boolean {
  const methods = trafficMethods?.length
    ? new Set(trafficMethods)
    : null;
  const cos = busCompanies?.length ? new Set(busCompanies) : null;
  if (!methods && !cos) return true;

  /** Max egress duration when Walk is disabled (seconds). */
  const MAX_EGRESS_SECS_WITHOUT_WALK = 3 * 60;

  const destIsStation =
    !!opts?.destIsStation || planEndsAtTransitStop(plan);
  const originIsStation = !!opts?.originIsStation;

  const legs = plan.legs || [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.type === "walk") {
      if (!methods) continue;
      if (methods.has("walk")) continue;
      const dist =
        typeof leg.distance_meters === "number"
          ? leg.distance_meters
          : (leg.duration_seconds || 0) * 0.8;
      const secs =
        typeof leg.duration_seconds === "number" && leg.duration_seconds > 0
          ? leg.duration_seconds
          : dist / 0.8;
      const wtype = String(leg.walk_type || "").toLowerCase();
      // Final walk to destination (or explicit egress)
      const isEgress =
        i === legs.length - 1 ||
        wtype === "egress" ||
        wtype === "station_egress";
      // Destination is the stop/station → do not reject for “walk to destination”
      if (isEgress && destIsStation) {
        if (dist > 900) return false;
        continue;
      }
      if (isEgress && secs > MAX_EGRESS_SECS_WITHOUT_WALK) {
        return false;
      }
      // Origin is a station — allow station-scale access walks
      const isAccess =
        i === 0 || wtype === "access" || wtype === "station_access";
      if (isAccess && originIsStation) {
        if (dist > 900) return false;
        continue;
      }
      // Access / interchange walks — MTR deep stations often need 300–700 m.
      // 200 m was dropping valid AEL plans from Hong Kong (IFC) and Central dual-access.
      const isEdge =
        i === 0 ||
        i === legs.length - 1 ||
        // @ts-expect-error optional stitch flags
        leg.free_mtr_link ||
        // @ts-expect-error optional
        leg.indoor_interchange ||
        wtype.includes("station");
      const limit = isEdge ? 900 : 350;
      if (dist > limit) return false;
      continue;
    }
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    const method = classifyTrafficMethodId(opt);
    if (methods && method && method !== "other" && !methods.has(method)) {
      return false;
    }
    if (methods && method === "other") {
      // Unknown modes (ferry, tramways): allow if bus or mtr selected as fallback
      if (!methods.has("bus") && !methods.has("mtr") && !methods.has("ael")) {
        return false;
      }
    }
    if (cos && (method === "bus" || method === "gmb")) {
      // Joint / multi-operator routes (e.g. S1 CTB+KMB): allow if *any* co selected
      const multi = routeOptionCompanyIds(opt);
      if (multi.length) {
        if (!multi.some((c) => cos.has(c))) return false;
      } else {
        const co = classifyBusCompanyId(opt);
        if (co && !cos.has(co)) return false;
      }
    }
  }
  return true;
}

/** Heuristic: label/search hit looks like an MTR / rail station. */
export function looksLikeMtrStation(
  label?: string | null,
  meta?: { category?: string; type?: string; class?: string } | null,
): boolean {
  const cat = String(meta?.category || meta?.class || "").toLowerCase();
  const typ = String(meta?.type || "").toLowerCase();
  if (cat === "railway" && (typ === "station" || typ === "halt" || typ === "stop")) {
    return true;
  }
  if (typ === "station" && cat !== "amenity") return true;

  const s = String(label || "");
  if (!s) return false;
  if (/\bbus\s*(stop|station|terminus)|巴士|小巴|公共運輸交匯處/i.test(s)) {
    return false;
  }
  // Light Rail labels are not heavy-rail MTR (don't snap to TML centroids)
  if (/light\s*rail|輕鐵|\blrt\b/i.test(s)) return false;
  // LRT-only place names sharing a district with an MTR station
  if (
    /\b(hospital|ferry\s*pier|ferry|pier|town\s*centre|town\s*center|depot)\b|醫院|碼頭|市中心|車廠/i.test(
      s,
    ) &&
    !/\bmtr\b|港鐵/i.test(s)
  ) {
    return false;
  }
  if (/\bmtr\b|港鐵|地鐵|地铁/i.test(s)) return true;
  if (/\bstation\b|站/i.test(s)) return true;
  return false;
}

export function countTransfers(plan: Plan): number {
  const transitLegs = (plan.legs || []).filter((l) => l.type === "transit").length;
  return Math.max(0, transitLegs - 1);
}

export function totalWalkMeters(plan: Plan): number {
  let m = 0;
  for (const leg of plan.legs || []) {
    if (leg.type === "walk") {
      if (typeof leg.distance_meters === "number") {
        m += leg.distance_meters;
      } else if (typeof leg.duration_seconds === "number") {
        m += leg.duration_seconds * 0.8;
      }
    }
  }
  return Math.round(m);
}

type TransitKind = "mtr" | "bus" | "other";

function transitKind(leg: Leg): TransitKind | null {
  if (leg.type !== "transit") return null;
  const opt = leg.route_options?.[0];
  if (isMtrTransitOption(opt)) return "mtr";
  if (isBusTransitOption(opt)) return "bus";
  return "other";
}

export interface PlanBreakdown {
  transfer_count: number;
  bus_transfer_count: number;
  mtr_transfer_count: number;
  mixed_transfer_count: number;
  /** MTR↔MTR changes at former KCR–MTR style hubs (long walk). */
  kcr_mtr_legacy_interchange_count: number;
  walk_meters: number;
  mtr_only: boolean;
  /** Plan uses at least one MTR Light Rail leg. */
  has_lrt: boolean;
  has_bus: boolean;
  has_mtr: boolean;
  mtr_street_walk_count: number;
  mtr_station_transfer_walks: number;
  /** CEN↔HOK / TST↔ETS style free links used. */
  free_mtr_interchange_walks: number;
}

/**
 * Analyse a plan for mode-aware ranking.
 */
export function analyzePlan(plan: Plan): PlanBreakdown {
  const legs = plan.legs || [];
  let busTransfers = 0;
  let mtrTransfers = 0;
  let mixedTransfers = 0;
  let kcrMtrLegacy = 0;
  let mtrStreetWalks = 0;
  let mtrStationXferWalks = 0;
  let freeMtrInterchangeWalks = 0;
  let hasBus = false;
  let hasMtr = false;
  let hasLrt = false;
  let transitCount = 0;

  // Classify each transit leg and walks between them
  const kinds: (TransitKind | "walk" | "wait" | null)[] = legs.map((leg) => {
    if (leg.type === "walk") return "walk";
    if (leg.type === "wait") return "wait";
    return transitKind(leg);
  });

  for (let i = 0; i < legs.length; i++) {
    const k = kinds[i];
    if (k === "bus") hasBus = true;
    if (k === "mtr") hasMtr = true;
    if (k === "mtr" || k === "bus" || k === "other") transitCount += 1;
    if (legs[i].type === "transit") {
      const opt = legs[i].route_options?.[0];
      if (isLightRailOption(opt)) hasLrt = true;
    }
  }

  // Transfers = successive transit vehicles (ignoring waits; walks sit between)
  const transitIdx: number[] = [];
  kinds.forEach((k, i) => {
    if (k === "mtr" || k === "bus" || k === "other") transitIdx.push(i);
  });

  for (let t = 1; t < transitIdx.length; t++) {
    const prevI = transitIdx[t - 1];
    const nextI = transitIdx[t];
    const prevK = kinds[prevI] as TransitKind;
    const nextK = kinds[nextI] as TransitKind;
    if (prevK === "mtr" && nextK === "mtr") {
      mtrTransfers += 1;

      const prevLeg = legs[prevI];
      const nextLeg = legs[nextI];
      if (prevLeg.type === "transit" && nextLeg.type === "transit") {
        const fromOpt = prevLeg.route_options?.[0];
        const toOpt = nextLeg.route_options?.[0];
        // Interchange location: alight of first leg / board of second
        const fromStop = fromOpt?.to;
        const toStop = toOpt?.from;
        // Official free links (TST↔ETS, CEN↔HOK) are designed transfers — no legacy surcharge
        const walkBetween = legs
          .slice(prevI + 1, nextI)
          .filter((L) => L.type === "walk");
        const walkDist = walkBetween.reduce(
          (s, L) =>
            s +
            (typeof L.distance_meters === "number"
              ? L.distance_meters
              : (L.duration_seconds || 0) * 0.8),
          0,
        );
        if (
          !isFreeMtrInterchangeWalk(fromStop, toStop, walkDist) &&
          isLegacyKcrMtrInterchange(fromOpt, toOpt, fromStop, toStop)
        ) {
          kcrMtrLegacy += 1;
        }
      }
    } else if (prevK === "bus" && nextK === "bus") {
      busTransfers += 1;
    } else {
      mixedTransfers += 1;
    }

    // Walks between these two transit legs
    for (let j = prevI + 1; j < nextI; j++) {
      const leg = legs[j];
      if (leg.type !== "walk") continue;
      if (prevK === "mtr" && nextK === "mtr") {
        const wtype = String(leg.walk_type || "");
        const dist = leg.distance_meters ?? (leg.duration_seconds || 0) * 0.8;
        const secs = leg.duration_seconds || 0;
        const fromStop = legs[prevI]?.type === "transit"
          ? legs[prevI].route_options?.[0]?.to
          : undefined;
        const toStop = legs[nextI]?.type === "transit"
          ? legs[nextI].route_options?.[0]?.from
          : undefined;
        const prevOpt =
          legs[prevI]?.type === "transit"
            ? legs[prevI].route_options?.[0]
            : null;
        const nextOpt =
          legs[nextI]?.type === "transit"
            ? legs[nextI].route_options?.[0]
            : null;
        const involvesLrt =
          isLightRailOption(prevOpt) || isLightRailOption(nextOpt);
        // LRT platforms are street-level; allow longer outdoor platform changes
        const shortXferDist = involvesLrt ? 450 : 250;
        const shortXferSecs = involvesLrt ? 420 : 240;

        // CEN↔HOK, TST↔ETS, MOK↔MKK — official free links (often 300–500 m)
        if (
          // dual-access stitched indoor link
          // @ts-expect-error optional annotation from stitchDualAccessPlan
          leg.free_mtr_link ||
          // @ts-expect-error optional
          leg.indoor_interchange ||
          isFreeMtrInterchangeWalk(fromStop, toStop, dist)
        ) {
          mtrStationXferWalks += 1;
          freeMtrInterchangeWalks += 1;
        } else if (
          wtype === "station_transfer" ||
          (dist <= shortXferDist && secs <= shortXferSecs)
        ) {
          // In-station / short LRT platform or paid-area transfer
          mtrStationXferWalks += 1;
        } else {
          // Long outdoor walk between MTR lines — discouraged
          mtrStreetWalks += 1;
        }
      }
    }
  }

  // Dual-access free links often sit before first transit (user at Central →
  // indoor walk to Hong Kong → TCL). Only count explicit stitch annotations.
  {
    let dualLinks = 0;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.type !== "walk") continue;
      // @ts-expect-error optional stitch annotations
      if (!(leg.free_mtr_link || leg.indoor_interchange)) continue;
      // Between two MTR already counted above
      if (kinds[i - 1] === "mtr" && kinds[i + 1] === "mtr") continue;
      // Must look like an official free pair (not a random walk flag)
      const dist = leg.distance_meters ?? 0;
      if (
        // @ts-expect-error optional
        leg.indoor_interchange ||
        isFreeMtrInterchangeWalk(leg.from, leg.to, dist)
      ) {
        dualLinks += 1;
      }
    }
    freeMtrInterchangeWalks += dualLinks;
    mtrStationXferWalks += dualLinks;
  }

  const mtrOnly = hasMtr && !hasBus;

  return {
    transfer_count: Math.max(0, transitCount - 1),
    bus_transfer_count: busTransfers,
    mtr_transfer_count: mtrTransfers,
    mixed_transfer_count: mixedTransfers,
    kcr_mtr_legacy_interchange_count: kcrMtrLegacy,
    walk_meters: totalWalkMeters(plan),
    mtr_only: mtrOnly,
    has_lrt: hasLrt,
    has_bus: hasBus,
    has_mtr: hasMtr,
    mtr_street_walk_count: mtrStreetWalks,
    mtr_station_transfer_walks: mtrStationXferWalks,
    free_mtr_interchange_walks: freeMtrInterchangeWalks,
  };
}

/**
 * Perceived human cost — lower is better.
 * Blends weights when multiple preferences are selected.
 */
export function perceivedCost(
  plan: Plan,
  ctx: RankContext = {},
  planIndex = 0,
): number {
  const b = analyzePlan(plan);
  const travel = plan.duration_seconds ?? 0;
  const prefs = normalizePreferences(ctx);
  const wantFast = prefs.has("fastest");
  const wantSimple = prefs.has("simplest");
  const wantCheap = prefs.has("cheapest");
  const n = prefs.size || 1;

  // Start from neutral mid weights, then pull toward each selected preference
  let wTime = 0.85;
  let wBusXfer = BUS_TRANSFER_PENALTY_SECONDS;
  let wMtrXfer = MTR_TRANSFER_PENALTY_SECONDS;
  let wMixed = MIXED_TRANSFER_PENALTY_SECONDS;
  let wWalkM = WALK_METER_PENALTY_SECONDS;
  let wFare = 0;
  let wTransfersExtra = 0;

  // Average contribution of each selected goal
  const acc = {
    time: 0,
    bus: 0,
    mtr: 0,
    mixed: 0,
    walk: 0,
    fare: 0,
    xferExtra: 0,
  };

  if (wantFast) {
    acc.time += 1.2;
    acc.bus += BUS_TRANSFER_PENALTY_SECONDS * 0.55;
    acc.mtr += MTR_TRANSFER_PENALTY_SECONDS * 0.7;
    acc.mixed += MIXED_TRANSFER_PENALTY_SECONDS * 0.65;
    acc.walk += WALK_METER_PENALTY_SECONDS * 0.9;
  }
  if (wantSimple) {
    acc.time += 0.5;
    acc.bus += BUS_TRANSFER_PENALTY_SECONDS * 1.85;
    acc.mtr += MTR_TRANSFER_PENALTY_SECONDS * 2.5;
    acc.mixed += MIXED_TRANSFER_PENALTY_SECONDS * 1.55;
    acc.walk += WALK_METER_PENALTY_SECONDS * 0.65;
    acc.xferExtra += 220;
  }
  if (wantCheap) {
    acc.time += 0.35;
    acc.bus += BUS_TRANSFER_PENALTY_SECONDS * 0.45;
    acc.mtr += MTR_TRANSFER_PENALTY_SECONDS * 0.55;
    acc.mixed += MIXED_TRANSFER_PENALTY_SECONDS * 0.5;
    acc.walk += WALK_METER_PENALTY_SECONDS * 0.45;
    acc.fare += 180; // ~3 min perceived cost per HKD
  }

  wTime = acc.time / n;
  wBusXfer = acc.bus / n;
  wMtrXfer = acc.mtr / n;
  wMixed = acc.mixed / n;
  wWalkM = acc.walk / n;
  wFare = acc.fare / n;
  wTransfersExtra = acc.xferExtra / n;

  let score =
    travel * wTime +
    b.bus_transfer_count * wBusXfer +
    b.mtr_transfer_count * wMtrXfer +
    b.mixed_transfer_count * wMixed +
    b.walk_meters * wWalkM +
    b.transfer_count * wTransfersExtra +
    b.mtr_station_transfer_walks * MTR_STATION_TRANSFER_WALK_PENALTY +
    b.mtr_street_walk_count * MTR_STREET_WALK_PENALTY_SECONDS +
    (b.kcr_mtr_legacy_interchange_count || 0) * KCR_MTR_LEGACY_INTERCHANGE_EXTRA -
    (b.free_mtr_interchange_walks || 0) * MTR_FREE_INTERCHANGE_BONUS_SECONDS;

  if (wantCheap && ctx.fareByIndex) {
    const fare = ctx.fareByIndex[planIndex];
    if (fare != null && Number.isFinite(fare) && fare >= 0) {
      score += fare * wFare;
    } else {
      // Unsure / incomplete fares must not win "least fare" ranking
      score += 50_000;
    }
  }

  const bothMtr = !!(ctx.originIsMtr && ctx.destIsMtr);

  if (bothMtr) {
    if (b.mtr_only) {
      score -= MTR_NETWORK_BONUS_SECONDS * (wantFast ? 1 : 0.75);
    } else if (b.has_bus && !b.has_mtr) {
      score += MTR_AVOID_BUS_PENALTY_SECONDS;
    } else if (b.has_bus && b.has_mtr) {
      score += MTR_AVOID_BUS_PENALTY_SECONDS * 0.5;
    }
  }

  // Prefer Light Rail when it appears (feeder / NWNT local) over pure bus
  if (b.has_lrt) {
    score -= LRT_NETWORK_BONUS_SECONDS;
    if (b.has_bus && b.bus_transfer_count > 0) {
      score -= 60;
    }
  }

  // Non-MTR trip: still punish multi-bus hops (unless fare-only preference)
  if (!bothMtr && b.bus_transfer_count > 0 && !(wantCheap && !wantFast && !wantSimple)) {
    score += b.bus_transfer_count * 120;
  }

  const hasAel = planHasAel(plan);

  // Soft boost when user multi-selected specific methods (all-on = no bias)
  if (ctx.trafficMethods?.length && ctx.trafficMethods.length < 6) {
    const want = new Set(ctx.trafficMethods);
    if (want.has("lrt") && b.has_lrt) score -= 90;
    if (want.has("mtr") && b.has_mtr) score -= 60;
    if (want.has("ael") && hasAel) score -= 200;
  }

  // Airport Express corridor: prefer AEL over A-bus when times are close.
  // HOK↔AIR bus can beat AEL by ~2–3 min wall-clock but is worse door-to-door.
  if (hasAel) {
    score -= 180;
    if (wantCheap) {
      // AEL is expensive — still keep it visible unless user only wants fare
      score += 40;
    }
  } else if (planTouchesAelCorridor(plan) && b.has_bus && !b.has_mtr) {
    // Pure airport bus when AEL exists as an option — mild penalty so AEL ranks up
    score += 90;
  }

  // Impossible pedestrian harbour crossing (not ferry / MTR tunnel)
  const xh = countCrossHarbourWalks(plan);
  if (xh > 0) {
    score += xh * CROSS_HARBOUR_WALK_PENALTY_SECONDS;
  }

  return score;
}

/**
 * HK night-bus short names: N182, NA11, N8X, N960P, …
 * Does not match company code "NLB" (no digit after N + optional letter),
 * nor residents' services (NR330 etc. are RBS, not overnight routes).
 */
export function isNightBusRouteName(name?: string | null): boolean {
  const s = String(name || "")
    .trim()
    .toUpperCase();
  if (!s) return false;
  // Bare short name, or embedded after agency/id separators (KMB-N182, …/N11)
  if (/^N(?!R\d)[A-Z]?\d/.test(s)) return true;
  if (/(?:^|[^A-Z0-9])N(?!R\d)[A-Z]?\d/.test(s)) return true;
  return false;
}

/** True if any transit leg’s primary option is a night bus (N-prefix). */
export function planUsesNightBus(plan: Plan): boolean {
  for (const leg of plan.legs || []) {
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    if (!opt) continue;
    const fields = [
      opt.route_short_name,
      opt.route_name,
      opt.route_long_name,
      opt.route_id,
    ];
    for (const f of fields) {
      if (isNightBusRouteName(f)) return true;
    }
  }
  return false;
}

/**
 * Night service window: 00:00–05:59 on the service-day clock embedded in
 * depart_at. wheels-router-nano treats the ISO time face as GTFS local time
 * (not real UTC), so we read the hour from the string — not via timezone math.
 */
export function isHongKongNightWindow(departIso: string): boolean {
  try {
    const m = /T(\d{1,2}):/.exec(String(departIso || ""));
    if (!m) return false;
    let hour = Number(m[1]);
    if (hour === 24) hour = 0;
    return hour >= 0 && hour < 6;
  } catch {
    return false;
  }
}

/**
 * Re-rank WASM multi-route results with bus/MTR-aware rules.
 * Cross-harbour walks are never returned (impossible on foot).
 */
export function rankPlansHumanCentric(
  plans: Plan[],
  ctx: RankContext = {},
): Plan[] {
  if (!plans?.length) return [];

  // Drop harbour walks + plans that violate mode/company multi-select filters
  // Keep original pool index so fareByIndex stays aligned
  const destIsStation = !!(ctx.destIsStation ?? ctx.destIsMtr);
  const originIsStation = !!(ctx.originIsStation ?? ctx.originIsMtr);
  const viableIndexed = plans
    .map((plan, poolIndex) => ({ plan, poolIndex }))
    .filter(({ plan }) => {
      if (planHasCrossHarbourWalk(plan)) return false;
      return planMatchesFilters(plan, ctx.trafficMethods, ctx.busCompanies, {
        destIsStation,
        originIsStation,
      });
    });
  if (viableIndexed.length < plans.length) {
    console.info(
      "[router] dropped",
      plans.length - viableIndexed.length,
      "plan(s) (harbour walk and/or mode/company filters)",
      viableIndexed.length ? "" : "(none left)",
    );
  }
  if (!viableIndexed.length) return [];

  const prefs = normalizePreferences(ctx);
  const wantCheap = prefs.has("cheapest");

  const scored = viableIndexed.map(({ plan, poolIndex }) => {
    const b = analyzePlan(plan);
    const human_score = perceivedCost(plan, ctx, poolIndex);
    const fareVal =
      ctx.fareByIndex && poolIndex < ctx.fareByIndex.length
        ? ctx.fareByIndex[poolIndex]
        : null;
    const fareKnown =
      fareVal != null && Number.isFinite(fareVal) && fareVal >= 0;
    return {
      ...plan,
      transfer_count: b.transfer_count,
      bus_transfer_count: b.bus_transfer_count,
      mtr_transfer_count: b.mtr_transfer_count,
      kcr_mtr_legacy_interchange_count: b.kcr_mtr_legacy_interchange_count,
      walk_meters: b.walk_meters,
      mtr_only: b.mtr_only,
      free_mtr_interchange_walks: b.free_mtr_interchange_walks,
      human_score,
      _fareKnown: fareKnown,
      _fareTotal: fareKnown ? (fareVal as number) : null,
      is_recommended: false,
    };
  });

  scored.sort((a, b) => {
    // Least fare: never put unsure (incomplete/null) fares first
    if (wantCheap) {
      if (a._fareKnown !== b._fareKnown) return a._fareKnown ? -1 : 1;
      if (
        a._fareKnown &&
        b._fareKnown &&
        a._fareTotal != null &&
        b._fareTotal != null &&
        a._fareTotal !== b._fareTotal
      ) {
        return a._fareTotal - b._fareTotal;
      }
    }
    if (a.human_score !== b.human_score) {
      return (a.human_score ?? 0) - (b.human_score ?? 0);
    }
    if (prefs.has("simplest")) {
      if ((a.transfer_count ?? 0) !== (b.transfer_count ?? 0)) {
        return (a.transfer_count ?? 0) - (b.transfer_count ?? 0);
      }
    }
    // Prefer MTR-only when both ends are MTR
    if (ctx.originIsMtr && ctx.destIsMtr) {
      if (a.mtr_only !== b.mtr_only) return a.mtr_only ? -1 : 1;
    }
    // Prefer fewer bus transfers
    if ((a.bus_transfer_count ?? 0) !== (b.bus_transfer_count ?? 0)) {
      return (a.bus_transfer_count ?? 0) - (b.bus_transfer_count ?? 0);
    }
    // Prefer less walking
    if ((a.walk_meters ?? 0) !== (b.walk_meters ?? 0)) {
      return (a.walk_meters ?? 0) - (b.walk_meters ?? 0);
    }
    if (a.duration_seconds !== b.duration_seconds) {
      return a.duration_seconds - b.duration_seconds;
    }
    return String(a.start_time || "").localeCompare(String(b.start_time || ""));
  });

  if (scored.length) scored[0].is_recommended = true;
  // Strip internal ranking fields
  return scored.map(({ _fareKnown, _fareTotal, ...rest }) => rest as Plan);
}

/**
 * Plans a journey using WASM RAPTOR, then applies human-centric ranking.
 * Retries when the only candidates were impossible harbour walks so transit
 * (MTR/bus) can surface — e.g. Central ↔ Austin.
 *
 * When origin/destination is Central or Hong Kong Station (or nearby), also
 * plans from the paired station so TCL/AEL and ISL/TWL options both appear.
 */
export function planTrip(query: RouteQuery): PlanResponse {
  if (!routerInstance) {
    throw new Error("Router instance not initialized. Call initRouter() first.");
  }

  const displayMax = query.maxResults ?? 5;
  const bothMtr = !!(query.originIsMtr && query.destIsMtr);
  const lrtArea =
    isLrtCatchment(query.origin[0], query.origin[1]) ||
    isLrtCatchment(query.destination[0], query.destination[1]);
  const prefsList =
    query.preferences?.length
      ? query.preferences
      : query.preference
        ? [query.preference]
        : (["fastest"] as Array<"fastest" | "simplest" | "cheapest">);
  const ctx: RankContext = {
    originIsMtr: query.originIsMtr,
    destIsMtr: query.destIsMtr,
    // Station/stop OD → Walk-off still shows plans (no long “walk to destination”)
    originIsStation: !!(query.originIsStation ?? query.originIsMtr),
    destIsStation: !!(query.destIsStation ?? query.destIsMtr),
    preferences: prefsList,
    trafficMethods: query.trafficMethods,
    busCompanies: query.busCompanies,
  };

  const modes =
    query.modes ||
    ROUTER_MODES;

  const depart = query.departAt || new Date().toISOString();
  const nightWindow = isHongKongNightWindow(depart);
  const baseWalk = query.maxWalkDistance ?? DEFAULT_MAX_WALK_DISTANCE;
  // LRT journeys often need 2–3 line changes within the Light Rail network
  const baseTransfers = bothMtr
    ? Math.max(query.maxTransfers ?? 3, 4)
    : lrtArea
      ? Math.max(query.maxTransfers ?? 3, 5)
      : (query.maxTransfers ?? 3);
  const speed = query.walkingSpeed ?? DEFAULT_WALKING_SPEED;

  // Dual-access: Central ↔ Hong Kong (and TST ↔ ETS) boarding options
  // origins[0] / dests[0] are always the user's actual pins
  const origins = expandAccessPoints(
    query.origin[0],
    query.origin[1],
    query.originLabel,
    !!query.originIsMtr,
  );
  const dests = expandAccessPoints(
    query.destination[0],
    query.destination[1],
    query.destLabel,
    !!query.destIsMtr,
  );
  const primaryOrigin = origins[0];
  const primaryDest = dests[0];
  if (origins.length > 1 || dests.length > 1) {
    console.info(
      "[router] dual-access origins",
      origins.map((p) => p.name || p.code || "pin").join("|"),
      "dests",
      dests.map((p) => p.name || p.code || "pin").join("|"),
    );
  }

  type WalkSpeed = NonNullable<RouteQuery["walkingSpeed"]>;
  const attempts: Array<{
    max_results: number;
    max_transfers: number;
    max_walk_distance: number;
    walking_speed: WalkSpeed;
  }> = bothMtr
    ? [
        {
          max_results: Math.max(displayMax * 4, 20),
          max_transfers: Math.max(baseTransfers, 5),
          max_walk_distance: Math.min(baseWalk, 900),
          walking_speed: speed,
        },
        {
          max_results: Math.max(displayMax * 4, 20),
          max_transfers: 6,
          max_walk_distance: Math.min(Math.max(baseWalk, 1200), 1400),
          walking_speed: speed,
        },
        {
          max_results: 25,
          max_transfers: 6,
          max_walk_distance: Math.min(baseWalk, 1600),
          walking_speed: "normal",
        },
      ]
    : lrtArea
      ? [
          // Wider candidate pool so multi-leg Light Rail is not crowded out by buses
          {
            max_results: Math.max(displayMax * 4, 24),
            max_transfers: Math.max(baseTransfers, 5),
            max_walk_distance: Math.min(Math.max(baseWalk, 800), 1200),
            walking_speed: speed,
          },
          {
            max_results: 28,
            max_transfers: 6,
            max_walk_distance: Math.min(Math.max(baseWalk, 1000), 1500),
            walking_speed: "normal",
          },
        ]
      : [
          {
            max_results: Math.max(displayMax, Math.min(15, displayMax * 3)),
            max_transfers: baseTransfers,
            max_walk_distance: baseWalk,
            walking_speed: speed,
          },
          {
            max_results: 20,
            max_transfers: Math.max(baseTransfers, 4),
            max_walk_distance: Math.min(baseWalk, 1000),
            walking_speed: speed,
          },
        ];

  /** Cap OD pairs so dual-access stays cheap (2×2 max for CEN/HOK). */
  const odPairs: Array<{ o: (typeof origins)[0]; d: (typeof dests)[0] }> = [];
  for (const o of origins.slice(0, 2)) {
    for (const d of dests.slice(0, 2)) {
      odPairs.push({ o, d });
    }
  }

  let ranked: Plan[] = [];
  for (const attempt of attempts) {
    /** @type {Plan[]} */
    const pooled: Plan[] = [];
    for (const { o, d } of odPairs) {
      const raw = routerInstance.plan({
        origin: `${o.lat},${o.lon}`,
        destination: `${d.lat},${d.lon}`,
        depart_at: depart,
        max_results: attempt.max_results,
        max_transfers: attempt.max_transfers,
        max_walk_distance: attempt.max_walk_distance,
        walking_speed: attempt.walking_speed,
        // Modes from traffic-method multi-select (fallback: full set)
        modes,
      }) as PlanResponse;
      for (const p of raw.plans || []) {
        // Stitch indoor free link when we planned from sibling station
        // (e.g. user at Central, plan from Hong Kong → prepend CEN→HOK walk)
        const stitched = stitchDualAccessPlan(
          p,
          primaryOrigin,
          o,
          primaryDest,
          d,
        );
        pooled.push({
          ...stitched,
          access_origin: o.name || o.code,
          access_dest: d.name || d.code,
        } as Plan);
      }
    }

    // Multi-operator shuttles missing from RAPTOR (e.g. S1 NEVER templates)
    const shuttles = injectShuttlePlans(query, pooled);
    if (shuttles.length) {
      pooled.push(...(shuttles as Plan[]));
    }

    // Prefer alight stop with name similar to destination (e.g. Station vs Cable
    // Car Terminal). Uses route patterns when RAPTOR alights one stop early.
    // Does not force bus terminus if dest matches MTR Station / Mei Tung bay.
    const destLat = query.destination?.[0];
    const destLon = query.destination?.[1];
    if (Number.isFinite(destLat) && Number.isFinite(destLon)) {
      const fixed = preferNameMatchedAlights(pooled, destLat, destLon, {
        destIsStation: !!(query.destIsStation ?? query.destIsMtr),
        destLabel: query.destLabel || "",
      });
      pooled.length = 0;
      pooled.push(...(fixed as Plan[]));
    }

    // Daytime: drop night-bus (N*) itineraries — GTFS often still exposes them
    // as "next" trips even for noon departures.
    let poolForRank = pooled;
    if (!nightWindow && pooled.length) {
      const dayOnly = pooled.filter((p) => !planUsesNightBus(p));
      if (dayOnly.length) {
        if (dayOnly.length < pooled.length) {
          console.info(
            "[router] dropped",
            pooled.length - dayOnly.length,
            "night-bus plan(s) (daytime departure)",
            depart,
          );
        }
        poolForRank = dayOnly;
      } else {
        console.info(
          "[router] all plans used night buses at daytime; suppressing N* results",
          depart,
        );
        // Prefer empty over wrong night buses during the day
        poolForRank = [];
      }
    }

    // Optional fare estimates when "cheapest" is among selected preferences
    const wantCheap =
      (query.preferences || []).includes("cheapest") ||
      query.preference === "cheapest";
    if (wantCheap && typeof query.fareEstimator === "function") {
      ctx.fareByIndex = poolForRank.map((p) => {
        try {
          return query.fareEstimator!(p);
        } catch {
          return null;
        }
      });
    } else {
      ctx.fareByIndex = undefined;
    }
    ranked = rankPlansHumanCentric(poolForRank, ctx);
    // Light dedupe of near-identical leg sequences
    ranked = dedupePlans(ranked);
    if (ranked.length) break;

    if (pooled.length > 0 && poolForRank.length === 0 && !nightWindow) {
      // Daytime: only night buses found — try next walk/transfer attempt
      console.info(
        "[router] retry after night-bus filter emptied pool",
        pooled.length,
        "raw plan(s); walk≤",
        attempt.max_walk_distance,
      );
    } else if (pooled.length > 0 && ranked.length === 0) {
      console.info(
        "[router] retry after harbour filter emptied",
        pooled.length,
        "raw plan(s); walk≤",
        attempt.max_walk_distance,
      );
    }
  }

  return { plans: ranked.slice(0, displayMax) };
}

/** Drop plans with the same transit route sequence + similar duration. */
function dedupePlans(plans: Plan[]): Plan[] {
  const seen = new Set<string>();
  const out: Plan[] = [];
  for (const p of plans) {
    const key = (p.legs || [])
      .map((l) => {
        if (l.type === "transit") {
          const o = l.route_options?.[0];
          return `T:${o?.route_short_name || o?.route_name || o?.route_id || "?"}`;
        }
        if (l.type === "walk") {
          return `W${Math.round((l.distance_meters || 0) / 80)}`;
        }
        return l.type;
      })
      .join(">");
    const bucket = `${key}|${Math.round((p.duration_seconds || 0) / 90)}`;
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    out.push(p);
  }
  return out;
}

// ── internals ────────────────────────────────────────────────────────────────

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function fetchGraphBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Failed to download router graph (${url}): ${response.status} ${response.statusText}`,
    );
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Gzip graph requires DecompressionStream support");
    }
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  if (raw.byteLength < 64) {
    throw new Error(`Router graph too small (${raw.byteLength} bytes) from ${url}`);
  }

  return raw;
}
