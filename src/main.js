import {
  Map as MapLibreMap,
  Marker,
  Popup,
  NavigationControl,
  GeolocateControl,
  ScaleControl,
  AttributionControl,
  addProtocol,
  setWorkerUrl,
  getWorkerUrl,
  LngLatBounds,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { initAcrylic } from "./acrylic.js";
import { loadStaticOverrides } from "./overrides.js";
import { fetchDataJson } from "./offlineCache.js";
import { createPathContributor } from "./contributePath.js";

import { applyAccessPinOverrides } from "./mtrStations.js";
import {
  initRouter,
  planTrip,
  isRouterReady,
  getRouterStats,
  looksLikeMtrStation,
  ROUTER_MODES,
} from "./router.ts";
import {
  searchPlaces,
  reverseGeocode,
  getCurrentPosition,
  parseSearchModeFilter,
} from "./geocode.js";
import {
  loadRoutePreferences,
  saveRoutePreferences,
  formatPreferencesLabel,
  loadBusCompanies,
  saveBusCompanies,
  formatBusCompaniesLabel,
  loadTrafficMethods,
  saveTrafficMethods,
  formatTrafficMethodsLabel,
  routerModesFromTrafficMethods,
  isBusCompany,
  isTrafficMethod,
  loadServiceDay,
  saveServiceDay,
  formatServiceDayLabel,
  departAtForServiceDay,
  isServiceDay,
  loadDepartTime,
  saveDepartTime,
  formatDepartTimeLabel,
  formatServiceClock,
  getHongKongParts,
  isDepartTimeHm,
  parseDepartTimeHm,
  hongKongHmString,
  DATA_UPDATED_AT_STORAGE_KEY,
  loadDataCachePref,
  saveDataCachePref,
  loadDataSourcePref,
  saveDataSourcePref,
  loadLiveBusPref,
  saveLiveBusPref,
  loadLiveBusMorePref,
  saveLiveBusMorePref,
  loadBetaBannerPref,
  saveBetaBannerPref,
} from "./preferences.js";
import {
  t,
  initLang,
  applyLangToDom,
  getLang,
  setLang,
  LANG_META,
  waitZhMap,
  stationDisplayName,
  stopDisplayName,
  localizeStopName,
  localizeDirLabel,
  simplifyZh,
} from "./lang.js";
import { resolveRouteColor, detectMtrLineCode, normalizeHex } from "./mtrColors.js";
import {
  initFares,
  estimatePlanFare,
  formatPlanFare,
  formatFarePartAmount,
  FARE_TYPE_HINTS,
  FARE_TYPE_LABELS,
  loadFareType,
  setFareType,
  getFareType,
  formatFareTypeLabel,
  isFareType,
  loadEalFirstClass,
  setEalFirstClass,
  getEalFirstClass,
  loadRbsResidentFare,
  setRbsResidentFare,
  getRbsResidentFare,
  getFarePack,
  formatHkd,
  estimateBusBoardFare,
  estimateBusBoardToTerminusByStop,
} from "./fares.js";
import {
  searchMtrStationsLocal,
  snapToMtrStation,
  mergeStationDirectory,
  MTR_STATIONS,
} from "./mtrStations.js";
import {
  LRT_STOPS,
  matchLrtStop,
  lrtStopToHit,
  applyLrtStopOverrides,
} from "./lrtStops.js";
import {
  loadMtrGeo,
  addMtrLayers,
  featurePopupHtml,
  setRouteStationCodes,
  stationCodeFromName,
  resolvePlatformForStop,
  stationsFromGeoJson,
  relocalizeMapLabels,
} from "./mtrLayer.js";
import {
  buildTransitPolyline,
  projectStops,
  sliceRouteBetweenStops,
} from "./routeSnapper.js";
import {
  matchBusShapeOverride,
  matchBusShapeForRoute,
  applyVisualStopsFromShape,
  busShapeToPolyline,
} from "./busShapes.js";
import { canonicalLivePosOp, isJointHarbourRoute } from "./busPositionEngine.js";
import {
  isIndoorMtrInterchangeWalk,
  isFreeMtrInterchangeWalk,
  isSameMtrStation,
  isCrossStationInterchange,
} from "./mtrInterchange.js";
import {
  fetchPlanBoardEtas,
  fetchBoardEta,
  buildPlanStopTimes,
  formatWaitMins,
  waitMinutesFromIso,
  formatHkClock,
  formatUpdatedAgo,
  stationNameWithPlatforms,
  stationBaseName,
  etaOperatorShowsPlatform,
  scheduledSlotFromPlanLeg,
  scheduledSlotsFromPlanLeg,
  etaOperator,
  stripOperatorStopId,
  hasLiveEtaSlots,
  mergeLiveWithTimetable,
  headwayTimetableSlots,
  defaultHeadwayMins,
  expandTimetableSlots,
  withScheduledFallback,
  resolveBrowseEta,
  isTypicalServiceWindow,
  stopOffsetMinutesFromBoard,
} from "./eta.js";
import {
  ensureMtrBusData,
  getMtrBusRoutes,
  mtrBusRouteIds,
  mtrBusRouteDirections,
  mtrBusStopSequence,
  nearbyMtrBusStops,
} from "./mtrBusData.js";
import {
  MTR_LINE_ORDER,
  MTR_LINE_NAMES,
  mtrLineDirections,
  mtrLineCodesInOrder,
  mtrResolveBranch,
  mtrStationLabel,
} from "./mtrLineOrder.js";
import {
  ensureLrtRouteData,
  lrtRouteDirections,
  lrtStopSequence,
} from "./lrtRouteData.js";
import {
  ensureGmbRouteCodes,
  ensureGmbRouteDirections,
  gmbRouteDirectionsSync,
  loadGmbStopSequence,
} from "./gmbRouteData.js";
import {
  mergeStopSequence,
  extractPublicStopCode,
  stopLabelWithPublicId,
} from "./stopMerge.js";
import { isOnboarded, startOnboarding } from "./onboarding.js";
import "./style.css";

// Sayram acrylic cursor lighting (Morgandev design system)
initAcrylic();

// Persisted language → <html lang> + static DOM before first paint
initLang();
applyLangToDom();

/**
 * Resolves once the splash cover has fully left the screen — work that must
 * not run over the opening animation (e.g. the location permission prompt)
 * chains onto this promise.
 */
let resolveBootSplashDone = () => {};
const bootSplashDonePromise = new Promise((resolve) => {
  resolveBootSplashDone = resolve;
});

// First-run onboarding: the wizard renders immediately but sits BEHIND the
// boot splash (z-index 9990 < 9999), so the opening animation plays on top of
// it and the flow is already in view the moment the splash leaves. The app
// keeps initializing underneath; the geolocation prompt below waits for both
// the splash and this gate. Finishing bounces the page once (fresh prefs and
// any downloaded dataset only take effect on a new session), and the wizard's
// “Download Offline Data” button reuses the Settings download pipeline.
const onboardingGate = isOnboarded()
  ? Promise.resolve()
  : startOnboarding({
      firstRun: true,
      onComplete: () => {
        try {
          window.location.reload();
        } catch {
          /* ignore */
        }
      },
      downloadOffline: async () => {
        let sw = navigator.serviceWorker?.controller;
        if (!sw) {
          // First visit: the SW registers at window load and claims the page
          // on activation — wait briefly, then fall back to the active worker.
          try {
            const reg = await Promise.race([
              navigator.serviceWorker.ready,
              new Promise((_, reject) =>
                window.setTimeout(() => reject(new Error("sw timeout")), 5000),
              ),
            ]);
            sw = reg.active || null;
          } catch {
            sw = null;
          }
        }
        if (!sw) return false; // wizard shows the inline “reload once” hint
        // Downloading implies caching stays on — mirror the Settings button.
        saveDataCachePref(true);
        notifyDataCachePref();
        await startOfflineDownload(sw);
        return true;
      },
    });

// Hand-maintained static overrides (public/overrides/*) — never from collect pipeline
loadStaticOverrides()
  .then(() => {
    applyLrtStopOverrides();
    applyAccessPinOverrides();
  })
  .catch((err) => console.warn("[overrides]", err));
applyAccessPinOverrides();

/**
 * MapLibre v6 module worker must load from a URL where sibling
 * maplibre-gl-shared.mjs resolves. Vite's prebundle breaks the default
 * import.meta.url derivation — pin to public/maplibre/* instead.
 */
const workerUrl = new URL(
  `${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`,
  window.location.href,
).href;
setWorkerUrl(workerUrl);
console.info("[maplibre] worker →", getWorkerUrl());
console.info("[coi] crossOriginIsolated =", window.crossOriginIsolated);
console.info(
  "[pwa] display-mode →",
  matchMedia("(display-mode: fullscreen)").matches
    ? "fullscreen (immersive)"
    : matchMedia("(display-mode: standalone)").matches
      ? "standalone"
      : "browser",
);

/** Public edge origin — in dev under COEP require-corp use same-origin /edge proxy */
const DATA_BASE = "https://hk-gtfsdata.morgandev.cc";
const useEdgeProxy =
  typeof window !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");
const EDGE = useEdgeProxy ? `${location.origin}/edge` : DATA_BASE;
const PMTILES_URL = `${EDGE}/hongkong.pmtiles`;
const METADATA_URL = `${EDGE}/metadata.json`;
const HK_CENTER = [114.1694, 22.3193];
const DEFAULT_ZOOM = 11;

// ── DOM ──────────────────────────────────────────────────────────────────────

// Dev servers deliberately unregister the service worker, so the data cache
// can never work there — flag the tab so it can't be mistaken for preview.
if (import.meta.env.DEV) {
  const banner = document.getElementById("dev-banner");
  if (banner) {
    banner.textContent = `DEV MODE — port ${location.port}: service worker disabled, no data cache. Use "npm run preview" (port 4173) to test caching.`;
    banner.hidden = false;
  }
}

const els = {
  app: document.getElementById("app"),
  metaStatus: document.getElementById("meta-status"),
  metaDetails: document.getElementById("meta-details"),
  gtfsSize: document.getElementById("gtfs-size-label"),
  pmtilesSize: document.getElementById("pmtiles-size-label"),
  btnGtfs: document.getElementById("btn-download-gtfs"),
  btnPmtiles: document.getElementById("btn-download-pmtiles"),
  btnPanel: document.getElementById("btn-panel-toggle"),
  panel: document.getElementById("side-panel"),
  toast: document.getElementById("toast"),
  linkMeta: document.getElementById("link-metadata"),
  routerStatus: document.getElementById("router-status"),
  inputOrigin: document.getElementById("input-origin"),
  inputDest: document.getElementById("input-dest"),
  suggestOrigin: document.getElementById("suggest-origin"),
  suggestDest: document.getElementById("suggest-dest"),
  btnUseLocation: document.getElementById("btn-use-location"),
  btnSwap: document.getElementById("btn-swap"),
  btnAddVia: document.getElementById("btn-add-via"),
  viaStack: document.getElementById("via-stack"),
  btnPickOrigin: document.getElementById("btn-pick-origin"),
  btnPickDest: document.getElementById("btn-pick-dest"),
  mapPickHint: document.getElementById("map-pick-hint"),
  btnPlanCta: document.getElementById("btn-plan-cta"),
  planResults: document.getElementById("plan-results"),
  // Shell: panel + sheets
  mainToolbar: document.getElementById("main-toolbar"),

  btnDetailOpen: document.getElementById("btn-detail-open"),
  btnDetailClose: document.getElementById("btn-detail-close"),
  detailTitle: document.getElementById("detail-title"),
  btnSettings: document.getElementById("btn-settings"),
  btnInfo: document.getElementById("btn-info"),
  btnLicenses: document.getElementById("btn-licenses"),
  btnTermsPrivacy: document.getElementById("btn-terms-privacy"),
  btnProfile: document.getElementById("btn-profile"),
  profileMenu: document.getElementById("profile-menu"),
  mapProfile: document.getElementById("map-profile"),
  sheetChrome: document.getElementById("sheet-chrome"),
  sheetGrabber: document.getElementById("sheet-grabber"),
  sheetTitleRow: document.getElementById("sheet-title-row"),
  appBottomNav: document.getElementById("app-bottom-nav"),
  btnNavSearch: document.getElementById("btn-nav-search"),
  appNavSearchWrap: document.getElementById("app-nav-search-wrap"),
  appNavSearchField: document.getElementById("app-nav-search-field"),
  settingsSheet: document.getElementById("settings-sheet"),
  infoSheet: document.getElementById("info-sheet"),
  licensesSheet: document.getElementById("licenses-sheet"),
  termsPrivacySheet: document.getElementById("terms-privacy-sheet"),
  sidebarPageSearch: document.getElementById("sidebar-page-search"),
  sidebarPageTrip: document.getElementById("sidebar-page-trip"),
  sidebarPageEtaRoute: document.getElementById("sidebar-page-eta-route"),
  sidebarPagePinned: document.getElementById("sidebar-page-pinned"),
  sidebarPageSettings: document.getElementById("sidebar-page-settings"),
  sidebarPageAbout: document.getElementById("sidebar-page-about"),
  mapBrandLogo: document.getElementById("map-brand-logo"),
  pinnedRouteBody: document.getElementById("pinned-route-body"),
  etaRouteDetailHead: document.getElementById("eta-route-detail-head"),
  etaRouteDetailBody: document.getElementById("eta-route-detail-body"),
  btnEtaRouteBack: document.getElementById("btn-eta-route-back"),
  tripDetailHead: document.getElementById("trip-detail-head"),
  tripDetailTimeline: document.getElementById("trip-detail-timeline"),
  inputEtaRoute: document.getElementById("input-eta-route"),
  etaSidebarPanel: document.getElementById("eta-sidebar-panel"),
  tripPlanSidebarPanel: document.getElementById("trip-plan-sidebar-panel"),
  etaRouteListSidebar: document.getElementById("eta-route-list-sidebar"),

  etaRouteActions: document.getElementById("eta-route-actions"),
  btnEtaRouteDetails: document.getElementById("btn-eta-route-details"),
  btnEtaPinRoute: document.getElementById("btn-eta-pin-route"),
  btnEtaPinned: document.getElementById("btn-eta-pinned"),
  toolbarPinnedLabel: document.getElementById("toolbar-pinned-label"),
  etaBottomChrome: document.getElementById("eta-sidebar-bottom-chrome"),
  etaRouteDetailChrome: document.getElementById("eta-route-detail-chrome"),
  subpageDetailChrome: document.getElementById("subpage-detail-chrome"),
  btnSubpageBack: document.getElementById("btn-subpage-back"),
  subpageBackLabel: document.getElementById("subpage-back-label"),
  btnSubpagePin: document.getElementById("btn-subpage-pin"),
  subpagePinLabel: document.getElementById("subpage-pin-label"),
  etaSidebarSearch: document.getElementById("eta-sidebar-search"),
  btnEtaSearchToggle: document.getElementById("btn-eta-search-toggle"),
  modeButtons: () =>
    Array.from(
      document.querySelectorAll(
        ".app-nav-tab[data-ui-mode], .toolbar-mode-btn[data-ui-mode]",
      ),
    ),
  navTabs: () => Array.from(document.querySelectorAll(".app-nav-tab[data-nav]")),
};

/*
 * Title-bar soft edge: hidden at the top of a page, fades in only when
 * content scrolls under it. Re-checked on every scroll (capture phase —
 * element scrolls don't bubble) and on page switches via setSidebarPage.
 */
const TOP_FADE_SCROLLERS = [
  ".detail-sidebar-body",
  ".eta-route-list-sidebar",
  ".panel-page-scroll",
  ".pinned-route-body",
  ".wheels-stop-panel",
  "#sidebar-page-trip",
];

function syncTopFade() {
  let on = false;
  const root = els.mainToolbar;
  const tripOpen = !!els.sidebarPageTrip && !els.sidebarPageTrip.hidden;
  const routeOpen =
    !!els.sidebarPageEtaRoute && !els.sidebarPageEtaRoute.hidden;
  if (root) {
    for (const el of root.querySelectorAll(TOP_FADE_SCROLLERS.join(","))) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest("[hidden]")) continue;
      // Inner pages own the scroll — ignore the outer body offset
      if (
        el.classList.contains("detail-sidebar-body") &&
        (tripOpen || routeOpen)
      ) {
        continue;
      }
      if (el.scrollTop > 4) {
        on = true;
        break;
      }
    }
  }
  els.app?.classList.toggle("is-scrolled", on);
}
document.addEventListener("scroll", syncTopFade, {
  capture: true,
  passive: true,
});
syncTopFade();

const ETA_PINNED_KEY = "morgan.etaPinnedRoutes";
/** @deprecated old single-route key — migrated on load */
const ETA_PINNED_KEY_LEGACY = "morgan.etaPinnedRoute";
/** Pinned trip plans (survive PWA reloads — localStorage). */
const PLAN_PINNED_KEY = "morgan.pinnedPlans";

/**
 * Pinned entry: route + boarding stop (+ visit index for circular multi-visit).
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: string,
 *   co?: string,
 *   stopId?: string,
 *   stopName?: string,
 *   stopNameEn?: string,
 *   bound?: string,
 *   dirIndex?: number,
 *   stopSeq?: number,
 *   stopIndex?: number,
 * }} PinnedEtaEntry
 */

/**
 * @param {PinnedEtaEntry | EtaRouteEntry} a
 * @param {PinnedEtaEntry | EtaRouteEntry} b
 */
function pinnedRouteSame(a, b) {
  if (!a || !b) return false;
  if (
    a.id !== b.id ||
    a.kind !== b.kind ||
    String(a.co || "") !== String(b.co || "")
  ) {
    return false;
  }
  // Prefer visit index when both pins know it (circular S64 etc.)
  const ai = a.stopIndex;
  const bi = b.stopIndex;
  if (
    Number.isFinite(Number(ai)) &&
    Number.isFinite(Number(bi)) &&
    Number(ai) >= 0
  ) {
    return (
      Number(ai) === Number(bi) &&
      String(a.bound || "") === String(b.bound || "")
    );
  }
  const as = a.stopSeq;
  const bs = b.stopSeq;
  if (Number.isFinite(Number(as)) && Number.isFinite(Number(bs))) {
    return (
      Number(as) === Number(bs) &&
      String(a.stopId || "") === String(b.stopId || "") &&
      String(a.bound || "") === String(b.bound || "")
    );
  }
  return (
    String(a.stopId || "") === String(b.stopId || "") &&
    String(a.stopName || "") === String(b.stopName || "") &&
    String(a.bound || "") === String(b.bound || "")
  );
}

/**
 * Snapshot pin fields for the currently selected stop on a route.
 * Includes stopSeq / stopIndex so circular multi-visits stay distinct.
 * @param {EtaRouteEntry} route
 * @param {{ stopId?: string, name?: string, nameEn?: string, seq?: number, stopIndex?: number } | null} [stop]
 * @returns {PinnedEtaEntry}
 */
function pinnedEntryFromRouteStop(route, stop = null) {
  const dirs = etaRouteDirections(route, { full: true });
  const di = Math.min(getCardDir(route), Math.max(0, dirs.length - 1));
  const dir = dirs[di] || dirs[0];
  const live = etaLiveByKey.get(etaRouteKey(route));
  const board =
    stop ||
    (live?.stopId || live?.stopLabel
      ? {
          stopId: live.stopId,
          name: live.stopLabel,
          seq: live.stopSeq,
          stopIndex: live.stopIndex,
        }
      : null);
  const stopIndex =
    Number.isFinite(Number(board?.stopIndex))
      ? Number(board.stopIndex)
      : Number.isFinite(Number(etaDetailStopIndex))
        ? Number(etaDetailStopIndex)
        : undefined;
  const stopSeq =
    Number.isFinite(Number(board?.seq))
      ? Number(board.seq)
      : Number.isFinite(Number(board?.stopSeq))
        ? Number(board.stopSeq)
        : undefined;
  return {
    id: route.id,
    label: route.label,
    kind: route.kind,
    co: route.co,
    stopId: board?.stopId ? String(board.stopId) : "",
    stopName: board?.name || board?.stopName || "",
    stopNameEn: board?.nameEn || board?.stopNameEn || "",
    bound: dir?.bound || live?.bound || "",
    dirIndex: di,
    stopSeq,
    stopIndex,
  };
}

/**
 * @returns {PinnedEtaEntry[]}
 */
function loadPinnedEtaRoutes() {
  try {
    const raw = localStorage.getItem(ETA_PINNED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .filter((o) => o?.id)
          .map((o) => ({
            id: String(o.id),
            label: String(o.label || o.id),
            kind: o.kind || "bus",
            co: o.co || undefined,
            stopId: o.stopId ? String(o.stopId) : "",
            stopName: o.stopName ? String(o.stopName) : "",
            stopNameEn: o.stopNameEn ? String(o.stopNameEn) : "",
            bound: o.bound ? String(o.bound) : "",
            dirIndex: Number.isFinite(Number(o.dirIndex))
              ? Number(o.dirIndex)
              : 0,
            stopSeq: Number.isFinite(Number(o.stopSeq))
              ? Number(o.stopSeq)
              : undefined,
            stopIndex: Number.isFinite(Number(o.stopIndex))
              ? Number(o.stopIndex)
              : undefined,
          }));
      }
    }
    // Migrate legacy single pin
    const leg = localStorage.getItem(ETA_PINNED_KEY_LEGACY);
    if (leg) {
      const o = JSON.parse(leg);
      if (o?.id) {
        const one = {
          id: String(o.id),
          label: String(o.label || o.id),
          kind: o.kind || "bus",
          co: o.co || undefined,
          stopId: "",
          stopName: "",
          stopNameEn: "",
          bound: "",
          dirIndex: 0,
        };
        savePinnedEtaRoutes([one]);
        localStorage.removeItem(ETA_PINNED_KEY_LEGACY);
        return [one];
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * @param {PinnedEtaEntry[]} routes
 */
function savePinnedEtaRoutes(routes) {
  try {
    if (!routes?.length) {
      localStorage.removeItem(ETA_PINNED_KEY);
      return;
    }
    localStorage.setItem(
      ETA_PINNED_KEY,
      JSON.stringify(
        routes.map((r) => ({
          id: r.id,
          label: r.label,
          kind: r.kind,
          co: r.co || "",
          stopId: r.stopId || "",
          stopName: r.stopName || "",
          stopNameEn: r.stopNameEn || "",
          bound: r.bound || "",
          dirIndex: r.dirIndex ?? 0,
          stopSeq: r.stopSeq,
          stopIndex: r.stopIndex,
        })),
      ),
    );
  } catch {
    /* ignore quota */
  }
}

/**
 * Pinned trip plan entry (plan survives PWA reloads).
 * @typedef {{
 *   key: string,
 *   fromLabel: string,
 *   toLabel: string,
 *   plan: object,
 *   pinnedAt: number,
 * }} PinnedPlanEntry
 */

/**
 * @returns {PinnedPlanEntry[]}
 */
function loadPinnedPlans() {
  try {
    const raw = localStorage.getItem(PLAN_PINNED_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((e) => e && e.plan && e.key)
      : [];
  } catch {
    return [];
  }
}

/**
 * @param {PinnedPlanEntry[]} list
 */
function savePinnedPlans(list) {
  try {
    if (!list?.length) {
      localStorage.removeItem(PLAN_PINNED_KEY);
      return;
    }
    localStorage.setItem(PLAN_PINNED_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota */
  }
}

/** Attach GTFS zh/en names onto a stop-like object (does not bake .name). */
function attachGtfsNamesToStop(s, dir) {
  if (!s || typeof s !== "object" || !dir?.byId) return;
  const raw = String(s.stop_id || s.id || s.stopId || "").trim();
  if (!raw) return;
  const ids = [raw];
  const stripped = raw.replace(/^(KMB|CTB|NLB|GMB|LWB|NWFB)-/i, "");
  if (stripped !== raw) ids.push(stripped);
  else {
    for (const p of ["KMB-", "CTB-", "NLB-", "GMB-", "LWB-"]) ids.push(p + raw);
  }
  for (const id of ids) {
    const i = dir.byId.get(id);
    if (i == null) continue;
    const g = dir.list[i];
    if (g.name) {
      if (!s.nameEn) s.nameEn = g.name;
      if (!s.name_en) s.name_en = g.name;
    }
    if (g.nameZh) {
      s.nameTc = g.nameZh;
      s.name_tc = g.nameZh;
      s.name_zh = g.nameZh;
    }
    return;
  }
}

function bakeLocalizedStopName(s) {
  if (!s || typeof s !== "object") return;
  const disp = stopDisplayName(s);
  if (!disp) return;
  if (s.stop_name != null || "stop_name" in s) s.stop_name = disp;
  if (s.name != null || "name" in s) s.name = disp;
  if (s.label != null && (s.nameEn || s.name_en || s.nameTc || s.name_zh)) {
    s.label = disp;
  }
}

function walkPlanStops(plan, fn) {
  if (!plan || typeof plan !== "object") return;
  fn(plan.origin);
  fn(plan.destination);
  for (const v of plan.vias || []) fn(v);
  for (const v of plan.via_points || []) fn(v);
  for (const leg of plan.legs || []) {
    fn(leg.from);
    fn(leg.to);
    const opt = leg.route_options?.[0];
    if (opt) {
      fn(opt.from);
      fn(opt.to);
      for (const s of opt.stops || []) fn(s);
    }
  }
}

/**
 * Re-apply the current language to a plan copy (pinned trips keep the
 * language they were saved in). Does not write back to storage.
 */
async function relocalizePlanInPlace(plan) {
  if (!plan) return plan;
  let dir = null;
  try {
    const { loadGtfsStopDirectory } = await import("./routeShapes.js");
    dir = await loadGtfsStopDirectory();
  } catch {
    /* optional */
  }
  walkPlanStops(plan, (s) => {
    attachGtfsNamesToStop(s, dir);
    bakeLocalizedStopName(s);
  });
  const first = plan.legs?.find((l) => l.route_options?.[0]?.from)?.route_options?.[0]?.from;
  const lastOpt = [...(plan.legs || [])].reverse().find((l) => l.route_options?.[0]?.to);
  const last = lastOpt?.route_options?.[0]?.to;
  if (first) {
    plan.fromLabel = stopDisplayName(first) || first.stop_name || plan.fromLabel;
  } else if (plan.origin) {
    plan.fromLabel = stopDisplayName(plan.origin) || plan.origin.label || plan.fromLabel;
  }
  if (last) {
    plan.toLabel = stopDisplayName(last) || last.stop_name || plan.toLabel;
  } else if (plan.destination) {
    plan.toLabel = stopDisplayName(plan.destination) || plan.destination.label || plan.toLabel;
  }
  if (Array.isArray(plan.via_labels) && (plan.vias || plan.via_points)) {
    const pts = (plan.vias || plan.via_points || []).filter(Boolean);
    plan.via_labels = plan.via_labels.map((lab, i) => {
      const pt = pts[i];
      return (pt && stopDisplayName(pt)) || lab;
    });
  }
  return plan;
}

async function localizedPlanCopy(plan) {
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(plan));
  } catch {
    return plan;
  }
  await relocalizePlanInPlace(copy);
  return copy;
}

/** Stable identity for a plan: departure + per-leg route/stops. */
function planPinKey(p) {
  const head = p.start_time || "";
  const parts = (p.legs || []).map((leg) => {
    if (leg.type === "transit") {
      const opt = leg.route_options?.[0];
      const a = opt?.from?.stop_id ?? opt?.from?.id ?? "";
      const b = opt?.to?.stop_id ?? opt?.to?.id ?? "";
      return `t:${opt?.route_id || opt?.route_short_name || ""}:${a}:${b}`;
    }
    if (leg.type === "walk") {
      const a = leg.from?.stop_id ?? leg.from?.id ?? "";
      const b = leg.to?.stop_id ?? leg.to?.id ?? "";
      return `w:${a}:${b}`;
    }
    return `${leg.type || "?"}:${Math.round(leg.duration_seconds || 0)}`;
  });
  return `${head}|${parts.join(",")}`;
}

/**
 * @param {object} p
 * @returns {boolean}
 */
function isPlanPinned(p) {
  const key = planPinKey(p);
  return loadPinnedPlans().some((e) => e.key === key);
}

/**
 * Pin / unpin the current plan. Returns the new pinned state.
 * @param {object} p
 * @returns {boolean}
 */
function togglePinPlan(p) {
  const key = planPinKey(p);
  const list = loadPinnedPlans();
  const i = list.findIndex((e) => e.key === key);
  if (i >= 0) {
    list.splice(i, 1);
    savePinnedPlans(list);
    syncPinnedRouteToolbar();
    return false;
  }
  let stored;
  try {
    stored = JSON.parse(JSON.stringify(p));
  } catch {
    return false;
  }
  if (!stored) return false;
  delete stored.fare; // re-estimated on render with the current ticket type
  const ends = snapshotFormEndpoints();
  stored.origin = ends.origin;
  stored.destination = ends.destination;
  stored.vias = ends.vias;
  stored.fromLabel = ends.origin?.label || origin?.label || origin?.name || "";
  stored.toLabel =
    ends.destination?.label || destination?.label || destination?.name || "";
  list.push({ key, fromLabel: stored.fromLabel, toLabel: stored.toLabel, plan: stored, pinnedAt: Date.now() });
  savePinnedPlans(list);
  syncPinnedRouteToolbar();
  return true;
}

/**
 * Resolve board index on a circular-capable stop list.
 * Prefer stopIndex → stopSeq → first stopId/name match.
 * @param {Array<{ stopId?: string, name?: string, nameEn?: string, seq?: number }>} named
 * @param {{ stopId?: string, stopName?: string, name?: string, stopSeq?: number, stopIndex?: number, seq?: number } | null} pin
 * @returns {number}
 */
function resolveCircularBoardIndex(named, pin) {
  if (!named?.length) return 0;
  if (!pin) return 0;

  const wantIdx = Number(pin.stopIndex);
  const wantSeq = Number(pin.stopSeq ?? pin.seq);
  const sid = String(pin.stopId || "").trim();
  const name = String(pin.stopName || pin.name || pin.nameEn || "").trim();
  const pinKey = circularVisitKey({
    stopId: sid,
    name,
    nameEn: pin.nameEn || name,
  });

  const hitsId = [];
  const hitsName = [];
  for (let i = 0; i < named.length; i++) {
    if (sid && String(named[i].stopId || "") === sid) hitsId.push(i);
    if (pinKey && circularVisitKey(named[i]) === pinKey) hitsName.push(i);
  }
  // Same bay (identical stopId) first; else repeated name (inbound/outbound
  // platforms) so 2/2 is not collapsed onto 1/2.
  const hits = hitsId.length ? hitsId : hitsName;

  const idxOk =
    Number.isFinite(wantIdx) && wantIdx >= 0 && wantIdx < named.length;
  if (idxOk && (!hits.length || hits.includes(wantIdx))) return wantIdx;

  if (Number.isFinite(wantSeq)) {
    const inHits = hits.find((i) => Number(named[i].seq) === wantSeq);
    if (inHits != null) return inHits;
    const bySeq = named.findIndex((s) => Number(s.seq) === wantSeq);
    if (bySeq >= 0) return bySeq;
  }

  const session = Number(etaDetailStopIndex);
  if (hits.includes(session)) return session;

  const visitN = Number(pin.visitN);
  if (visitN >= 1) {
    const pool = hits.length ? hits : hitsName;
    const j = pool[visitN - 1];
    if (j != null) return j;
    if (visitN >= pool.length && pool.length) return pool[pool.length - 1];
  }

  if (hits.length) return hits[0];
  if (hitsName.length) return hitsName[0];
  return idxOk ? wantIdx : 0;
}

/**
 * Mark multi-visit stops on circular routes (same stopId or name).
 * @param {Array<{ stopId?: string, name?: string, nameEn?: string, seq?: number }>} named
 */
function circularVisitKey(s) {
  const n = etaDestKey(s?.nameEn || s?.name || "");
  if (n) return `n:${n}`;
  const id = String(s?.stopId || "").trim();
  return id ? `id:${id}` : "";
}

function annotateCircularVisits(named) {
  if (!named?.length) return named || [];
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const s of named) {
    const key = circularVisitKey(s);
    if (!key) continue;
    totals.set(key, (totals.get(key) || 0) + 1);
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  return named.map((s) => {
    const key = circularVisitKey(s);
    const total = totals.get(key) || 1;
    if (total <= 1) {
      return { ...s, visitN: 1, visitTotal: 1 };
    }
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return { ...s, visitN: n, visitTotal: total };
  });
}

/**
 * @param {EtaRouteEntry | PinnedEtaEntry} route
 * @param {{ stopId?: string, name?: string, nameEn?: string } | null} [stop]
 * @returns {boolean} true if now pinned
 */
function togglePinnedEtaRoute(route, stop = null) {
  if (!route) return false;
  const entry = stop
    ? pinnedEntryFromRouteStop(route, stop)
    : route.stopId != null || route.stopName
      ? /** @type {PinnedEtaEntry} */ (route)
      : pinnedEntryFromRouteStop(route, null);
  const list = loadPinnedEtaRoutes();
  const i = list.findIndex((r) => pinnedRouteSame(r, entry));
  if (i >= 0) {
    list.splice(i, 1);
    savePinnedEtaRoutes(list);
    return false;
  }
  list.push(entry);
  savePinnedEtaRoutes(list);
  return true;
}

/**
 * @param {EtaRouteEntry} route
 * @param {{ stopId?: string, name?: string } | null} [stop]
 */
function isRoutePinned(route, stop = null) {
  const entry = stop
    ? pinnedEntryFromRouteStop(route, stop)
    : pinnedEntryFromRouteStop(route, null);
  return loadPinnedEtaRoutes().some((r) => pinnedRouteSame(r, entry));
}

function syncPinnedRouteToolbar() {
  const routes = loadPinnedEtaRoutes();
  const trips = loadPinnedPlans();
  const btn = els.btnEtaPinned;
  const label = els.toolbarPinnedLabel;
  if (!btn) return;
  const total = routes.length + trips.length;
  btn.classList.toggle("has-pins", total > 0);
  if (label) label.textContent = t("Pinned");
  if (total > 0) {
    btn.disabled = false;
    if (routes.length === 1 && trips.length === 0) {
      const oneStop =
        routes[0].stopName || routes[0].stopId
          ? ` @ ${routes[0].stopName || routes[0].stopId}`
          : "";
      btn.title = `${t("Pinned")}: ${routes[0].id}${oneStop}`;
      btn.setAttribute(
        "aria-label",
        t("Open pinned {id}", { id: `${routes[0].id}${oneStop}` }),
      );
    } else if (trips.length === 0) {
      btn.title = `${t("Pinned")} (${routes.length})`;
      btn.setAttribute(
        "aria-label",
        t("Open {n} pinned stops", { n: routes.length }),
      );
    } else if (routes.length === 0) {
      btn.title = `${t("Pinned")} (${trips.length})`;
      btn.setAttribute("aria-label", t("Open {n} pinned trips", { n: trips.length }));
    } else {
      btn.title = `${t("Pinned")} (${total})`;
      btn.setAttribute("aria-label", t("Open {n} pinned items", { n: total }));
    }
  } else {
    btn.disabled = true;
    btn.title = t("Pin a route stop or trip plan");
    btn.setAttribute("aria-label", t("No pinned items"));
  }
  const pinBtn = els.btnEtaPinRoute;
  if (pinBtn && etaSelectedForDetails) {
    const live = etaLiveByKey.get(etaRouteKey(etaSelectedForDetails));
    const stop = live?.stopId || live?.stopLabel
      ? { stopId: live.stopId, name: live.stopLabel }
      : null;
    const on = isRoutePinned(etaSelectedForDetails, stop);
    pinBtn.classList.toggle("is-pinned", on);
    const row = pinBtn.querySelector(".btn-row span:last-child");
    if (row) row.textContent = on ? t("Pinned") : t("Pin stop");
  }
}

/**
 * Resolve pinned entry against catalog for full metadata (keeps stop pin fields).
 * @param {PinnedEtaEntry} pinned
 */
function resolvePinnedRouteEntry(pinned) {
  if (!pinned) return null;
  if (!etaRouteCatalog.length) buildEtaRouteCatalog();
  const cat =
    etaRouteCatalog.find(
      (r) =>
        r.id === pinned.id &&
        r.kind === pinned.kind &&
        (r.co || "") === (pinned.co || ""),
    ) || null;
  if (!cat) return pinned;
  return {
    ...cat,
    stopId: pinned.stopId || "",
    stopName: pinned.stopName || "",
    stopNameEn: pinned.stopNameEn || "",
    bound: pinned.bound || "",
    dirIndex: pinned.dirIndex ?? 0,
  };
}

/**
 * Open dedicated Pinned Routes page (plan-style cards).
 */
async function openPinnedRoutePage() {
  if (getUiMode() !== "eta") setUiMode("eta");
  setDetailOpen(true);
  setSidebarPage("pinned");
  await renderPinnedRoutePage();
}

/**
 * Stop-aware key for a pinned route card (same route @ different stops both pin).
 * @param {EtaRouteEntry & PinnedEtaEntry} r
 */
function pinnedRouteKey(r) {
  return `${etaRouteKey(r)}|${r.stopId || r.stopName || ""}`;
}

/** Resolved pinned entries backing the current Pinned Routes page. */
let pinnedRouteResolved = [];

/**
 * One pinned-route card — same compact chrome as Nearby/search cards, plus an
 * Unpin pill. Live ETA reuses the list-card pipeline (etaLiveByKey +
 * refreshCardLiveEta) so pins and nearby cards stay in sync.
 * @param {EtaRouteEntry & PinnedEtaEntry} r
 * @param {number} i
 */
function pinnedEtaCardHtml(r, i) {
  const live = etaLiveByKey.get(etaRouteKey(r));
  // The pin names its own board stop; shared live meta is only a fallback
  const boardLabel = etaBoardLabelClean(
    r.stopName || live?.stopLabel || r.nearbyHint || "",
  );
  const isRail = r.kind === "mtr" || r.kind === "lrt";
  // Rail only: drop “→ same station as board”. Buses keep operator OD as-is.
  let dirs = etaRouteDirections(r, { full: true });
  if (isRail) {
    dirs = etaFilterSameStationDirs(dirs, boardLabel, r);
    if (!dirs.length) dirs = etaRouteDirections(r, { full: true });
  }
  const di = resolveCardDirIndex(r, dirs);
  const dir = dirs[di] || dirs[0] || { dest: r.label };
  const wantB = String(dir.bound || "").toUpperCase();
  const liveB = String(live?.bound || "").toUpperCase();
  const liveForDir =
    live &&
    (dirs.length < 2 ||
      !wantB ||
      wantB === "LINE" ||
      wantB === "LRT" ||
      liveB === wantB ||
      (!liveB && dirs.length < 2));
  let useDir = dir;
  if (liveForDir && live?.dest) {
    // Rail: ignore live dest if it is the board terminus; buses always trust live
    if (
      !isRail ||
      !boardLabel ||
      !etaStationsMatch(live.destZh || live.dest, boardLabel)
    ) {
      useDir = {
        dest: live.dest,
        destZh: live.destZh || live.dest,
        bound: live.bound || dir.bound,
        branch: dir.branch,
      };
    }
  }
  if (
    isRail &&
    boardLabel &&
    etaStationsMatch(useDir.destZh || useDir.dest, boardLabel)
  ) {
    const alt = dirs.find(
      (d) => !etaStationsMatch(d.destZh || d.dest, boardLabel),
    );
    if (alt) useDir = alt;
  }
  return `<li role="option" class="eta-route-card pinned-route-card" data-pinned-key="${escapeHtml(pinnedRouteKey(r))}" data-route-key="${escapeHtml(etaRouteKey(r))}" style="--i:${i}" aria-selected="false">
    <div class="eta-route-card-body">
      ${etaRouteCardInnerHtml(
        r,
        useDir,
        {
          minutes: liveForDir ? live?.minutes : null,
          stopLabel: liveForDir
            ? r.stopName || live?.stopLabel || r.nearbyHint
            : r.nearbyHint,
          scheduled: liveForDir ? live?.scheduled : false,
          clock: liveForDir ? live?.clock : "",
          stopId: liveForDir ? live?.stopId || r.stopId : "",
          outsideService: liveForDir ? !!live?.outsideService : false,
          platforms: liveForDir ? live?.platforms : undefined,
        },
        { destLabel: etaDirectionDisplayLabel(dirs, useDir) },
      )}
    </div>
    <button type="button" class="btn eta-route-pin-btn is-pinned pinned-unpin-btn" data-pinned-unpin data-acrylic>
      <span class="btn-row">
        <span class="material-symbols-outlined" aria-hidden="true">keep_off</span>
        ${escapeHtml(t("Unpin"))}
      </span>
    </button>
  </li>`;
}

/**
 * Open route detail for a pinned card (pre-selects the pinned stop).
 * @param {EtaRouteEntry & PinnedEtaEntry} route
 */
function openPinnedRouteDetails(route) {
  if (!route) return;
  etaSelectedForDetails = route;
  etaSelectedStops = [];
  ++etaShapeGen;
  clearRouteGeometry();
  const live = etaLiveByKey.get(etaRouteKey(route)) || {};
  etaLiveByKey.set(etaRouteKey(route), {
    ...live,
    stopId: route.stopId || live.stopId,
    stopLabel: route.stopName || live.stopLabel,
  });
  setDetailOpen(true);
  syncEtaActive();
  if (els.etaRouteActions) els.etaRouteActions.hidden = true;
  syncPinnedRouteToolbar();
  const oldPanel = document.getElementById("eta-route-details-panel");
  if (oldPanel) oldPanel.remove();
  void showEtaRouteDetailsPanel();
}

/**
 * Bind one pinned card: tap → route detail; Unpin → remove + re-render.
 * @param {HTMLElement} li
 */
function bindPinnedRouteCardEvents(li) {
  const key = li.getAttribute("data-pinned-key");
  const findEntry = () =>
    pinnedRouteResolved.find((x) => pinnedRouteKey(x) === key);
  li.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openPinnedRouteDetails(findEntry());
  });
  li.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("button")) return;
    e.preventDefault();
    openPinnedRouteDetails(findEntry());
  });
  li.querySelector("[data-pinned-unpin]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const entry = findEntry();
    if (!entry) return;
    togglePinnedEtaRoute(entry);
    syncPinnedRouteToolbar();
    showToast(t("Unpinned {id}", { id: entry.id }), 1600);
    void renderPinnedRoutePage();
  });
}

/** @type {IntersectionObserver | null} */
let pinnedCardLiveObserver = null;

function teardownPinnedCardLiveObserver() {
  if (pinnedCardLiveObserver) {
    pinnedCardLiveObserver.disconnect();
    pinnedCardLiveObserver = null;
  }
}

/**
 * Live-refresh only pinned cards currently visible (same cadence/pattern as
 * the nearby list, reusing etaCardLiveLastAt / etaCardLiveInflight).
 */
function setupPinnedCardLiveObserver() {
  teardownPinnedCardLiveObserver();
  const list = els.pinnedRouteBody?.querySelector(".pinned-route-list");
  if (!list || typeof IntersectionObserver === "undefined") return;
  pinnedCardLiveObserver = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        const li = /** @type {HTMLElement} */ (ent.target);
        const r = pinnedRouteResolved.find(
          (x) => pinnedRouteKey(x) === li.getAttribute("data-pinned-key"),
        );
        if (r) void maybeRefreshPinnedCardLive(r, li);
      }
    },
    {
      root: list,
      rootMargin: "48px 0px",
      threshold: 0.12,
    },
  );
  list.querySelectorAll("li[data-pinned-key]").forEach((li) => {
    pinnedCardLiveObserver?.observe(li);
  });
}

/**
 * @param {EtaRouteEntry & PinnedEtaEntry} r
 * @param {HTMLElement} li
 */
async function maybeRefreshPinnedCardLive(r, li) {
  if (!r || !li?.isConnected) return;
  const key = etaRouteKey(r);
  const now = Date.now();
  const last = etaCardLiveLastAt.get(key) || 0;
  if (now - last < ETA_CARD_LIVE_MIN_MS) return;
  if (etaCardLiveInflight.has(key)) return;

  etaCardLiveInflight.add(key);
  etaCardLiveLastAt.set(key, now);
  try {
    const prev = etaLiveByKey.get(key);
    const prevSnap = prev
      ? `${prev.minutes}|${prev.dest || ""}|${prev.bound || ""}|${prev.scheduled ? 1 : 0}|${prev.stopLabel || ""}`
      : "";
    const ok = await refreshCardLiveEta(r, { silent: true });
    if (!ok) return;
    const next = etaLiveByKey.get(key);
    const nextSnap = next
      ? `${next.minutes}|${next.dest || ""}|${next.bound || ""}|${next.scheduled ? 1 : 0}|${next.stopLabel || ""}`
      : "";
    if (prevSnap === nextSnap) return;
    patchPinnedRouteCard(li);
  } finally {
    etaCardLiveInflight.delete(key);
  }
}

/**
 * Update one pinned card in-place (no full list wipe / no scroll jump).
 * @param {HTMLElement} li
 */
function patchPinnedRouteCard(li) {
  if (!li?.isConnected) return;
  const idx = pinnedRouteResolved.findIndex(
    (x) => pinnedRouteKey(x) === li.getAttribute("data-pinned-key"),
  );
  if (idx < 0) return;
  const tmp = document.createElement("ul");
  tmp.innerHTML = pinnedEtaCardHtml(pinnedRouteResolved[idx], idx);
  const next = tmp.firstElementChild;
  if (!next) return;
  li.replaceWith(next);
  bindPinnedRouteCardEvents(next);
  pinnedCardLiveObserver?.observe(next);
}



/**
 * Render all pinned routes as plan-style cards.
 */
async function renderPinnedRoutePage() {
  const body = els.pinnedRouteBody;
  if (!body) return;
  const pinnedPlans = loadPinnedPlans();
  const list = loadPinnedEtaRoutes();
  if (!pinnedPlans.length && !list.length) {
    body.innerHTML = `
      <div class="pinned-empty">
        <span class="material-symbols-outlined" aria-hidden="true">push_pin</span>
        <p>${escapeHtml(t("Nothing pinned yet"))}</p>
        <p class="hint">${escapeHtml(t("Pin trip plans from Plan Results, or open a route, pick a stop, then tap Pin."))}</p>
      </div>`;
    return;
  }

  const localizedPlans = await Promise.all(
    pinnedPlans.map(async (entry) => ({
      ...entry,
      plan: await localizedPlanCopy(entry.plan),
    })),
  );
  for (const entry of localizedPlans) {
    entry.fromLabel = entry.plan.fromLabel || entry.fromLabel;
    entry.toLabel = entry.plan.toLabel || entry.toLabel;
  }

  const parts = [];
  if (localizedPlans.length) {
    parts.push(`<h3 class="results-section-title">${escapeHtml(t("Pinned Trips"))}</h3>`);
    parts.push(
      localizedPlans
        .map((entry, i) =>
          planCardHtml(entry.plan, i, {
            pinned: true,
            planKey: entry.key,
            pinState: true,
            leastFareOn: false,
            originPt: { label: entry.fromLabel },
            destPt: { label: entry.toLabel },
          }),
        )
        .join(""),
    );
  }
  if (list.length) {
    parts.push(`<h3 class="results-section-title">${escapeHtml(t("Pinned Stops"))}</h3>`);
    parts.push(
      `<p class="hint" id="pinned-eta-loading" style="padding:12px">${escapeHtml(t("Loading {n} pinned stop{s}…", { n: list.length, s: list.length > 1 ? "s" : "" }))}</p>`,
    );
  }
  body.innerHTML = parts.join("");

  // Stagger card entrance after render (CSS uses --i)
  body.querySelectorAll(".plan-card").forEach((card, i) => {
    card.style.setProperty("--i", String(i));
  });

  // Pinned trip plans: open detail / unpin
  body.querySelectorAll("[data-pinned-plan]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const entry = localizedPlans.find(
        (x) => x.key === card.getAttribute("data-pinned-plan"),
      );
      if (entry) openTripDetailPage(entry.plan);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const entry = localizedPlans.find(
        (x) => x.key === card.getAttribute("data-pinned-plan"),
      );
      if (entry) openTripDetailPage(entry.plan);
    });
  });
  body.querySelectorAll("[data-pin-plan-detail]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const entry = localizedPlans.find(
        (x) => x.key === btn.getAttribute("data-pin-plan-detail"),
      );
      if (entry) openTripDetailPage(entry.plan);
    });
  });
  body.querySelectorAll("[data-pin-plan-unpin]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const entry = pinnedPlans.find(
        (x) => x.key === btn.getAttribute("data-pin-plan-unpin"),
      );
      if (!entry) return;
      savePinnedPlans(loadPinnedPlans().filter((x) => x.key !== entry.key));
      showToast(t("Trip plan unpinned"), 1600);
      void renderPinnedRoutePage();
    });
  });

  if (!list.length) {
    teardownPinnedCardLiveObserver();
    clearRouteGeometry();
    return;
  }

  // Resolve pins against the catalog; ensure direction tables so cards render
  // real destinations (all cached after first load, so this is fast on re-entry)
  const resolved = list.map((p) => resolvePinnedRouteEntry(p)).filter(Boolean);
  const needCtb = [];
  const needGmb = [];
  let needNlb = false;
  let needLrt = false;
  let needMtrBus = false;
  let needKmb = false;
  let needMtr = false;
  for (const r of resolved) {
    const co = String(r.co || "").toLowerCase();
    if (co === "ctb") needCtb.push(r.id);
    else if (co === "nlb") needNlb = true;
    else if (co === "gmb") needGmb.push(r.id);
    if (r.kind === "lrt") needLrt = true;
    if (r.kind === "mtr_bus" || co === "lrtfeeder" || co === "mtrbus") {
      needMtrBus = true;
    }
    if (r.kind === "mtr") needMtr = true;
    if (r.kind === "bus") needKmb = true;
  }
  try {
    // Shared datasets in parallel; per-route fetches (CTB/GMB) sequential
    await Promise.all([
      ...(needNlb ? [ensureNlbRouteBounds()] : []),
      ...(needLrt ? [ensureLrtRouteData()] : []),
      ...(needMtrBus ? [ensureMtrBusData()] : []),
      ...(needMtr ? [ensureMtrStationLinesMap()] : []),
      ...(needKmb ? [ensureKmbRouteBounds()] : []),
    ]);
    for (const id of needCtb) await ensureCtbRouteBound(id);
    for (const id of needGmb) await ensureGmbRouteDirections(id);
  } catch (e) {
    console.warn("[pinned] dirs", e);
  }

  // No route shape on pinned / stop pages
  clearRouteGeometry();
  pinnedRouteResolved = resolved;
  resolved.forEach((r) => {
    if (Number.isFinite(Number(r.dirIndex))) {
      setCardDir(r, Number(r.dirIndex));
    }
    // Seed live meta so cards show the pinned stop + bound immediately
    const key = etaRouteKey(r);
    const prev = etaLiveByKey.get(key) || {};
    const stopLabel = etaBoardLabelClean(r.stopName || "");
    etaLiveByKey.set(key, {
      ...prev,
      stopId: r.stopId || prev.stopId,
      stopLabel: stopLabel || prev.stopLabel,
      bound: r.bound || prev.bound,
    });
    if (!r.nearbyHint && stopLabel) r.nearbyHint = stopLabel;
  });
  if (resolved[0]) {
    etaSelectedForDetails = resolved[0];
    etaSelectedStops = [];
  }

  const etaHtml =
    `<ul class="eta-route-list-sidebar pinned-route-list" role="listbox" aria-label="${escapeHtml(t("Pinned stops"))}">` +
    resolved.map((r, i) => pinnedEtaCardHtml(r, i)).join("") +
    `</ul>` +
    `<p class="hint pinned-foot">${escapeHtml(t("{n} pinned stop{s}", { n: resolved.length, s: resolved.length > 1 ? "s" : "" }))}</p>`;
  const loadingEl = body.querySelector("#pinned-eta-loading");
  if (loadingEl) loadingEl.outerHTML = etaHtml;
  else body.innerHTML += etaHtml;

  body
    .querySelectorAll(".pinned-route-list li[data-pinned-key]")
    .forEach((li) => {
      bindPinnedRouteCardEvents(li);
    });
  setupPinnedCardLiveObserver();
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: "mtr"|"lrt"|"bus"|"mtr_bus",
 *   co?: string,
 *   aliases?: string[],
 *   nearbyHint?: string,
 * }} EtaRouteEntry
 */
/** @type {EtaRouteEntry[]} */
let etaRouteCatalog = [];
/** @type {EtaRouteEntry[]} */
let etaRouteHits = [];
let etaRouteActive = -1;
/**
 * ETA method filter pills. Empty set = All methods.
 * @type {Set<"bus"|"mtr"|"lrt"|"gmb">}
 */
let etaTrafficModes = new Set();
/** @deprecated use etaTrafficModes; kept for any residual string checks */
let etaTrafficMode = "all";
/** @type {{ lat: number, lon: number, at: number } | null} */
let etaUserGeo = null;
/** GPS may re-centre the Nearby map until the user overrides it (map click) or a route fit runs */
let nearbyGeoFollow = true;
/** Last GPS-driven nearby refresh — throttle: skip when fix moved < 250 m
 * or the previous refresh is < 45 s old. */
let etaNearbyRefreshGeo = null; // { lat, lon, at }
/** @type {Promise<{ lat: number, lon: number } | null> | null} */
let etaGeoPromise = null;
/** @type {Map<string, string[]> | null} station name_en lower → line codes */
let mtrStationLinesMap = null;
/**
 * KMB route → bound destinations for direction dots.
 * @type {Map<string, Array<{ bound: string, dest_en: string, dest_tc: string, orig_en: string, orig_tc: string, service_type: string }>> | null}
 */
let kmbRouteBoundsMap = null;
/** @type {Promise<Map<string, any[]>> | null} */
let kmbRouteBoundsPromise = null;
/** CTB route → O/I directions (never reuse KMB bounds for same number). */
/** @type {Map<string, Array<{ dest: string, destZh?: string, bound: string, orig?: string }>>} */
const ctbRouteBoundsMap = new Map();
/** @type {Map<string, Promise<any>>} */
const ctbRouteBoundPromises = new Map();
/** NLB routeNo → variants (each NLB direction is its own routeId). */
/** @type {Map<string, Array<{ dest: string, destZh?: string, bound: string, orig?: string, routeId?: string }>> | null} */
let nlbRouteBoundsMap = null;
/** @type {Promise<Map<string, any[]>> | null} */
let nlbRouteBoundsPromise = null;
/** Invalidate in-flight shape loads when selection changes. */
let etaShapeGen = 0;
/** Per-card direction index 0|1 keyed by routeKey */
/** @type {Map<string, number>} */
const etaCardDirIndex = new Map();
/**
 * Live / scheduled ETA payload attached when browsing nearby stops.
 * @type {Map<string, { minutes: number | null, stopLabel: string, dest?: string, destZh?: string, bound?: string, stopId?: string, scheduled?: boolean, clock?: string }>}
 */
const etaLiveByKey = new Map();
/** GTFS stop directory when already loaded (Nearby / card label lookup). */
let etaGtfsDir = null;
/**
 * Live ETA per route key (list cards). Carries fetch metadata for UI chips.
 * @typedef {{
 *   minutes: number | null,
 *   stopLabel: string,
 *   dest?: string,
 *   destZh?: string,
 *   bound?: string,
 *   stopId?: string,
 *   scheduled?: boolean,
 *   clock?: string,
 *   outsideService?: boolean,
 *   fetchedAt?: number,
 *   platforms?: string[],
 * }} EtaLiveByKeyEntry
 * @type {Map<string, EtaLiveByKeyEntry>}
 */
/**
 * Nearby direction slots per route (each bound can use a different stop).
 * Index 0 = preferred “going away from user”.
 * @typedef {{
 *   bound: string,
 *   branch?: string,
 *   dest: string,
 *   destZh: string,
 *   minutes: number | null,
 *   stopLabel: string,
 *   stopId: string,
 *   distM: number,
 *   stopLat?: number,
 *   stopLon?: number,
 *   awayScore?: number,
 *   clock?: string,
 * }} EtaNearbyDirSlot
 * @type {Map<string, EtaNearbyDirSlot[]>}
 */
const etaNearbyDirsByKey = new Map();
/** @type {Array<{ stop: string, name_en: string, name_tc: string, lat: number, lon: number }> | null} */
let kmbStopsCache = null;
/** @type {Promise<any> | null} */
let kmbStopsPromise = null;
/** Cache KMB route-stop sequences for away-score (route|inbound|outbound → stops) */
/** @type {Map<string, Array<{ stop: string, seq: number, lat: number, lon: number }>>} */
const kmbRouteStopSeqCache = new Map();

function etaRouteKey(r) {
  return `${r?.kind || ""}|${r?.id || ""}|${r?.co || ""}`;
}

function isJointBusRoute(r) {
  const co = String(r?.co || "").toLowerCase();
  return (
    r?.kind === "bus" &&
    (co === "kmb" || co === "ctb" || co === "lwb") &&
    isJointHarbourRoute(r.id)
  );
}

/** Nearby/search: collapse KMB+CTB copies of the same joint route. */
function etaRouteDedupeKey(r) {
  if (isJointBusRoute(r)) return `bus|${String(r.id || "").toUpperCase()}|joint`;
  return etaRouteKey(r);
}

function jointOpsOf(r) {
  const ops = Array.isArray(r?.jointOps) ? r.jointOps.map((c) => String(c).toLowerCase()) : [];
  const co = String(r?.co || "").toLowerCase();
  const set = new Set(ops.length ? ops : co ? [co] : []);
  if (isJointBusRoute(r)) {
    set.add("kmb");
    set.add("ctb");
  }
  return [...set];
}

function getCardDir(r) {
  const k = etaRouteKey(r);
  const v = etaCardDirIndex.get(k);
  return Number.isFinite(v) ? Number(v) : 0;
}

function setCardDir(r, i) {
  // Store full index (EAL/TKL have 3 directions) — never clamp to 0|1 only
  const n = Math.max(0, Math.floor(Number(i) || 0));
  etaCardDirIndex.set(etaRouteKey(r), n);
}

/**
 * Resolve direction index for a dirs array.
 * Prefer explicit card dir (set by nearby “going away” commit and Opposite)
 * so Opposite on the detail page is not snapped back by live/nearby bound.
 *
 * @param {EtaRouteEntry} r
 * @param {Array<{ bound?: string }>} dirs
 * @returns {number}
 */
function resolveCardDirIndex(r, dirs) {
  if (!dirs?.length) return 0;
  const key = etaRouteKey(r);
  if (etaCardDirIndex.has(key)) {
    const card = getCardDir(r);
    if (card >= 0 && card < dirs.length) return card;
  }

  // Fallbacks only when card index is out of range (e.g. one-way filtered)
  const live = etaLiveByKey.get(key);
  const wantBound = String(live?.bound || "").toUpperCase();
  if (wantBound && wantBound !== "LINE" && wantBound !== "LRT") {
    const byLive = dirs.findIndex(
      (d) => String(d.bound || "").toUpperCase() === wantBound,
    );
    if (byLive >= 0) return byLive;
  }
  const nearby = etaNearbyDirsByKey.get(key);
  if (nearby?.length) {
    const pref = nearby[0];
    const byDest = etaMatchDepartureSlotIndex(dirs, pref);
    if (byDest >= 0) return byDest;
    const b = String(pref?.bound || "").toUpperCase();
    if (b) {
      const byNear = dirs.findIndex(
        (d) => String(d.bound || "").toUpperCase() === b,
      );
      if (byNear >= 0) return byNear;
    }
  }
  if (etaHasDepartureSwitch(dirs)) return etaPreferredDepartureIndex(dirs);
  return 0;
}

/**
 * Wanted bound for the card’s current direction index (O/I).
 * @param {EtaRouteEntry} r
 * @param {Array<{ bound?: string }> | null} [dirs]
 * @returns {string}
 */
function cardDirWantBound(r, dirs = null) {
  const list =
    dirs?.length >= 1 ? dirs : etaRouteDirections(r, { full: true });
  const di = resolveCardDirIndex(r, list);
  const b = String(list[di]?.bound || "").toUpperCase();
  if (b && b !== "LINE" && b !== "LRT") return b;
  // Fallback: treat card index 0/1 as O/I when OD has no bound labels
  return getCardDir(r) <= 0 ? "O" : "I";
}

/**
 * Keep live/nearby metadata aligned with the card direction index.
 * Call after Opposite so reloads don’t snap back to the old bound.
 * @param {EtaRouteEntry} r
 * @param {number} di
 * @param {Array<{ bound?: string, dest?: string, destZh?: string, orig?: string }>} [dirs]
 */
function syncDirChoiceToLive(r, di, dirs) {
  if (!r) return;
  const key = etaRouteKey(r);
  const list =
    dirs?.length >= 1 ? dirs : etaRouteDirections(r, { full: true });
  const idx = Math.min(Math.max(0, di), Math.max(0, list.length - 1));
  const d = list[idx];
  if (!d) return;
  setCardDir(r, idx);

  // Nearby slots are stored O→I — apply only the slot that matches this bound
  const applied = applyNearbyDirLive(r, { dirs: list });
  if (applied) {
    const live = etaLiveByKey.get(key);
    const want = String(d.bound || "").toUpperCase();
    const got = String(live?.bound || "").toUpperCase();
    // Only keep cached minutes when bound actually matches the new direction
    if (live && live.minutes != null && (!want || got === want)) return;
  }

  // No cached ETA for this bound — update dest immediately, clear stale minutes
  // so the card doesn’t keep showing the other direction’s wait time.
  const prev = etaLiveByKey.get(key) || {};
  const want = String(d.bound || "").toUpperCase();
  const sameBound =
    want && String(prev.bound || "").toUpperCase() === want;
  etaLiveByKey.set(key, {
    ...prev,
    minutes: sameBound ? prev.minutes ?? null : null,
    bound: d.bound,
    dest: d.dest || prev.dest,
    destZh: d.destZh || prev.destZh,
    stopId: sameBound ? prev.stopId : undefined,
    stopLabel: sameBound
      ? prev.stopLabel || d.orig || ""
      : d.orig || "",
    scheduled: sameBound ? prev.scheduled : true,
    clock: sameBound ? prev.clock : "",
  });
}

/**
 * Store nearby direction slots in stable O→I order (matches full OD),
 * and set card dir to the preferred “going away” bound.
 * @param {string} routeKey
 * @param {EtaRouteEntry} entry
 * @param {EtaNearbyDirSlot[]} scoredSlots  any order
 */
async function commitNearbyDirSlots(routeKey, entry, scoredSlots) {
  if (!scoredSlots?.length) return;
  const od = etaUniqueDirections(etaRouteDirectionsFromOd(entry) || []);
  const departureSwitch = etaHasDepartureSwitch(od);
  // Seed AM/PM (or extra OD) shells so Nearby can pick by time even when
  // only one bound has a live row at the nearest stop.
  let raw = [...scoredSlots];
  if (departureSwitch) {
    const have = new Set(raw.map((s) => etaDestBoundKey(s)));
    for (const d of od) {
      const k = etaDestBoundKey(d);
      if (!k || have.has(k)) continue;
      raw.push({
        bound: d.bound,
        dest: d.dest || "",
        destZh: d.destZh || "",
        minutes: null,
        stopLabel: d.orig || "",
        stopId: "",
        distM: Infinity,
        circular: d.circular,
        variant: d.variant,
        serviceType: d.serviceType,
      });
      have.add(k);
    }
    await Promise.all(od.map((d) => hydrateDirSchedule(entry, d)));
  }
  // MTR/LRT only: prefer slots that go *away* (dest ≠ board terminus)
  const isRail = entry?.kind === "mtr" || entry?.kind === "lrt";
  const awaySlots = isRail
    ? raw.filter(
        (s) =>
          !s.stopLabel ||
          !s.dest ||
          !etaStationsMatch(s.destZh || s.dest, s.stopLabel),
      )
    : raw;
  const pool = awaySlots.length ? awaySlots : raw;
  const preferred = sortSlotsGoingAway(pool)[0];
  /** @type {EtaNearbyDirSlot[]} */
  // Dedupe by dest+bound for AM/PM variants; bound|branch for EAL/TKL.
  const byKey = new Map();
  for (const s of raw) {
    byKey.set(departureSwitch ? etaDestBoundKey(s) : etaDirSlotKey(s), s);
  }
  const ordered = [...byKey.values()].sort((a, b) => {
    const ba = String(a.bound || "").toUpperCase();
    const bb = String(b.bound || "").toUpperCase();
    if (ba !== bb) {
      if (ba === "O") return -1;
      if (bb === "O") return 1;
      if (ba === "I") return -1;
      if (bb === "I") return 1;
    }
    return String(a.branch || "").localeCompare(String(b.branch || ""));
  });
  etaNearbyDirsByKey.set(routeKey, ordered);
  let prefIdx = 0;
  if (departureSwitch) {
    const want = od[etaPreferredDepartureIndex(od)] || od[0];
    const i = etaMatchDepartureSlotIndex(ordered, want);
    prefIdx = i >= 0 ? i : etaPreferredDepartureIndex(od);
  } else if (preferred) {
    const prefKey = etaDirSlotKey(preferred);
    const i = ordered.findIndex((s) => etaDirSlotKey(s) === prefKey);
    if (i >= 0) prefIdx = i;
    else {
      const prefBound = String(preferred.bound || "").toUpperCase();
      const prefDest = etaDestKey(preferred.destZh || preferred.dest);
      const j = ordered.findIndex((s) => {
        if (prefBound && String(s.bound || "").toUpperCase() === prefBound) {
          if (!prefDest) return true;
          return etaDestKey(s.destZh || s.dest) === prefDest || !s.dest;
        }
        return false;
      });
      if (j >= 0) prefIdx = j;
    }
  }
  setCardDir(entry, prefIdx);
  applyNearbyDirLive(entry);
}

/**
 * Apply live ETA from the nearby slot for the card’s active bound.
 * Must match by bound (O/I), never by raw card index — a single cached
 * outbound slot must not be reused after Opposite flips to inbound.
 *
 * @param {EtaRouteEntry} r
 * @param {{ dirs?: Array<{ bound?: string }> }} [opts]
 * @returns {boolean} true if a slot was applied (minutes may still be null)
 */
function applyNearbyDirLive(r, opts = {}) {
  if (!r) return false;
  const key = etaRouteKey(r);
  const slots = etaNearbyDirsByKey.get(key);
  if (!slots?.length) return false;

  const list =
    opts.dirs?.length >= 1 ? opts.dirs : etaRouteDirections(r, { full: true });
  const di = resolveCardDirIndex(r, list);
  const wantDir = list[di] || null;
  const wantKey = wantDir ? etaDirSlotKey(wantDir) : "";
  const wantBound = cardDirWantBound(r, list);
  const wantBranch = String(wantDir?.branch || "").toUpperCase();

  // Prefer exact bound|branch, then dest (AM/PM), then bound alone
  let slot =
    (wantKey && slots.find((s) => etaDirSlotKey(s) === wantKey)) ||
    null;
  if (!slot && wantDir && etaHasDepartureSwitch(list)) {
    const i = etaMatchDepartureSlotIndex(slots, wantDir);
    if (i >= 0) slot = slots[i];
  }
  if (!slot && wantBound) {
    slot =
      slots.find((s) => {
        if (String(s.bound || "").toUpperCase() !== wantBound) return false;
        if (wantBranch && String(s.branch || "").toUpperCase() !== wantBranch) {
          return false;
        }
        return true;
      }) ||
      slots.find((s) => String(s.bound || "").toUpperCase() === wantBound) ||
      null;
  }
  // Only fall back to index when bounds are missing on slots
  if (!slot) {
    const allBoundless = slots.every((s) => !String(s.bound || "").trim());
    if (allBoundless) {
      slot = slots[Math.min(getCardDir(r), slots.length - 1)];
    }
  }
  if (!slot) return false;

  etaLiveByKey.set(key, {
    // Keep platform / last-update info from the last network fetch
    ...(etaLiveByKey.get(key) || {}),
    minutes: slot.minutes,
    stopLabel: slot.stopLabel,
    stopNameEn: slot.stopNameEn || "",
    stopNameTc: slot.stopNameTc || "",
    dest: slot.dest,
    destZh: slot.destZh,
    bound: slot.bound || wantBound,
    stopId: slot.stopId,
    // Live minutes from operator feeds — not headway schedule
    scheduled: slot.minutes == null,
    clock: slot.clock || "",
  });
  // Keep nearbyHint in sync with the stop used for this direction
  if (slot.stopLabel) {
    r.nearbyHint = `${slot.stopLabel}${
      Number.isFinite(slot.distM) ? ` · ${Math.round(slot.distM)} m` : ""
    }`;
  }
  return true;
}

/** @type {Map<string, number>} */
const etaCardLiveFetchGen = new Map();

/**
 * Refresh list-card live ETA for the active card direction.
 * Uses cached nearby per-bound slots when present; otherwise fetches live.
 * @param {EtaRouteEntry} r
 * @param {{ silent?: boolean, force?: boolean }} [opts]
 *   force — always network-fetch (Opposite); ignore cached minutes for other bound
 * @returns {Promise<boolean>} true if live minutes were written
 */
/** Cached GTFS frequency window per route|bound|kind. */
const scheduleWindowCache = new Map();

/**
 * Attach first/last/headway/maxPerHour from GTFS frequencies so timetable
 * slots stop at last bus and honour the hourly cap (not a midnight grid).
 * @param {EtaRouteEntry} r
 * @param {object} dir
 */
async function hydrateDirSchedule(r, dir) {
  if (!r || !dir) return dir;
  const co = String(r.co || "").toLowerCase();
  const loadCo = co === "lwb" || (r.kind === "bus" && !co) ? "kmb" : co;
  if (!["kmb", "ctb", "nlb"].includes(loadCo)) return dir;
  if (r.kind === "mtr" || r.kind === "lrt" || r.kind === "mtr_bus") return dir;
  const kind =
    dir.variant || (etaIsCircularDir(dir) ? "loop" : "oneway");
  const cacheKey = `${loadCo}|${String(r.id || "").toUpperCase()}|${dir.bound || ""}|${kind}`;
  if (scheduleWindowCache.has(cacheKey)) {
    const w = scheduleWindowCache.get(cacheKey);
    if (w) Object.assign(dir, w);
    return dir;
  }
  try {
    const { loadOperatorSchedules, scheduleServiceWindow } = await import(
      "./busSchedules.js"
    );
    const sched = await loadOperatorSchedules(loadCo);
    const rid = `${loadCo.toUpperCase()}-${r.id}`;
    const w = scheduleServiceWindow(sched, rid, dir.bound, Date.now(), { kind });
    let patch = w
      ? {
          first: w.firstMins,
          last: w.lastMins,
          headwayMins: w.headwayMins,
          maxPerHour: w.maxPerHour,
          overnight: w.overnight,
        }
      : {};
    if (!w && (kind === "loop" || kind === "oneway")) {
      const other = kind === "loop" ? "oneway" : "loop";
      const w2 = scheduleServiceWindow(sched, rid, dir.bound, Date.now(), {
        kind: other,
      });
      // Other departure is in the GTFS calendar today; this one is not
      // (S64C Sunday afternoon).
      if (w2) patch = { first: 0, last: -1 };
    }
    scheduleWindowCache.set(cacheKey, patch);
    Object.assign(dir, patch);
  } catch (e) {
    console.warn("[eta] schedule window", e);
    scheduleWindowCache.set(cacheKey, {});
  }
  return dir;
}

async function refreshCardLiveEta(r, opts = {}) {
  if (!r) return false;
  const key = etaRouteKey(r);
  const gen = (etaCardLiveFetchGen.get(key) || 0) + 1;
  etaCardLiveFetchGen.set(key, gen);
  const force = !!opts.force;

  const dirs = etaRouteDirections(r, { full: true });
  const di = resolveCardDirIndex(r, dirs);
  const dir = dirs[di] || dirs[0] || { dest: r.label, bound: "O" };
  await hydrateDirSchedule(r, dir);
  const bound = String(dir.bound || "O").toUpperCase();

  // 1) Nearby multi-bound cache (KMB/CTB/MTR Bus nearby) — only if bound matches
  if (!force && applyNearbyDirLive(r, { dirs })) {
    const live = etaLiveByKey.get(key);
    const liveBound = String(live?.bound || "").toUpperCase();
    const boundOk =
      !bound ||
      bound === "LINE" ||
      bound === "LRT" ||
      liveBound === bound;
    if (live && live.minutes != null && boundOk) return true;
    // Slot missing / wrong bound / no minutes — fall through to fetch
  }

  // Board stop: only the nearby slot for THIS bound (never the other direction’s stop)
  /** @type {{ stopId?: string, name?: string, lon?: number, lat?: number, stationCode?: string, code?: string } | null} */
  let board = null;
  const nearby = etaNearbyDirsByKey.get(key);
  if (nearby?.length && bound && bound !== "LINE" && bound !== "LRT") {
    const slot = nearby.find(
      (s) => String(s.bound || "").toUpperCase() === bound,
    );
    if (slot?.stopId || slot?.stopLabel) {
      board = {
        stopId: slot.stopId,
        name: slot.stopLabel,
        nameEn: slot.stopNameEn || "",
        nameTc: slot.stopNameTc || "",
        lon: slot.stopLon,
        lat: slot.stopLat,
      };
    }
  }

  // Pinned stops: the pin itself names the board stop — use it before geo.
  // (Catalog entries never carry stopId/stopName, so only pins hit this.)
  if (!board && (r.stopId || r.stopName)) {
    board = {
      stopId: r.stopId || "",
      name: r.stopName || r.stopNameEn || "",
    };
  }

  try {
    if (r.kind === "mtr" || r.kind === "lrt" || r.kind === "mtr_bus") {
      if (r.kind === "mtr_bus") await ensureMtrBusData();
      if (r.kind === "lrt") await ensureLrtRouteData();
      if (r.kind === "mtr") await ensureMtrStationLinesMap();
    }
    // Load stop sequence for this bound so we have a board stop + coords
    const prevDir = getCardDir(r);
    setCardDir(r, di);
    let stops = [];
    try {
      stops = await loadEtaRouteStops(r);
    } finally {
      setCardDir(r, prevDir);
    }
    if (gen !== etaCardLiveFetchGen.get(key)) return false;

    if (!board && stops.length) {
      // Prefer stop near user when geo known
      const geo = etaUserGeo
        ? { lat: etaUserGeo.lat, lon: etaUserGeo.lon }
        : null;
      if (geo) {
        let best = null;
        let bestD = Infinity;
        for (const s of stops) {
          if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
          const d = haversineMEta(geo.lat, geo.lon, s.lat, s.lon);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        if (best) {
          board = {
            stopId: best.stopId,
            name: best.name,
            nameEn: best.nameEn || best.name_en || "",
            nameTc: best.nameTc || best.name_tc || best.nameZh || "",
            lon: best.lon,
            lat: best.lat,
            stationCode: best.stationCode || best.code,
            code: best.code || best.stationCode,
          };
        }
      }
      if (!board) {
        const s = stops[0];
        board = {
          stopId: s.stopId,
          name: s.name,
          nameEn: s.nameEn || s.name_en || "",
          nameTc: s.nameTc || s.name_tc || s.nameZh || "",
          lon: s.lon,
          lat: s.lat,
          stationCode: s.stationCode || s.code,
          code: s.code || s.stationCode,
        };
      }
    }

    // Still no board coords — for MTR/LRT build from station directories
    if (!board && r.kind === "mtr") {
      const liveHint = etaLiveByKey.get(key);
      const code = liveHint?.stopId || "";
      const st =
        (code &&
          MTR_STATIONS.find(
            (x) => String(x.code || "").toUpperCase() === String(code).toUpperCase(),
          )) ||
        null;
      if (st) {
        board = {
          stopId: `MTR-${st.code}`,
          name: st.name_zh ? `${st.name_zh} ${st.name_en}` : st.name_en,
          lon: st.lon,
          lat: st.lat,
          stationCode: st.code,
          code: st.code,
        };
      }
    }
    if (!board && r.kind === "lrt") {
      const liveHint = etaLiveByKey.get(key);
      const sid = liveHint?.stopId || "";
      const st =
        LRT_STOPS.find((x) => String(x.stop_id) === String(sid)) ||
        LRT_STOPS.find(
          (x) =>
            Number.isFinite(x.lat) &&
            etaUserGeo &&
            haversineMEta(etaUserGeo.lat, etaUserGeo.lon, x.lat, x.lon) < 2000,
        );
      if (st) {
        board = {
          stopId: String(st.stop_id || ""),
          name: st.name_en,
          lon: st.lon,
          lat: st.lat,
        };
      }
    }

    if (!board) {
      // At least update dest labels from OD
      const prev = etaLiveByKey.get(key) || {};
      etaLiveByKey.set(key, {
        ...prev,
        dest: dir.dest || prev.dest,
        destZh: dir.destZh || prev.destZh,
        bound: dir.bound || prev.bound,
      });
      return false;
    }

    const opt = etaRouteAsOption(r, stops, dir, board);
    let result = await fetchBoardEta(opt);
    if (gen !== etaCardLiveFetchGen.get(key)) return false;
    result = resolveBrowseEta(result, opt, {
      dest: dir.dest || r.label || "",
      route: r.id,
    });
    const first = result?.etas?.[0];
    const mins = result?.waitMins ?? first?.waitMins ?? null;
    const stopLabel =
      etaStopNameLabel(board) ||
      board.name ||
      result?.stopId ||
      "";
    etaLiveByKey.set(key, {
      minutes: mins,
      stopLabel,
      stopNameEn: board.nameEn || board.name_en || "",
      stopNameTc: board.nameTc || board.name_tc || "",
      dest: first?.dest || dir.dest || "",
      destZh: dir.destZh || "",
      bound: dir.bound || bound,
      stopId: board.stopId || result?.stopId || "",
      scheduled: !!(first?.scheduled || result?.scheduled),
      clock: first?.clock || "",
      outsideService: !!result?.outsideService,
      fetchedAt: result?.fetchedAt ?? Date.now(),
      platforms: result?.servingPlatforms || [],
    });
    if (stopLabel) {
      r.nearbyHint = stopLabel;
    }
    // Cache into nearby slots so next Opposite is instant.
    // Seed the other OD bound as a shell so two-way routes keep Opposite
    // (MTR/LRT often only fetch one bound at a time).
    if (mins != null || stopLabel || result?.outsideService) {
      /** @type {EtaNearbyDirSlot} */
      const slot = {
        bound: String(dir.bound || bound),
        dest: dir.dest || "",
        destZh: dir.destZh || "",
        minutes: mins,
        stopLabel,
        stopNameEn: board.nameEn || board.name_en || "",
        stopNameTc: board.nameTc || board.name_tc || "",
        stopId: String(board.stopId || ""),
        distM: Number.isFinite(board.lat) && etaUserGeo
          ? haversineMEta(
              etaUserGeo.lat,
              etaUserGeo.lon,
              Number(board.lat),
              Number(board.lon),
            )
          : 0,
        stopLat: board.lat,
        stopLon: board.lon,
      };
      let slots = etaNearbyDirsByKey.get(key) || [];
      // Merge by bound|branch so branch lines keep every OD path
      const slotKey = etaDirSlotKey({
        ...slot,
        branch: dir?.branch || slot.branch,
      });
      if (dir?.branch && !slot.branch) slot = { ...slot, branch: dir.branch };
      const bi = slots.findIndex((s) => etaDirSlotKey(s) === slotKey);
      if (bi >= 0) slots[bi] = { ...slots[bi], ...slot };
      else slots = [...slots, slot];
      // Ensure every real OD direction exists as a slot (shell for unfetched)
      const odDirs = etaUniqueDirections(etaRouteDirectionsFromOd(r));
      if (
        odDirs.length >= 2 &&
        (etaHasRealOpposite(odDirs) || etaHasDepartureSwitch(odDirs))
      ) {
        const have = new Set(slots.map((s) => etaDirSlotKey(s)));
        for (const d of odDirs) {
          const k = etaDirSlotKey(d);
          if (!k || have.has(k)) continue;
          slots.push({
            bound: d.bound,
            branch: d.branch || "",
            dest: d.dest || "",
            destZh: d.destZh || "",
            minutes: null,
            stopLabel: d.orig || "",
            stopId: "",
            distM: 0,
          });
          have.add(k);
        }
      }
      // Stable O* then I* (keep all branch rows)
      const ordered = [...slots].sort((a, b) => {
        const ba = String(a.bound || "").toUpperCase();
        const bb = String(b.bound || "").toUpperCase();
        if (ba !== bb) {
          if (ba === "O") return -1;
          if (bb === "O") return 1;
          if (ba === "I") return -1;
          if (bb === "I") return 1;
        }
        return String(a.branch || "").localeCompare(String(b.branch || ""));
      });
      etaNearbyDirsByKey.set(key, ordered);
    }
    return mins != null;
  } catch (e) {
    if (!opts.silent) console.warn("[eta] card live refresh", r.id, e);
    return false;
  }
}

/**
 * Service types to try for KMB route-stop (circular / peak variants use 2–3).
 * @param {number | string | null | undefined} preferred
 * @returns {number[]}
 */
function kmbServiceTypesToTry(preferred = null) {
  const p = Number(preferred);
  const base = [1, 2, 3, 4, 5, 6];
  if (Number.isFinite(p) && p >= 1) {
    return [p, ...base.filter((x) => x !== p)];
  }
  return base;
}

/**
 * Fetch KMB/LWB stop sequence for one direction + service type.
 * Keeps rows even when master-stop coords are missing (list still usable).
 * @param {string} routeId
 * @param {"inbound"|"outbound"} direction
 * @param {number} [serviceType]
 * @returns {Promise<Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>>}
 */
function appIsOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

async function fetchKmbRouteStopList(routeId, direction, serviceType = 1) {
  const rid = String(routeId || "").toUpperCase();
  const dir = direction === "inbound" ? "inbound" : "outbound";
  const stype = Math.max(1, Math.min(99, Number(serviceType) || 1));
  const cacheKey = `${rid}|${dir}|${stype}|full`;
  if (kmbRouteStopSeqCache.has(cacheKey)) {
    return kmbRouteStopSeqCache.get(cacheKey) || [];
  }
  if (appIsOffline()) return [];
  try {
    const rs = await fetch(
      `/eta/kmb/route-stop/${encodeURIComponent(rid)}/${dir}/${stype}`,
      { headers: { Accept: "application/json" } },
    );
    if (!rs.ok) {
      kmbRouteStopSeqCache.set(cacheKey, []);
      return [];
    }
    const j = await rs.json();
    await ensureKmbStops();
    const byId = new Map((kmbStopsCache || []).map((s) => [s.stop, s]));
    const rows = (j.data || [])
      .slice()
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    /** @type {Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>} */
    const stops = [];
    let named = 0;
    for (const row of rows) {
      const sid = String(row.stop || "");
      if (!sid) continue;
      const st = byId.get(sid);
      const lat = st && Number.isFinite(st.lat) ? st.lat : NaN;
      const lon = st && Number.isFinite(st.lon) ? st.lon : NaN;
      const nm = st?.name_tc || st?.name_en || "";
      if (nm) named += 1;
      stops.push({
        seq: Number(row.seq) || stops.length + 1,
        name: nm || sid,
        nameEn: st?.name_en || "",
        nameTc: st?.name_tc || "",
        stopId: sid,
        lon,
        lat,
      });
    }
    // Cache only when names resolved — an unresolved list must stay uncached
    // so a later directory load can re-resolve instead of locking in ids.
    if (named > 0) kmbRouteStopSeqCache.set(cacheKey, stops);
    return stops;
  } catch {
    kmbRouteStopSeqCache.set(cacheKey, []);
    return [];
  }
}

/**
 * Robust KMB stop load for circular / one-way / multi service-type (S64 series).
 * @param {string} routeId
 * @param {string} [bound] O|I
 * @param {number | string | null} [serviceType]
 */
function stopListIsLoop(stops) {
  if (!stops?.length || stops.length < 4) return false;
  const a = stops[0];
  const b = stops[stops.length - 1];
  if (
    !Number.isFinite(a?.lat) ||
    !Number.isFinite(a?.lon) ||
    !Number.isFinite(b?.lat) ||
    !Number.isFinite(b?.lon)
  ) {
    return false;
  }
  return haversineMEta(a.lat, a.lon, b.lat, b.lon) < 150;
}

/**
 * KMB stop list for one departure variant — exact service type, then the
 * first list whose loop/one-way shape matches the variant (do not fall
 * through from PM HACTL to the AM circular).
 */
async function loadKmbRouteStopsExact(routeId, dir) {
  const b = String(dir?.bound || "O").toUpperCase();
  const wantLoop = etaIsCircularDir(dir) || dir?.variant === "loop";
  const dirOrder =
    b === "I" || b === "INBOUND" || b === "2"
      ? /** @type {const} */ (["inbound", "outbound"])
      : /** @type {const} */ (["outbound", "inbound"]);
  const types = kmbServiceTypesToTry(dir?.serviceType ?? dir?.service_type);
  let fallback = [];
  for (const direction of dirOrder) {
    for (const st of types) {
      const stops = await fetchKmbRouteStopList(routeId, direction, st);
      if (stops.length < 2) continue;
      if (stopListIsLoop(stops) === wantLoop) return stops;
      if (!fallback.length) fallback = stops;
    }
  }
  return wantLoop ? fallback : [];
}

async function loadScheduleVariantStops(route, dir) {
  const co = String(route?.co || "kmb").toLowerCase();
  const loadCo = co === "lwb" || (route?.kind === "bus" && !co) ? "kmb" : co;
  if (!["kmb", "ctb", "nlb"].includes(loadCo)) return [];
  try {
    const { loadOperatorSchedules, schedulePatternStops } = await import(
      "./busSchedules.js"
    );
    const sched = await loadOperatorSchedules(loadCo);
    const kind =
      dir?.variant || (etaIsCircularDir(dir) ? "loop" : "oneway");
    const coords = schedulePatternStops(
      sched,
      `${loadCo.toUpperCase()}-${route.id}`,
      dir?.bound,
      { kind },
    );
    if (coords.length < 2) return [];
    if (loadCo === "kmb") await ensureKmbStops();
    const master = loadCo === "kmb" ? kmbStopsCache || [] : [];
    return coords.map((c, i) => {
      let best = null;
      let bestD = 55;
      for (const s of master) {
        const lat = Number(s.lat);
        const lon = Number(s.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const d = haversineMEta(c.lat, c.lon, lat, lon);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return {
        seq: c.seq || i + 1,
        name: best ? best.name_tc || best.name_en || `Stop ${i + 1}` : `Stop ${i + 1}`,
        nameEn: best?.name_en || "",
        nameTc: best?.name_tc || "",
        stopId: best?.stop || `sched-${route.id}-${i}`,
        lon: c.lon,
        lat: c.lat,
      };
    });
  } catch (e) {
    console.warn("[eta] schedule variant stops", e);
    return [];
  }
}

async function loadKmbRouteStopsRobust(routeId, bound = "O", serviceType = null) {
  const b = String(bound || "O").toUpperCase();
  // Circular / airport feeders often only publish outbound; always fall back
  const dirOrder =
    b === "I" || b === "INBOUND" || b === "2"
      ? /** @type {const} */ (["inbound", "outbound"])
      : /** @type {const} */ (["outbound", "inbound"]);
  const types = kmbServiceTypesToTry(serviceType);
  for (const direction of dirOrder) {
    for (const st of types) {
      const stops = await fetchKmbRouteStopList(routeId, direction, st);
      if (stops.length >= 2) return stops;
    }
  }
  return [];
}

/**
 * Verify a *specific* KMB direction has a real stop sequence (no cross-dir fallback).
 * Used by filterDirsWithRealStops so circular outbound-only routes don’t invent I.
 * @param {string} routeId
 * @param {"inbound"|"outbound"} direction
 * @returns {Promise<Array<{ stop: string, seq: number, lat: number, lon: number }>>}
 */
async function ensureKmbRouteStopSeq(routeId, direction, serviceType = null) {
  const dir = direction === "inbound" ? "inbound" : "outbound";
  for (const st of kmbServiceTypesToTry(serviceType)) {
    const full = await fetchKmbRouteStopList(routeId, dir, st);
    const withCoords = full.filter(
      (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon),
    );
    if (withCoords.length >= 2) {
      return withCoords.map((s) => ({
        stop: s.stopId,
        seq: s.seq,
        lat: s.lat,
        lon: s.lon,
      }));
    }
    // Accept name-only sequences so filterDirs still keeps the bound
    if (full.length >= 2) {
      return full.map((s) => ({
        stop: s.stopId,
        seq: s.seq,
        lat: Number.isFinite(s.lat) ? s.lat : 0,
        lon: Number.isFinite(s.lon) ? s.lon : 0,
      }));
    }
  }
  return [];
}

/**
 * Score how strongly a bound is “going away” from the user.
 * Prefer larger score (farther terminus + more remaining journey past board).
 *
 * @param {{ lat: number, lon: number }} geo user
 * @param {{ lat: number, lon: number } | null | undefined} board
 * @param {{ lat: number, lon: number } | null | undefined} terminus
 * @param {{ lat: number, lon: number } | null | undefined} [origin] first stop of bound
 */
function scoreGoingAwayFromUser(geo, board, terminus, origin = null) {
  if (!geo || !terminus || !Number.isFinite(terminus.lat) || !Number.isFinite(terminus.lon)) {
    return 0;
  }
  // Primary: terminus farther from user → vehicle heads away from me
  let score = haversineMEta(geo.lat, geo.lon, terminus.lat, terminus.lon);

  if (board && Number.isFinite(board.lat) && Number.isFinite(board.lon)) {
    // Remaining journey length after boarding (m)
    const remainingM = haversineMEta(
      board.lat,
      board.lon,
      terminus.lat,
      terminus.lon,
    );
    score += remainingM * 0.85;

    // Near end of line (user & board both close to terminus) → strong penalty
    const userToBoard = haversineMEta(geo.lat, geo.lon, board.lat, board.lon);
    if (remainingM < 600 && userToBoard < 400) {
      score -= 2500;
    }
  }

  // Prefer riding toward the far end vs back to the near origin
  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
    const toOrig = haversineMEta(geo.lat, geo.lon, origin.lat, origin.lon);
    const toTerm = haversineMEta(geo.lat, geo.lon, terminus.lat, terminus.lon);
    // Positive when terminus is farther than origin (classic going-away)
    score += (toTerm - toOrig) * 0.5;
  }

  return score;
}

/**
 * How strongly KMB/LWB bound goes away from the user.
 * @param {string} routeId
 * @param {string} bound O|I
 * @param {{ lat: number, lon: number }} geo
 * @param {string} [stopId]
 */
async function scoreKmbDirectionAway(routeId, bound, geo, stopId = "") {
  const direction =
    String(bound).toUpperCase() === "I" ? "inbound" : "outbound";
  const seq = await ensureKmbRouteStopSeq(routeId, direction);
  if (!seq.length) return 0;
  const first = seq[0];
  const last = seq[seq.length - 1];
  let idx = stopId ? seq.findIndex((s) => s.stop === stopId) : -1;
  if (idx < 0) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < seq.length; i++) {
      const d = haversineMEta(geo.lat, geo.lon, seq[i].lat, seq[i].lon);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    idx = bestI;
  }
  const board = seq[idx] || first;
  return scoreGoingAwayFromUser(geo, board, last, first);
}

/** @type {Map<string, Array<{ stop: string, seq: number, lat: number, lon: number }>>} */
const ctbRouteStopSeqCache = new Map();

/**
 * CTB stop sequence with coords for one direction (for away scoring).
 * @param {string} routeId
 * @param {"inbound"|"outbound"} direction
 */
async function ensureCtbRouteStopSeq(routeId, direction) {
  const rid = String(routeId || "").toUpperCase();
  const dir = direction === "inbound" ? "inbound" : "outbound";
  const cacheKey = `${rid}|${dir}`;
  if (ctbRouteStopSeqCache.has(cacheKey)) {
    return ctbRouteStopSeqCache.get(cacheKey) || [];
  }
  try {
    const rs = await fetch(
      `/eta/ctb/route-stop/CTB/${encodeURIComponent(rid)}/${dir}`,
      { headers: { Accept: "application/json" } },
    );
    if (!rs.ok) {
      ctbRouteStopSeqCache.set(cacheKey, []);
      return [];
    }
    const j = await rs.json();
    const rows = (j.data || [])
      .slice()
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    // Sample ends + mid to limit stop detail fetches
    const pick = [];
    if (rows.length) pick.push(rows[0]);
    if (rows.length > 2) pick.push(rows[Math.floor(rows.length / 2)]);
    if (rows.length > 1) pick.push(rows[rows.length - 1]);
    /** @type {Array<{ stop: string, seq: number, lat: number, lon: number }>} */
    const seq = [];
    await Promise.all(
      pick.map(async (row) => {
        const sid = String(row.stop || "");
        if (!sid) return;
        try {
          const sr = await fetch(`/eta/ctb/stop/${encodeURIComponent(sid)}`, {
            headers: { Accept: "application/json" },
          });
          if (!sr.ok) return;
          const sj = await sr.json();
          const d = sj.data || {};
          const lat = Number(d.lat);
          const lon = Number(d.long ?? d.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          seq.push({
            stop: sid,
            seq: Number(row.seq) || 0,
            lat,
            lon,
          });
        } catch {
          /* skip */
        }
      }),
    );
    seq.sort((a, b) => a.seq - b.seq);
    // If we only got samples, still use first/last for scoring
    ctbRouteStopSeqCache.set(cacheKey, seq);
    return seq;
  } catch {
    ctbRouteStopSeqCache.set(cacheKey, []);
    return [];
  }
}

/**
 * @param {string} routeId
 * @param {string} bound O|I
 * @param {{ lat: number, lon: number }} geo
 * @param {string} [stopId]
 * @param {number} [boardLat]
 * @param {number} [boardLon]
 */
async function scoreCtbDirectionAway(
  routeId,
  bound,
  geo,
  stopId = "",
  boardLat = NaN,
  boardLon = NaN,
) {
  const direction =
    String(bound).toUpperCase() === "I" ? "inbound" : "outbound";
  const seq = await ensureCtbRouteStopSeq(routeId, direction);
  const first = seq[0] || null;
  const last = seq[seq.length - 1] || null;
  let board = null;
  if (Number.isFinite(boardLat) && Number.isFinite(boardLon)) {
    board = { lat: boardLat, lon: boardLon };
  } else if (stopId && seq.length) {
    board = seq.find((s) => s.stop === stopId) || null;
  }
  if (!board && seq.length) {
    // nearest sample to user
    let best = seq[0];
    let bestD = Infinity;
    for (const s of seq) {
      const d = haversineMEta(geo.lat, geo.lon, s.lat, s.lon);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    board = best;
  }
  if (!last) return 0;
  return scoreGoingAwayFromUser(geo, board, last, first);
}

/**
 * Sort nearby direction slots so index 0 = going away from user.
 * @param {EtaNearbyDirSlot[]} slots
 */
function sortSlotsGoingAway(slots) {
  return [...slots].sort((a, b) => {
    const aa = a.awayScore ?? 0;
    const bb = b.awayScore ?? 0;
    // Always prefer higher away score (even small differences)
    if (Math.abs(aa - bb) > 1) return bb - aa;
    // Then closer board stop
    if (a.distM !== b.distM) return a.distM - b.distM;
    const ma = a.minutes;
    const mb = b.minutes;
    if (ma != null && mb != null && ma !== mb) return ma - mb;
    if (ma != null && mb == null) return -1;
    if (ma == null && mb != null) return 1;
    return String(a.bound).localeCompare(String(b.bound));
  });
}

/** Sidebar stack: "search" | "trip" */
let sidebarPage = "search";
/** Plan on the trip detail page: index in `plans`, or the plan object itself (pinned). */
let tripDetailIdx = null;
/** Trip plan to restore when Back is pressed on route detail opened from trip. */
let etaRouteReturnTrip = null;
/** @type {Map<number, import("./eta.js").LegEtaResult> | null} */
let tripDetailEtas = null;
/** @type {ReturnType<typeof setInterval> | null} */
let tripEtaPollTimer = null;
/** Generation token so stale ETA fetches don't paint after close/switch */
let tripEtaGen = 0;

/** @type {Array<"fastest"|"simplest"|"cheapest">} */
let routePreferences = loadRoutePreferences();
/** @type {import("./preferences.js").BusCompanyId[]} */
let busCompanies = loadBusCompanies();
/** @type {import("./preferences.js").TrafficMethodId[]} */
let trafficMethods = loadTrafficMethods();
/** @type {import("./preferences.js").ServiceDayId} */
let serviceDay = loadServiceDay();
/** @type {import("./preferences.js").DepartTimeValue} */
let departTime = loadDepartTime();
/** Active ticket type for fare estimates */
let fareType = loadFareType();
/** East Rail Line First Class premium on/off */
let ealFirstClass = loadEalFirstClass();
/** Resident (registered Octopus) fare on Residents' Bus Services on/off */
let rbsResidentFare = loadRbsResidentFare();

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function formatDuration(secs) {
  if (secs == null) return "—";
  const m = Math.round(secs / 60);
  if (m < 60) return t("{n} min", { n: m });
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? t("{h} h {m} min", { h, m: rm }) : t("{h} h", { h });
}

function fmtCoord(lat, lon) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

let toastTimer;
function showToast(message, ms = 3200) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "";
  a.rel = "noopener";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast(`Starting download: ${filename || url}`);
}

// ── PMTiles protocol ─────────────────────────────────────────────────────────
const protocol = new Protocol({ metadata: true });
addProtocol("pmtiles", protocol.tile);

// ── WebGL2 support & map recovery ────────────────────────────────────────────
/** Probe WebGL2 on a throwaway canvas — MapLibre v6 needs it and fails silently. */
function probeWebGL2() {
  try {
    return document.createElement("canvas").getContext("webgl2")
      ? "ok"
      : "unavailable";
  } catch (err) {
    return `error: ${err?.message || err}`;
  }
}

/** GPU/ANGLE backend string — “ANGLE (…, Vulkan …)” reveals translation bugs. */
function glRendererString() {
  try {
    const gl = map.getCanvas().getContext("webgl2");
    if (!gl) return "no-webgl2";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  } catch {
    return "unknown";
  }
}

/** Diagnostics to attach to a [map] failure report. */
function mapDiagnostics() {
  let canvasSize = "none";
  try {
    const c = map.getCanvas();
    canvasSize = `${c.width}x${c.height}`;
  } catch {
    /* map not created yet */
  }
  return {
    webgl2: probeWebGL2(),
    renderer: glRendererString(),
    canvas: canvasSize,
    isolated: Boolean(window.crossOriginIsolated),
    worker: getWorkerUrl(),
    ua: navigator.userAgent,
  };
}

/** Persistent card — this device cannot render the map at all. */
function showGlFallback(message) {
  const banner = document.getElementById("gl-error-banner");
  if (!banner) return;
  if (message) {
    const text = banner.querySelector(".beta-banner-text span:last-child");
    if (text) text.textContent = message;
  }
  banner.hidden = false;
  console.error("[map] map render failure", mapDiagnostics());
}

// MapLibre v6 requires WebGL2; its constructor fires the GPU error before any
// `map.on("error")` listener can exist, so probe first and surface it now.
if (probeWebGL2() !== "ok") {
  showGlFallback(null);
}

// ── Map ──────────────────────────────────────────────────────────────────────
const map = new MapLibreMap({
  container: "map",
  style: {
    version: 8,
    glyphs:
      "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${PMTILES_URL}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers("protomaps", namedFlavor("dark"), { lang: "en" }),
  },
  center: HK_CENTER,
  zoom: DEFAULT_ZOOM,
  hash: true,
  // Attribution is separate from nav tools so expand never resizes the tools stack
  attributionControl: false,
});

console.info("[map] renderer →", glRendererString());

// Map tools BR — desktop: nav + geolocate; mobile: geolocate only (gestures zoom)
const isMobileUi =
  typeof matchMedia !== "undefined" &&
  (matchMedia("(max-width: 640px)").matches ||
    matchMedia("(pointer: coarse)").matches);
/** Home-screen / installed PWA (safe-area + 100dvh differ from in-Safari) */
function isStandalonePwa() {
  try {
    if (typeof matchMedia !== "undefined") {
      if (matchMedia("(display-mode: standalone)").matches) return true;
      if (matchMedia("(display-mode: fullscreen)").matches) return true;
    }
    // iOS Safari “Add to Home Screen”
    if (typeof navigator !== "undefined" && navigator.standalone === true) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
const isPwaStandalone = isStandalonePwa();
if (document.documentElement) {
  document.documentElement.classList.toggle("pwa", isPwaStandalone);
}
if (document.body) {
  document.body.classList.toggle("mobile-ui", isMobileUi);
  document.body.classList.toggle("pwa-standalone", isPwaStandalone);
}
/** @type {NavigationControl | null} */
let mapNavControl = null;
if (!isMobileUi) {
  mapNavControl = new NavigationControl({ visualizePitch: true });
  map.addControl(mapNavControl, "bottom-right");
}
const geolocateControl = new GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true,
  // Updated whenever locate runs — see syncGeolocateFitPadding()
  fitBoundsOptions: {
    maxZoom: 15.8,
    duration: 850,
    padding: { top: 48, bottom: 280, left: 16, right: 56 },
  },
});
map.addControl(geolocateControl, "bottom-right");
// Same corner as tools so © stacks under the button group
map.addControl(new AttributionControl({ compact: false }), "bottom-right");

/**
 * Camera padding for the *visible* map (panel / sheet / tools cover parts of the
 * canvas). fitBounds / flyTo / easeTo use this so the visual centre is not under UI.
 * @param {{ top?: number, right?: number, bottom?: number, left?: number }} [extra]
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
function mapVisiblePadding(extra = {}) {
  const mapEl = map.getContainer?.() || document.getElementById("map");
  const mapRect = mapEl?.getBoundingClientRect?.();
  const vw = mapRect?.width || window.innerWidth || 390;
  const vh = mapRect?.height || window.innerHeight || 700;
  const mapLeft = mapRect?.left || 0;
  const mapTop = mapRect?.top || 0;
  const mapRight = mapLeft + vw;
  const mapBottom = mapTop + vh;

  const isDesktop =
    typeof matchMedia !== "undefined" &&
    matchMedia("(min-width: 641px)").matches;

  let top = 16;
  let right = 16;
  let bottom = 16;
  let left = 16;

  // Safe areas (notch / home indicator) when map is edge-to-edge
  try {
    const cs = getComputedStyle(document.documentElement);
    const safeTop = parseFloat(cs.getPropertyValue("--safe-top")) || 0;
    const safeBottom = parseFloat(cs.getPropertyValue("--safe-bottom")) || 0;
    // env() often returns "XXpx" via our CSS vars
    if (Number.isFinite(safeTop)) top = Math.max(top, Math.ceil(safeTop) + 8);
    if (Number.isFinite(safeBottom) && isDesktop) {
      bottom = Math.max(bottom, Math.ceil(safeBottom) + 8);
    }
  } catch {
    /* ignore */
  }

  const toolbar = document.getElementById("main-toolbar");
  const stack = document.getElementById("panel-bottom-stack");

  // BR control stack (geolocate / nav buttons) — measure the real button
  // column instead of reserving a blind 56px, which shifts fits left.
  // Attribution is stroked pointer-events:none text — fits may pass under it.
  let brReserve = 0;
  try {
    const brGroup = document.querySelector(
      ".maplibregl-ctrl-bottom-right .maplibregl-ctrl-group",
    );
    const br = brGroup?.getBoundingClientRect?.();
    if (br && br.width > 4 && br.top < mapBottom && br.bottom > mapTop) {
      brReserve = Math.ceil(mapRight - br.left) + 6;
    }
  } catch {
    /* ignore */
  }

  if (isDesktop) {
    // Left panel covers the map
    if (toolbar) {
      const tr = toolbar.getBoundingClientRect();
      if (tr.width > 40 && tr.right > mapLeft) {
        left = Math.max(left, Math.ceil(tr.right - mapLeft) + 16);
      }
    }
    // Room for BR tools (measured; fallback for hidden/unmounted controls)
    right = Math.max(right, brReserve || 44);
    bottom = Math.max(bottom, 28);
    top = Math.max(top, 20);
  } else {
    // Bottom sheet + dock cover the lower map
    let sheetTop = null;
    if (toolbar) {
      const tr = toolbar.getBoundingClientRect();
      if (tr.height > 20 && tr.top < mapBottom) sheetTop = tr.top;
    }
    // Dock is a sibling overlay; if sheet is collapsed short, still clear dock
    if (stack) {
      const sr = stack.getBoundingClientRect();
      if (sr.height > 20 && sr.top < mapBottom) {
        sheetTop =
          sheetTop == null ? sr.top : Math.min(sheetTop, sr.top);
      }
    }
    if (sheetTop != null) {
      bottom = Math.max(bottom, Math.ceil(mapBottom - sheetTop) + 14);
    } else {
      // Fallback: CSS tokens (content + dock)
      try {
        const cs = getComputedStyle(document.documentElement);
        const sheetH =
          parseFloat(cs.getPropertyValue("--sheet-h")) || 220;
        const dockH =
          parseFloat(cs.getPropertyValue("--nav-dock-h")) || 80;
        bottom = Math.max(bottom, Math.ceil(sheetH + dockH + 14));
      } catch {
        bottom = Math.max(bottom, 240);
      }
    }
    // Map tools on the right (measured button column; © is non-blocking)
    right = Math.max(right, brReserve || 44);
    top = Math.max(top, 12);
  }

  // Cap so map still has a usable centre (never pad more than ~70% of an axis)
  const maxL = Math.floor(vw * 0.62);
  const maxB = Math.floor(vh * 0.72);
  bottom = Math.min(bottom, maxB);
  right = Math.min(right, Math.floor(vw * 0.35));
  // Balance horizontal padding so fits centre in the open area — the BR
  // control reserve otherwise pulls the visual centre toward the left.
  left = Math.min(Math.max(left, right), maxL);
  top = Math.min(top, Math.floor(vh * 0.25));

  return {
    top: Math.max(0, top + (Number(extra.top) || 0)),
    right: Math.max(0, right + (Number(extra.right) || 0)),
    bottom: Math.max(0, bottom + (Number(extra.bottom) || 0)),
    left: Math.max(0, left + (Number(extra.left) || 0)),
  };
}

/** Keep MapLibre locate control centred on the *visible* map, not under the sheet. */
function syncGeolocateFitPadding() {
  try {
    const pad = mapVisiblePadding();
    geolocateControl.options.fitBoundsOptions = {
      ...(geolocateControl.options.fitBoundsOptions || {}),
      maxZoom: 15.8,
      duration: 850,
      padding: pad,
    };
  } catch {
    /* ignore */
  }
}

/**
 * Disengage the locate control's camera-follow before a programmatic fit.
 * MapLibre only drops its ACTIVE_LOCK on user gestures: the control's
 * movestart handler bails out while isZooming() is true, which every
 * flyTo/fitBounds sets before firing movestart — so the lock survives a
 * route fit and the next position fix snaps the camera back to the user,
 * undoing the fit. stop() ends any in-flight locate re-centre animation;
 * resize() then emits a genuine movestart (not zooming) that the control
 * treats like a user pan → BACKGROUND: the dot keeps updating, but the
 * camera no longer follows. Also flips nearbyGeoFollow off so the app's
 * own geolocate listener (it re-centres on every fix in ANY control state)
 * stops yanking the camera / resetting a manual browse point too.
 */
function disengageGeolocateFollow() {
  try {
    if (!map || !geolocateControl) return;
    nearbyGeoFollow = false;
    map.stop?.();
    map.resize?.();
  } catch (e) {
    console.warn("[map] disengageGeolocateFollow", e);
  }
}

// Scale — top-centre; shown while zooming, fades after scale settles
const scaleControl = new ScaleControl({ unit: "metric", maxWidth: 120 });
map.addControl(scaleControl, "top-left");

let scaleFadeTimer = null;
function getScaleHost() {
  return document.querySelector(".maplibregl-ctrl-top-left");
}

function showMapScale() {
  const host = getScaleHost();
  if (!host) return;
  host.classList.add("is-scale-visible");
  clearTimeout(scaleFadeTimer);
  scaleFadeTimer = null;
}

function scheduleMapScaleFade(ms = 1400) {
  clearTimeout(scaleFadeTimer);
  scaleFadeTimer = setTimeout(() => {
    getScaleHost()?.classList.remove("is-scale-visible");
    scaleFadeTimer = null;
  }, ms);
}

map.on("zoomstart", showMapScale);
map.on("zoom", showMapScale);
map.on("zoomend", () => scheduleMapScaleFade(1400));
// Pitch/rotate can change apparent scale bar; keep brief flash
map.on("pitchend", () => {
  showMapScale();
  scheduleMapScaleFade(1200);
});
map.on("rotateend", () => {
  showMapScale();
  scheduleMapScaleFade(1200);
});

map.on("load", () => {
  showToast(t("Map ready · streaming hongkong.pmtiles"));
  map.resize();
  // Brief scale flash on first paint, then fade
  showMapScale();
  scheduleMapScaleFade(2200);
  ensureRouteLayers();
  // MTR stations / exits / platforms (wheelstransit crawler GeoJSON)
  bootstrapMtrLayers().catch((err) => {
    console.warn("[mtrLayer]", err);
  });
  // Default Nearby center = user location when permission granted — deferred
  // until the opening splash is gone so the browser permission prompt never
  // pops over the boot animation (bootSplashDonePromise resolves on removal)
  // nor over the first-run onboarding flow (onboardingGate).
  void Promise.all([bootSplashDonePromise, onboardingGate]).then(() =>
    bootstrapNearbyUserLocation({ fly: true, triggerControl: true }),
  );
});

/** Load MTR GeoJSON, enrich search directory, draw layers + click popups. */
async function bootstrapMtrLayers() {
  await loadMtrGeo();
  mergeStationDirectory(stationsFromGeoJson());
  addMtrLayers(map);
  // MTR layers stack above route-stops — put markers back on top
  ensureRouteLayers();
  promoteRouteStopLayers();
  wireMtrClickHandlers();
  console.info("[mtrLayer] layers ready");
}

let mtrPopup = null;
function wireMtrClickHandlers() {
  const layers = [
    "route-stops-circle",
    "mtr-exits-circle",
    "mtr-platforms-circle",
  ];
  for (const layerId of layers) {
    map.on("mouseenter", layerId, () => {
      if (!map.getLayer(layerId)) return;
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
    map.on("click", layerId, (e) => {
      if (!map.getLayer(layerId)) return;
      const f = e.features?.[0];
      if (!f) return;
      e.originalEvent?.stopPropagation?.();
      const html = featurePopupHtml(f);
      if (!html) return;
      const coords =
        f.geometry?.type === "Point"
          ? f.geometry.coordinates.slice(0, 2)
          : e.lngLat.toArray();
      if (mtrPopup) mtrPopup.remove();
      mtrPopup = new Popup({
        closeButton: true,
        maxWidth: "260px",
        className: "mtr-map-popup",
      })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);

      // Board/alight on rail → zoom in for exits
      const code =
        f.properties?.station_code ||
        stationCodeFromName(f.properties?.stop_name || f.properties?.name_en);
      if (
        code &&
        (layerId === "route-stops-circle" || layerId === "mtr-platforms-circle")
      ) {
        if (map.getZoom() < 15) {
          map.easeTo({
            center: coords,
            zoom: Math.max(map.getZoom(), 15.2),
            duration: 500,
            padding: mapVisiblePadding(),
          });
        }
      }
    });
  }
}

map.on("error", (e) => {
  const err = e?.error || e;
  console.error("[map]", err);
  const msg =
    err?.message ||
    (typeof err === "string" ? err : t("Map failed to load tiles"));
  // Devices without WebGL2 (older Android WebView/Chrome) never render — the
  // persistent card beats a silent black canvas.
  if (err?.name === "GPUInitializationError" || String(msg).includes("WebGL2")) {
    showGlFallback(null);
    return;
  }
  // COEP noise is common for glyph/sprite hosts without CORP — don't spam toast
  if (String(msg).includes("Failed to fetch") && !map.isStyleLoaded()) {
    showToast(t("Map error: {msg}", { msg }), 6000);
  }
});

// Mobile GPUs can lose the WebGL context under memory pressure. MapLibre
// restores it when the browser fires `webglcontextrestored`; when that never
// comes (GPU process died) the canvas stays black — recover via guarded reload.
const GL_RECOVERY_KEY = "mt.gl-recovery-count";
const GL_RECOVERY_WINDOW_MS = 60000;
const GL_RECOVERY_MAX = 2;
let glRestoreTimer = null;

function glRecoveryCount() {
  try {
    const raw = sessionStorage.getItem(GL_RECOVERY_KEY);
    if (!raw) return 0;
    const [ts, n] = raw.split(":");
    return Date.now() - Number(ts) < GL_RECOVERY_WINDOW_MS ? Number(n) || 0 : 0;
  } catch {
    return 0;
  }
}

function reloadForGlRecovery() {
  const count = glRecoveryCount() + 1;
  try {
    sessionStorage.setItem(GL_RECOVERY_KEY, `${Date.now()}:${count}`);
  } catch {
    /* private mode */
  }
  if (count > GL_RECOVERY_MAX) {
    console.error(
      "[map] repeated context loss — giving up on auto-reload",
      mapDiagnostics(),
    );
    showGlFallback(t("The map's graphics engine keeps failing. Reload the page to try again."));
    return;
  }
  showToast(t("Map didn't recover — reloading…"), 2500);
  setTimeout(() => location.reload(), 900);
}

map.on("webglcontextlost", () => {
  console.warn("[map] WebGL context lost — waiting for restore");
  showToast(t("Map rendering paused — recovering…"), 4000);
  clearTimeout(glRestoreTimer);
  glRestoreTimer = setTimeout(() => {
    console.warn("[map] WebGL context not restored — reloading", mapDiagnostics());
    reloadForGlRecovery();
  }, 6000);
});

map.on("webglcontextrestored", () => {
  clearTimeout(glRestoreTimer);
  console.info("[map] WebGL context restored");
  showToast(t("Map resumed"), 2000);
});

// ── Black-canvas detector — ANGLE/Vulkan translation failures on Android ─────
// Some Android GPU drivers accept the WebGL2 context but present nothing (a
// known class of ANGLE→Vulkan translation bugs): MapLibre's render loop runs
// and tiles load, yet the canvas stays black with no error event. Sample the
// framebuffer while a frame is being drawn; if the style has fully loaded but
// the canvas is uniformly black, force one repaint, then surface a card.
const BLACK_GRID = [0.25, 0.5, 0.75]; // sampling fractions per axis
const BLACK_MAX_RGBA = 24; // sum of RGBA below which a pixel counts as black
const BLACK_SAMPLES_REQUIRED = 2; // consecutive black frames before acting
let blackFrameCount = 0;
let blackVerdict = null; // null | "retry" | "broken"

function sampleCanvasAllBlack() {
  try {
    const canvas = map.getCanvas();
    const gl = canvas.getContext("webgl2");
    if (!gl || canvas.width < 8 || canvas.height < 8) return false;
    const px = new Uint8Array(4);
    for (const fx of BLACK_GRID) {
      for (const fy of BLACK_GRID) {
        gl.readPixels(
          Math.floor(canvas.width * fx),
          Math.floor(canvas.height * fy),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        );
        if (px[0] + px[1] + px[2] + px[3] > BLACK_MAX_RGBA) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

map.on("render", () => {
  if (blackVerdict || !map.loaded() || document.visibilityState !== "visible") {
    return;
  }
  if (!sampleCanvasAllBlack()) {
    blackFrameCount = 0;
    return;
  }
  if (++blackFrameCount < BLACK_SAMPLES_REQUIRED) return;
  blackVerdict = "retry";
  // One cheap self-heal before declaring the device broken.
  map.resize();
  map.triggerRepaint();
  setTimeout(() => {
    if (map.loaded() && sampleCanvasAllBlack()) {
      blackVerdict = "broken";
      console.error(
        "[map] canvas stayed black after forced repaint — likely an ANGLE/Vulkan translation bug",
        mapDiagnostics(),
      );
      showGlFallback(
        "The map isn't drawing — this device's GPU translation (ANGLE/Vulkan) is failing. Update Chrome or Android System WebView; if it persists, open chrome://flags, set “Choose ANGLE graphics backend” to OpenGL, and relaunch.",
      );
    } else {
      console.info("[map] canvas recovered after forced repaint");
      blackVerdict = null;
    }
  }, 1000);
});

map.once("idle", () => {
  console.info("[map] idle — style + visible tiles settled");
});

window.addEventListener("resize", () => map.resize());

// ── Trip planning state ──────────────────────────────────────────────────────
/** Secondary pick mode: map tap sets origin, destination, or a via slot */
let pickMode = "destination"; // origin | destination | via
let mapPickArmed = false; // true while user chose "tap map" for a field
let origin = null; // { lat, lon, label? }
let destination = null;
let originMarker = null;
let destMarker = null;
const MAX_VIAS = 5;
let viaSeq = 0;
/** Which via slot map-pick / setPoint("via") writes to */
let activeViaId = null;
/**
 * Ordered meet-up waypoints between From and To.
 * @type {Array<{
 *   id: string,
 *   point: { lat: number, lon: number, label: string, isMtr?: boolean, isLrt?: boolean } | null,
 *   marker: import("maplibre-gl").Marker | null,
 *   field: HTMLElement,
 *   input: HTMLInputElement,
 *   list: HTMLElement,
 * }>}
 */
let vias = [];
let plans = [];
let searchTimers = { origin: null, destination: null };
let searchAbort = { origin: null, destination: null };

const PLAN_POINT_KINDS = ["origin", "destination", "via"];

function isViaSlot(which) {
  return which === "via" || String(which).startsWith("via:");
}

function viaIdFromSlot(which) {
  if (which === "via") return activeViaId || vias[vias.length - 1]?.id || null;
  if (String(which).startsWith("via:")) return which.slice(4);
  return null;
}

function viaSlotKey(id) {
  return `via:${id}`;
}

function getViaSlot(id) {
  return vias.find((v) => v.id === id) || null;
}

function allSearchSlots() {
  return ["origin", "destination", ...vias.map((v) => viaSlotKey(v.id))];
}

function setPickMode(mode, { armMap = true, viaId = null } = {}) {
  pickMode = mode;
  mapPickArmed = armMap;
  if (mode === "via") {
    activeViaId = viaId || viaIdFromSlot("via");
  }
  els.btnPickOrigin?.classList.toggle("active", mode === "origin");
  els.btnPickDest?.classList.toggle("active", mode === "destination");
  els.mapPickHint?.classList.toggle("is-picking", mapPickArmed);
  if (mapPickArmed) {
    const toast =
      mode === "origin"
        ? t("Tap the map to set origin")
        : mode === "via"
          ? t("Tap the map to set via")
          : t("Tap the map to set destination");
    showToast(toast, 2200);
  }
}

function syncViaUi() {
  vias.forEach((slot, i) => {
    const idxEl = slot.field.querySelector("[data-via-idx]");
    if (idxEl) idxEl.textContent = vias.length > 1 ? ` ${i + 1}` : "";
    if (slot.marker?.getElement) {
      slot.marker.getElement().title =
        vias.length > 1 ? t("Via {n}", { n: i + 1 }) : t("Via");
    }
  });
  if (els.btnAddVia) els.btnAddVia.hidden = vias.length >= MAX_VIAS;
}

function addViaSlot({ focus = true } = {}) {
  if (vias.length >= MAX_VIAS) {
    showToast(t("You can add up to {n} vias", { n: MAX_VIAS }), 2200);
    return null;
  }
  const id = `v${++viaSeq}`;
  const field = document.createElement("div");
  field.className = "loc-field loc-field-via";
  field.dataset.field = "via";
  field.dataset.viaId = id;
  const inputId = `input-via-${id}`;
  const listId = `suggest-via-${id}`;
  field.innerHTML = `
    <label class="loc-label" for="${inputId}">
      <span class="material-symbols-outlined" aria-hidden="true">group</span>
      <span>Via</span><span data-via-idx></span>
    </label>
    <div class="loc-input-row">
      <input
        id="${inputId}"
        class="loc-input"
        type="search"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="e.g. Times Square · meet here"
        aria-autocomplete="list"
        aria-controls="${listId}"
      />
      <button
        type="button"
        class="btn btn-icon"
        data-via-clear
        data-acrylic
        title="Clear via"
        aria-label="Clear via"
      >
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </div>
    <ul
      id="${listId}"
      class="loc-suggest"
      hidden
      role="listbox"
      aria-label="Via suggestions"
    ></ul>`;
  els.viaStack?.appendChild(field);
  applyLangToDom(field);
  const input = field.querySelector("input");
  const list = field.querySelector("ul");
  const slot = { id, point: null, marker: null, field, input, list };
  vias.push(slot);
  activeViaId = id;
  wireSearchInput(input, viaSlotKey(id));
  field.querySelector("[data-via-clear]")?.addEventListener("click", () => {
    removeViaSlot(id);
    showToast(t("Via cleared"), 1400);
  });
  syncViaUi();
  if (focus) requestAnimationFrame(() => input?.focus());
  return slot;
}

function removeViaSlot(id) {
  const idx = vias.findIndex((v) => v.id === id);
  if (idx < 0) return;
  const slot = vias[idx];
  const key = viaSlotKey(id);
  hideSuggest(key);
  clearTimeout(searchTimers[key]);
  searchAbort[key]?.abort();
  delete searchTimers[key];
  delete searchAbort[key];
  delete lastResults[key];
  slot.marker?.remove();
  slot.field.remove();
  vias.splice(idx, 1);
  if (activeViaId === id) activeViaId = vias[vias.length - 1]?.id || null;
  syncViaUi();
  updatePlanButton();
}

function ensureViaSlot(viaId) {
  if (viaId) {
    const existing = getViaSlot(viaId);
    if (existing) return existing;
  }
  if (activeViaId) {
    const active = getViaSlot(activeViaId);
    if (active) return active;
  }
  return vias[vias.length - 1] || addViaSlot({ focus: false });
}

function readPrefCheckboxes() {
  /** @type {Array<"fastest"|"simplest"|"cheapest">} */
  const selected = [];
  document.querySelectorAll('input[name="route-pref"]').forEach((el) => {
    if (!(el instanceof HTMLInputElement) || !el.checked) return;
    if (el.value === "fastest" || el.value === "simplest" || el.value === "cheapest") {
      selected.push(el.value);
    }
  });
  return selected;
}

function syncPrefCheckboxes(prefs) {
  const set = new Set(prefs?.length ? prefs : ["fastest"]);
  document.querySelectorAll('input[name="route-pref"]').forEach((el) => {
    if (el instanceof HTMLInputElement) {
      el.checked = set.has(el.value);
    }
  });
}

function initRoutePreferenceUi() {
  syncPrefCheckboxes(routePreferences);
  document.querySelectorAll('input[name="route-pref"]').forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.addEventListener("change", () => {
      let selected = readPrefCheckboxes();
      // Keep at least one option on
      if (!selected.length) {
        el.checked = true;
        selected = readPrefCheckboxes();
        showToast(t("Select at least one preference"), 1600);
      }
      routePreferences = saveRoutePreferences(selected);
      syncPrefCheckboxes(routePreferences);
      showToast(t("Prefer {prefs}", { prefs: formatPreferencesLabel(routePreferences) }), 1800);
      if (origin && destination && isRouterReady()) {
        runPlan();
      }
    });
  });
}
initRoutePreferenceUi();

function readNamedCheckboxes(name, isValid) {
  const selected = [];
  document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
    if (!(el instanceof HTMLInputElement) || !el.checked) return;
    if (isValid(el.value)) selected.push(el.value);
  });
  return selected;
}

function syncNamedCheckboxes(name, values) {
  const set = new Set(values || []);
  document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
    if (el instanceof HTMLInputElement) {
      el.checked = set.has(el.value);
    }
  });
}

function initBusCompanyUi() {
  syncNamedCheckboxes("bus-company", busCompanies);
  document.querySelectorAll('input[name="bus-company"]').forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.addEventListener("change", () => {
      let selected = readNamedCheckboxes("bus-company", isBusCompany);
      if (!selected.length) {
        el.checked = true;
        selected = readNamedCheckboxes("bus-company", isBusCompany);
        showToast(t("Select at least one bus company"), 1600);
      }
      busCompanies = saveBusCompanies(selected);
      syncNamedCheckboxes("bus-company", busCompanies);
      showToast(t("Bus · {label}", { label: formatBusCompaniesLabel(busCompanies) }), 1600);
      if (origin && destination && isRouterReady()) runPlan();
    });
  });
}
initBusCompanyUi();

function initTrafficMethodUi() {
  syncNamedCheckboxes("traffic-method", trafficMethods);
  document.querySelectorAll('input[name="traffic-method"]').forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.addEventListener("change", () => {
      let selected = readNamedCheckboxes("traffic-method", isTrafficMethod);
      if (!selected.length) {
        el.checked = true;
        selected = readNamedCheckboxes("traffic-method", isTrafficMethod);
        showToast(t("Select at least one traffic method"), 1600);
      }
      trafficMethods = saveTrafficMethods(selected);
      syncNamedCheckboxes("traffic-method", trafficMethods);
      showToast(t("Modes · {modes}", { modes: formatTrafficMethodsLabel(trafficMethods) }), 1600);
      if (origin && destination && isRouterReady()) runPlan();
    });
  });
}
initTrafficMethodUi();

function initServiceDayUi() {
  serviceDay = loadServiceDay();
  const radios = document.querySelectorAll('input[name="service-day"]');
  if (!radios.length) return;
  radios.forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.checked = el.value === serviceDay;
    el.addEventListener("change", () => {
      if (!el.checked) return;
      if (!isServiceDay(el.value)) return;
      serviceDay = saveServiceDay(el.value);
      showToast(t("Mode · {mode}", { mode: formatServiceDayLabel(serviceDay) }), 1600);
      if (origin && destination && isRouterReady()) runPlan();
    });
  });
}
initServiceDayUi();

function syncDepartTimeUi() {
  const input = document.getElementById("input-depart-time");
  const row = document.querySelector(".depart-time-row");
  const note = document.getElementById("depart-time-note");
  const isNow = departTime === "now" || !parseDepartTimeHm(departTime);
  if (input instanceof HTMLInputElement) {
    // type=time wants HH:MM
    input.value = isNow ? hongKongHmString() : parseDepartTimeHm(departTime) || hongKongHmString();
  }
  row?.classList.toggle("is-now", isNow);
  if (note) {
    note.innerHTML = isNow
      ? `${t("Default:")} <strong>${escapeHtml(t("Now"))}</strong> ${t("(Hong Kong time, UTC+8). Live clock.")}`
      : `${t("Fixed time")} <strong>${escapeHtml(String(parseDepartTimeHm(departTime) || departTime))}</strong> ${t("(UTC+8). Reset returns to Now.")}`;
  }
}

/**
 * Source of truth for planning: fixed HH:MM from the input if set, else Now.
 * Always re-reads the DOM so Plan trip never uses a stale "now".
 * @returns {import("./preferences.js").DepartTimeValue}
 */
function hmToMins(hm) {
  const p = parseDepartTimeHm(hm);
  if (!p) return null;
  const [hh, mm] = p.split(":").map(Number);
  return hh * 60 + mm;
}

function resolveDepartTimeForPlan() {
  const input = document.getElementById("input-depart-time");
  const row = document.querySelector(".depart-time-row");
  const inputHm =
    input instanceof HTMLInputElement ? parseDepartTimeHm(input.value) : null;
  const nowHm = hongKongHmString();
  // Time pickers often skip `input` until blur. If the field no longer
  // matches Now, honor it — otherwise Plan still searches from 02:00 and
  // RAPTOR's 3h wait never reaches first MTR (~06:00).
  if (inputHm) {
    const a = hmToMins(inputHm);
    const b = hmToMins(nowHm);
    if (a != null && b != null && Math.abs(a - b) > 1) {
      departTime = saveDepartTime(inputHm);
      row?.classList.remove("is-now");
      return inputHm;
    }
  }
  const usingNow =
    departTime === "now" &&
    (!row || row.classList.contains("is-now"));
  if (!usingNow && inputHm) {
    departTime = saveDepartTime(inputHm);
    return inputHm;
  }
  if (departTime !== "now") {
    const hm = parseDepartTimeHm(departTime);
    if (hm) return hm;
  }
  return "now";
}

function initDepartTimeUi() {
  // Default is always Now unless user saved a fixed HH:MM
  departTime = loadDepartTime();
  if (departTime !== "now" && !parseDepartTimeHm(departTime)) {
    departTime = saveDepartTime("now");
  }
  const input = document.getElementById("input-depart-time");
  const btn = document.getElementById("btn-depart-reset");
  syncDepartTimeUi();

  btn?.addEventListener("click", () => {
    departTime = saveDepartTime("now");
    syncDepartTimeUi();
    showToast(t("Departure · Now (UTC+8)"), 1400);
    if (origin && destination && isRouterReady()) runPlan();
  });

  if (input instanceof HTMLInputElement) {
    const applyFixed = () => {
      const hm = parseDepartTimeHm(input.value);
      if (!hm) return;
      departTime = saveDepartTime(hm);
      syncDepartTimeUi();
      showToast(t("Departure · {time}", { time: formatDepartTimeLabel(departTime) }), 1400);
      if (origin && destination && isRouterReady()) runPlan();
    };
    // change + input: some browsers only fire one when using the time picker
    input.addEventListener("change", applyFixed);
    input.addEventListener("input", () => {
      const hm = parseDepartTimeHm(input.value);
      if (!hm) return;
      // Persist immediately so Plan trip never still has "now"
      departTime = saveDepartTime(hm);
      document.querySelector(".depart-time-row")?.classList.remove("is-now");
    });
  }

  // Keep displayed Hong Kong clock fresh while "Now" is selected
  setInterval(() => {
    if (departTime === "now") {
      const inputEl = document.getElementById("input-depart-time");
      if (inputEl instanceof HTMLInputElement && document.activeElement !== inputEl) {
        inputEl.value = hongKongHmString();
      }
    }
  }, 15_000);
}
initDepartTimeUi();

/** Re-price open results when the ticket type changes (no full re-route needed). */
function repricePlansForFareType() {
  if (!plans?.length) return false;
  const type = getFareType();
  plans = plans.map((p) => ({
    ...p,
    fare: estimatePlanFare(p, type),
  }));
  // Re-render cards (no debug meta line anymore — just refresh the list)
  renderPlans(plans, 0, { bothMtr: !!(origin?.isMtr && destination?.isMtr) });
  return true;
}

/** Localize Settings fare-type dropdown labels + tooltips (dict keys). */
function localizeFareTypeSelect() {
  const sel = document.getElementById("select-fare-type");
  if (!sel) return;
  for (const opt of sel.options) {
    const labelKey = FARE_TYPE_LABELS[opt.value];
    if (labelKey) opt.textContent = t(labelKey);
    const hintKey = FARE_TYPE_HINTS[opt.value];
    if (hintKey) opt.title = t(hintKey);
  }
}

function initFareTypeUi() {
  const sel = document.getElementById("select-fare-type");
  if (!(sel instanceof HTMLSelectElement)) return;
  fareType = loadFareType();
  setFareType(fareType);
  // Migrate stale option values still in localStorage
  if (![...sel.options].some((o) => o.value === fareType)) {
    fareType = setFareType("octopus_adult");
  }
  sel.value = fareType;
  localizeFareTypeSelect();
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (!isFareType(v)) return;
    fareType = setFareType(v);
    showToast(t("Fare · {fare}", { fare: formatFareTypeLabel(fareType) }), 1800);
    // Reprice open trip plans
    if (repricePlansForFareType()) {
      // still refresh ETA detail fares if that page is open
    } else if (origin && destination && isRouterReady()) {
      runPlan();
    }
    // Refresh route-detail stop fares (same global ticket type)
    if (
      typeof sidebarPage !== "undefined" &&
      sidebarPage === "eta-route" &&
      etaSelectedForDetails
    ) {
      void showEtaRouteDetailsPanel();
    }
  });
}
initFareTypeUi();

/** Count entries + decoded bytes across the offline data caches. */
async function dataCacheStats() {
  const cachesList = await Promise.all([
    caches.open("mtravelers-data-v3"),
    caches.open("mtravelers-tiles-v1"),
  ]);
  let keys = 0;
  let bytes = 0;
  for (const cache of cachesList) {
    for (const req of await cache.keys()) {
      keys += 1;
      const res = await cache.match(req);
      const len = Number(res?.headers?.get("content-length") || 0);
      if (Number.isFinite(len) && len > 0) bytes += len;
    }
  }
  return { keys, bytes };
}

/** Delete every offline-data cache (data, tiles, and any staging). */
async function clearOfflineCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((n) => /^mtravelers-(data|tiles|stage)-/.test(n))
      .map((n) => caches.delete(n)),
  );
}

/**
 * Turning the Data cache off deletes the downloaded set — ask first.
 * @param {HTMLInputElement} onRadio the “On” radio, re-checked on cancel
 * @param {(enabled: boolean) => void} applyPref
 */
async function confirmDisableCache(onRadio, applyPref) {
  let sizeNote = "";
  try {
    const { keys, bytes } = await dataCacheStats();
    sizeNote = ` (${keys} assets · ${(bytes / 1048576).toFixed(1)} MB)`;
  } catch {
    /* caches unavailable — fall back to generic copy */
  }
  const opened = showUpdateDialog({
    title: "Turn off data cache?",
    message: `Your downloaded offline data${sizeNote} will be deleted from this device. You can download it again any time.`,
    confirmLabel: "Delete data",
    cancelLabel: "Keep data",
    onConfirm: async () => {
      applyPref(false);
      try {
        await clearOfflineCaches();
      } catch {
        /* ignore */
      }
      updateDataCacheStatus();
    },
    onCancel: () => {
      onRadio.checked = true;
    },
  });
  if (!opened) onRadio.checked = true;
}

function initDataCacheUi() {
  const toggle = document.getElementById("data-cache-toggle");
  const btn = document.getElementById("btn-download-offline");
  if (!toggle) return;
  toggle.checked = loadDataCachePref();
  // The download option and data-source picker only make sense while
  // caching is enabled.
  const sourceField = document.getElementById("data-source-field");
  const cloud = document.getElementById("data-source-cloud");
  const local = document.getElementById("data-source-local");
  /** No downloaded set can exist with the cache off — force Cloud back. */
  const resetDataSourceToCloud = () => {
    if (cloud) cloud.checked = true;
    if (local) local.checked = false;
    saveDataSourcePref("cloud");
    notifyDataSourcePref();
  };
  if (!loadDataCachePref()) resetDataSourceToCloud();
  const syncButtonVisibility = () => {
    if (btn) btn.hidden = !toggle.checked;
    if (sourceField) {
      sourceField.classList.toggle("is-disabled", !toggle.checked);
      for (const input of sourceField.querySelectorAll("input")) {
        input.disabled = !toggle.checked;
      }
    }
  };
  syncButtonVisibility();
  const applyPref = (enabled) => {
    toggle.checked = enabled;
    const next = saveDataCachePref(enabled);
    notifyDataCachePref();
    if (!next) resetDataSourceToCloud();
    showToast(
      next
        ? t("Data cache enabled")
        : t("Data cache disabled — data source reset to Cloud"),
      next ? 1800 : 2600,
    );
    syncButtonVisibility();
  };
  toggle.addEventListener("change", () => {
    if (!toggle.checked) {
      // Turning the cache off deletes the downloaded set — ask first.
      void confirmDisableCache(toggle, applyPref);
      return;
    }
    applyPref(true);
  });
}
initDataCacheUi();

/**
 * Settings → “Prefer data source”: Cloud (live data first, downloaded copy
 * as the offline fallback — default) or Local (serve the downloaded copy
 * directly to save mobile data). Synced to the SW on every change.
 */
function initDataSourceUi() {
  const cloud = document.getElementById("data-source-cloud");
  const local = document.getElementById("data-source-local");
  if (!cloud || !local) return;
  (loadDataSourcePref() === "local" ? local : cloud).checked = true;
  const sync = () => {
    const prefer = saveDataSourcePref(local.checked ? "local" : "cloud");
    notifyDataSourcePref();
    showToast(t("Prefer {prefer} data", { prefer: t(prefer === "local" ? "Local" : "Cloud") }), 1800);
  };
  cloud.addEventListener("change", sync);
  local.addEventListener("change", sync);
}
initDataSourceUi();

/** Floating banner while the app runs entirely on cached data (offline). */
function initOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;
  const apply = () => {
    banner.hidden = navigator.onLine !== false;
  };
  window.addEventListener("online", apply);
  window.addEventListener("offline", apply);
  apply();
}
initOfflineBanner();

/** Beta warning banner — visible only while the live bus position engine runs. */
let betaBannerEl = null;
const BETA_BANNER_DISMISS_KEY = "morgan.betaBannerDismissed";
function betaBannerDismissed() {
  try {
    return sessionStorage.getItem(BETA_BANNER_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function setBetaBannerDismissed(v) {
  try {
    if (v) sessionStorage.setItem(BETA_BANNER_DISMISS_KEY, "1");
    else sessionStorage.removeItem(BETA_BANNER_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}
function syncBetaBanner() {
  if (!betaBannerEl) return;
  betaBannerEl.hidden =
    !busPosEngine?.running || !loadBetaBannerPref() || betaBannerDismissed();
}
function initBetaBanner() {
  betaBannerEl = document.getElementById("beta-banner");
  if (!betaBannerEl) return;
  initBetaBannerSwipe();
  initBetaBannerClose();
  initBetaBannerPrefUi();
  // Starts hidden; syncBetaBanner() flips it with the engine lifecycle.
}
initBetaBanner();

/** Dismiss the banner for the rest of the session (swipe or close button). */
function dismissBetaBanner() {
  if (!betaBannerEl || betaBannerEl.hidden) return;
  // Hidden for the rest of the session; the Settings toggle is permanent.
  setBetaBannerDismissed(true);
  betaBannerEl.style.transition = "transform 0.22s ease, opacity 0.22s ease";
  betaBannerEl.style.transform = "translateY(-120%)";
  betaBannerEl.style.opacity = "0";
  window.setTimeout(() => {
    betaBannerEl.hidden = true;
    betaBannerEl.style.transition = "";
    betaBannerEl.style.transform = "";
    betaBannerEl.style.opacity = "";
  }, 240);
}

/** Desktop close button — same session dismissal as the swipe. */
function initBetaBannerClose() {
  const btn = document.getElementById("beta-banner-close");
  btn?.addEventListener("click", dismissBetaBanner);
}

/** Swipe up on the banner to dismiss it for the rest of the session. */
function initBetaBannerSwipe() {
  let startY = null;
  let dy = 0;
  let dragging = false;
  const clearStyles = () => {
    betaBannerEl.style.transition = "";
    betaBannerEl.style.transform = "";
    betaBannerEl.style.opacity = "";
  };
  betaBannerEl.addEventListener(
    "touchstart",
    (e) => {
      if (betaBannerEl.hidden || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = false;
      betaBannerEl.style.transition = "none";
    },
    { passive: true },
  );
  betaBannerEl.addEventListener(
    "touchmove",
    (e) => {
      if (startY == null) return;
      dy = e.touches[0].clientY - startY;
      if (dy > 0 && !dragging) return;
      if (dy < -8) dragging = true;
      const p = Math.max(-160, dy);
      betaBannerEl.style.transform = `translateY(${p}px)`;
      betaBannerEl.style.opacity = String(1 - Math.min(1, -dy / 160));
    },
    { passive: true },
  );
  const finish = (dismiss) => {
    if (dismiss) {
      dismissBetaBanner();
    } else {
      // Below the threshold — spring back.
      betaBannerEl.style.transition = "transform 0.2s ease, opacity 0.2s ease";
      betaBannerEl.style.transform = "";
      betaBannerEl.style.opacity = "";
      window.setTimeout(clearStyles, 220);
    }
  };
  betaBannerEl.addEventListener("touchend", () => {
    if (startY == null) return;
    const was = dy;
    startY = null;
    dragging = false;
    finish(was <= -60);
  });
  betaBannerEl.addEventListener("touchcancel", () => {
    if (startY == null) return;
    startY = null;
    dragging = false;
    finish(false);
  });
}

/** Settings → Beta warning banner: persistent show/hide for the banner. */
function initBetaBannerPrefUi() {
  const tgl = document.getElementById("beta-banner-toggle");
  if (!tgl) return;
  tgl.checked = loadBetaBannerPref();
  tgl.addEventListener("change", () => {
    if (!tgl.checked) {
      const opened = showUpdateDialog({
        title: t("Hide beta banner?"),
        message: t("Turning off the banner means you understand and agree that predicted live bus positions are inaccurate and for reference only."),
        confirmLabel: t("I understand"),
        cancelLabel: t("Keep banner"),
        onConfirm: () => {
          saveBetaBannerPref(false);
          showToast(t("Beta banner hidden"), 1600);
          syncBetaBanner();
        },
        onCancel: () => {
          tgl.checked = true;
        },
      });
      if (!opened) tgl.checked = true;
      return;
    }
    saveBetaBannerPref(true);
    setBetaBannerDismissed(false);
    showToast(t("Beta banner enabled"), 1600);
    syncBetaBanner();
  });
}

/**
 * Ran on downloaded data (offline) and connectivity returns — the loaded
 * state is stale, so ask the user to restart for fresh cloud data. One
 * prompt per session; “Not now” silences it until the next reload.
 */
function initReconnectPrompt() {
  let wasOffline = navigator.onLine === false;
  let prompted = false;
  const maybePrompt = () => {
    if (!wasOffline || prompted) return;
    prompted = true;
    const opened = showUpdateDialog({
      title: t("Back online"),
      message: t("You were running on downloaded data. Restart to load the latest data from the cloud."),
      confirmLabel: t("Restart now"),
      cancelLabel: t("Not now"),
      onConfirm: () => {
        try {
          location.reload();
        } catch {
          /* ignore */
        }
      },
    });
    if (!opened) {
      // Another prompt (app/data update) is showing — try again shortly.
      prompted = false;
      setTimeout(maybePrompt, 5000);
    }
  };
  window.addEventListener("offline", () => {
    wasOffline = true;
  });
  window.addEventListener("online", maybePrompt);
}
initReconnectPrompt();

/**
 * Settings → “Download offline data”: one explicit fetch of the whole
 * dataset into the SW caches. Every file is byte-verified into a staging
 * cache and committed atomically only when ALL files succeed — a quit
 * mid-download discards everything (see sw.js PRECACHE_DATA). Runs under
 * a full-screen black cover reusing the boot-splash animation.
 */
function initOfflineDownloadUi() {
  const btn = document.getElementById("btn-download-offline");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) {
      showToast(t("Reload once so the service worker is active"), 2600);
      return;
    }
    // Downloading implies caching stays on — enable it explicitly.
    saveDataCachePref(true);
    notifyDataCachePref();
    const cacheTgl = document.getElementById("data-cache-toggle");
    if (cacheTgl) cacheTgl.checked = true;
    void startOfflineDownload(sw);
  });
}
initOfflineDownloadUi();

/**
 * Run the offline download under the black cover. Shared by the Settings
 * button and the data-update prompt.
 * @param {ServiceWorker} sw
 */
async function startOfflineDownload(sw) {
  const overlay = document.getElementById("download-overlay");
  const titleEl = document.getElementById("download-overlay-title");
  const bar = document.getElementById("download-progress");
  const fill = document.getElementById("download-progress-fill");
  const sub = document.getElementById("download-overlay-sub");
  const errEl = document.getElementById("download-overlay-error");
  const actions = document.getElementById("download-overlay-actions");
  const retryBtn = document.getElementById("btn-download-retry");
  if (!overlay) return;

  const setProgress = (done, total, totalBytes) => {
    const pct =
      total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (fill) fill.style.width = `${pct}%`;
    if (bar) bar.setAttribute("aria-valuenow", String(pct));
    if (sub) {
      sub.textContent = `${done} / ${total} files · ${(totalBytes / 1048576).toFixed(1)} MB`;
    }
  };

  const close = () => {
    overlay.hidden = true;
  };
  const run = async () => {
    try {
      const urls = await offlineDataManifest();
      if (titleEl) titleEl.textContent = t("Downloading offline data…");
      await precacheOfflineData(sw, urls, setProgress);
      await recordDataUpdatedAt();
      if (titleEl) titleEl.textContent = t("Finishing…");
      await updateDataCacheStatus();
      overlay.hidden = true;
      showToast(t("Offline data ready"), 2600);
    } catch (e) {
      console.warn("[offline] dataset download failed", e);
      if (titleEl) titleEl.textContent = t("Download failed");
      if (errEl) {
        errEl.textContent = String(e?.message || e);
        errEl.hidden = false;
      }
      if (actions) actions.hidden = false;
    }
  };

  overlay.hidden = false;
  if (errEl) errEl.hidden = true;
  if (actions) actions.hidden = true;
  if (titleEl) titleEl.textContent = t("Preparing offline data…");
  if (sub) sub.textContent = t("Preparing manifest…");
  if (fill) fill.style.width = "0";
  if (bar) bar.setAttribute("aria-valuenow", "0");
  document
    .getElementById("btn-download-close")
    ?.addEventListener("click", close);
  retryBtn?.addEventListener("click", () => {
    if (errEl) errEl.hidden = true;
    if (actions) actions.hidden = true;
    if (titleEl) titleEl.textContent = "Preparing offline data…";
    void run();
  });
  await run();
}

/** Remember the data-edge update stamp so future opens can detect refresh. */
async function recordDataUpdatedAt() {
  try {
    const res = await fetch(METADATA_URL, { cache: "no-cache" });
    if (!res.ok) return;
    const meta = await res.json();
    if (meta?.updated_at) {
      localStorage.setItem(DATA_UPDATED_AT_STORAGE_KEY, meta.updated_at);
    }
  } catch {
    /* offline — nothing to record */
  }
}

/** URLs the app reads for launch + routes — everything needed fully offline. */
function offlineDataManifest() {
  const url = (p) => new URL(p, window.location.href).href;
  const urls = [
    url("data/bus-shapes/index.json"),
    url("data/eta-nearby-stops.json"),
    // RBS (NR/DB residents' bus, TD headway GTFS) — browse/search/detail and
    // headway timetable cards depend on these; keep them in the offline set.
    url("data/rbs-routes.json"),
    url("data/rbs-stops.json"),
    url("data/hk.wheelsrouter.gz"),
    url("data/light_rail_routes_and_stops.csv"),
    url("data/mtr_bus_routes.csv"),
    url("data/mtr_bus_stops.csv"),
    url("fares/bbi-compact.json?v=1"),
    url("fares/hk-fares.json?v=5"),
    url("overrides/bus-shapes.json"),
    url("overrides/lrt.json"),
    url("overrides/mtr-access-pins.json"),
    url("mtr/exits.geojson"),
    url("mtr/lrt-platforms.geojson"),
    url("mtr/platforms.geojson"),
    url("mtr/stations.geojson"),
  ];
  return (async () => {
    // Bus-shape agency files (kmb/ctb/nlb/…) come from the index manifest.
    // index.json itself is queued above — routeShapes.js reads it at runtime
    // to resolve agency files, so it must be part of the offline set too.
    try {
      const idxRes = await fetch(url("data/bus-shapes/index.json"), {
        cache: "no-cache",
      });
      if (idxRes.ok) {
        const idx = await idxRes.json();
        const seen = new Set();
        for (const f of Object.values(idx.files || {})) {
          const u = url(`data/bus-shapes/${f}`);
          if (!seen.has(u)) {
            seen.add(u);
            urls.push(u);
          }
        }
        urls.push(url("data/bus-shapes/stops.json"));
      }
    } catch (e) {
      console.warn("[offline] bus-shapes index", e);
    }
    urls.push(PMTILES_URL);
    return urls;
  })();
}

/**
 * Drive the SW precache. The SW downloads into a staging cache (never
 * live); on zero failures the page sends PRECACHE_COMMIT to promote the
 * set atomically, and on any failure it sends PRECACHE_ABORT so the
 * staging cache is discarded. If the page dies before the commit message,
 * the staging set is purged on the next SW activation — a partial dataset
 * can never surface. Resolves on PRECACHE_COMMITTED.
 */
function precacheOfflineData(sw, urls, onProgress) {
  return new Promise((resolve, reject) => {
    const chan = new MessageChannel();
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error("service worker timed out"));
    }, 15 * 60_000);
    chan.port1.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === "PRECACHE_PROGRESS") {
        onProgress?.(d.done, d.total, d.totalBytes || 0);
      } else if (d.type === "PRECACHE_DONE") {
        if (!d.ok) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          chan.port1.close();
          try {
            sw.postMessage({ type: "PRECACHE_ABORT" });
          } catch {
            /* ignore */
          }
          const names = (d.failures || [])
            .slice(0, 3)
            .map((f) => f.url)
            .join(", ");
          reject(new Error(`${d.failures.length} file(s) failed: ${names}`));
          return;
        }
        // All files verified — promote the staging set into the live caches.
        sw.postMessage({ type: "PRECACHE_COMMIT" });
      } else if (d.type === "PRECACHE_COMMITTED") {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chan.port1.close();
        resolve(d);
      }
    };
    sw.postMessage({ type: "PRECACHE_DATA", urls }, [chan.port2]);
  });
}

function initEalFirstClassUi() {
  ealFirstClass = loadEalFirstClass();
  setEalFirstClass(ealFirstClass);
  const radios = document.querySelectorAll('input[name="eal-first-class"]');
  if (!radios.length) return;
  radios.forEach((el) => {
    if (!(el instanceof HTMLInputElement)) return;
    el.checked =
      (ealFirstClass && el.value === "on") ||
      (!ealFirstClass && el.value === "off");
    el.addEventListener("change", () => {
      if (!el.checked) return;
      ealFirstClass = setEalFirstClass(el.value === "on");
      showToast(
        ealFirstClass ? "EAL First Class · On" : "EAL First Class · Off",
        1600,
      );
      if (repricePlansForFareType()) return;
      if (origin && destination && isRouterReady()) runPlan();
    });
  });
}
initEalFirstClassUi();

function initRbsResidentFareUi() {
  rbsResidentFare = loadRbsResidentFare();
  setRbsResidentFare(rbsResidentFare);
  const tgl = document.getElementById("rbs-resident-toggle");
  if (!tgl) return;
  tgl.checked = !!rbsResidentFare;
  tgl.addEventListener("change", () => {
    rbsResidentFare = setRbsResidentFare(!!tgl.checked);
    showToast(
      rbsResidentFare
        ? "RBS · Resident fare on"
        : "RBS · Resident fare off",
      1600,
    );
    if (repricePlansForFareType()) return;
    if (origin && destination && isRouterReady()) runPlan();
  });
}
initRbsResidentFareUi();

function updatePlanButton() {
  const ready = isRouterReady() && origin && destination;
  if (els.btnPlanCta) els.btnPlanCta.disabled = !ready;
}

/**
 * @param {"origin"|"destination"|"via"} kind
 * @param {number} lat
 * @param {number} lon
 * @param {string} [label]
 * @param {{ isMtr?: boolean, isLrt?: boolean, category?: string, type?: string, viaId?: string }} [meta]
 */
function setPoint(kind, lat, lon, label, meta = {}) {
  const el = document.createElement("div");
  el.className = `map-pin map-pin-${kind}`;
  el.title =
    kind === "origin"
      ? t("Origin")
      : kind === "via"
        ? t("Via")
        : t("Destination");

  const marker = new Marker({ element: el, anchor: "bottom" })
    .setLngLat([lon, lat])
    .addTo(map);

  const text = label || fmtCoord(lat, lon);
  // LRT must not be treated as heavy-rail MTR (avoids snap → Tuen Mun TML)
  const lrtByName = matchLrtStop(text, null, null, 0);
  const lrtOnlyName =
    lrtByName &&
    !/^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
      String(lrtByName.name_en || "").trim(),
    );
  const isLrt =
    meta.isLrt === true ||
    /light\s*rail|輕鐵|\blrt\b/i.test(text) ||
    (!!lrtOnlyName && meta.isMtr !== true);
  const isMtr =
    !isLrt &&
    (meta.isMtr === true || looksLikeMtrStation(text, meta));

  const point = { lat, lon, label: text, isMtr, isLrt };

  if (kind === "origin") {
    originMarker?.remove();
    originMarker = marker;
    origin = point;
    if (els.inputOrigin) els.inputOrigin.value = text;
    hideSuggest("origin");
  } else if (kind === "via") {
    const slot = ensureViaSlot(meta.viaId);
    if (!slot) {
      marker.remove();
      return;
    }
    slot.marker?.remove();
    slot.marker = marker;
    slot.point = point;
    if (slot.input) slot.input.value = text;
    activeViaId = slot.id;
    hideSuggest(viaSlotKey(slot.id));
    syncViaUi();
  } else {
    destMarker?.remove();
    destMarker = marker;
    destination = point;
    if (els.inputDest) els.inputDest.value = text;
    hideSuggest("destination");
  }
  updatePlanButton();
  mapPickArmed = false;
  els.mapPickHint?.classList.remove("is-picking");
}

/** @deprecated use setPoint — kept name for map click path */
function placeMarker(kind, lat, lon, label, meta) {
  setPoint(kind, lat, lon, label, meta);
}

/** Extra via pins used when previewing a pinned trip (not form slots). */
let previewViaMarkers = [];
/** True while trip-detail pins came from a pinned/reopened plan, not the live form. */
let tripDetailMarkersArePreview = false;

function snapshotFormEndpoints() {
  return {
    origin: origin ? { ...origin } : null,
    destination: destination ? { ...destination } : null,
    vias: vias.map((v) => (v.point ? { ...v.point } : null)).filter(Boolean),
  };
}

function placeEndpointMarker(kind, lat, lon, title) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const el = document.createElement("div");
  el.className = `map-pin map-pin-${kind}`;
  el.title = title || "";
  try {
    return new Marker({ element: el, anchor: "bottom" })
      .setLngLat([Number(lon), Number(lat)])
      .addTo(map);
  } catch {
    return null;
  }
}

function clearTripEndpointMarkers() {
  originMarker?.remove();
  originMarker = null;
  destMarker?.remove();
  destMarker = null;
  for (const slot of vias) {
    slot.marker?.remove();
    slot.marker = null;
  }
  for (const m of previewViaMarkers) m?.remove();
  previewViaMarkers = [];
}

function showFormEndpointMarkers() {
  clearTripEndpointMarkers();
  if (origin) {
    originMarker = placeEndpointMarker(
      "origin",
      origin.lat,
      origin.lon,
      origin.label || t("Origin"),
    );
  }
  vias.forEach((slot, i) => {
    if (!slot.point) return;
    slot.marker = placeEndpointMarker(
      "via",
      slot.point.lat,
      slot.point.lon,
      vias.length > 1
        ? t("Via {n}", { n: i + 1 })
        : slot.point.label || t("Via"),
    );
  });
  if (destination) {
    destMarker = placeEndpointMarker(
      "destination",
      destination.lat,
      destination.lon,
      destination.label || t("Destination"),
    );
  }
}

function pointFromStopLike(stop, fallbackLabel) {
  const ll = extractStopLonLat(stop);
  if (!ll) return null;
  const label =
    String(stop?.stop_name || stop?.name || stop?.label || fallbackLabel || "").trim();
  return { lat: ll[1], lon: ll[0], label };
}

/** Origin / vias / destination for a stored or live plan. */
function endpointsFromPlan(plan) {
  if (!plan) return { origin: null, destination: null, vias: [] };
  const storedVias = Array.isArray(plan.vias)
    ? plan.vias
    : Array.isArray(plan.via_points)
      ? plan.via_points
      : [];
  if (
    Number.isFinite(plan.origin?.lat) &&
    Number.isFinite(plan.origin?.lon) &&
    Number.isFinite(plan.destination?.lat) &&
    Number.isFinite(plan.destination?.lon)
  ) {
    return {
      origin: plan.origin,
      destination: plan.destination,
      vias: storedVias.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)),
    };
  }
  const legs = plan.legs || [];
  let originPt = null;
  let destPt = null;
  const viaPts = [];
  for (const leg of legs) {
    if (
      leg.type === "meet" &&
      Number.isFinite(leg.via_lat) &&
      Number.isFinite(leg.via_lon)
    ) {
      viaPts.push({
        lat: leg.via_lat,
        lon: leg.via_lon,
        label: leg.via_label || t("Via"),
      });
    }
    if (leg.type === "transit") {
      const opt = leg.route_options?.[0];
      if (!originPt) {
        originPt = pointFromStopLike(
          opt?.from || opt?.stops?.[0],
          plan.fromLabel,
        );
      }
      destPt =
        pointFromStopLike(
          opt?.to || (opt?.stops?.length ? opt.stops[opt.stops.length - 1] : null),
          plan.toLabel,
        ) || destPt;
    }
    if (leg.type === "walk" && Array.isArray(leg.path) && leg.path.length) {
      const a = leg.path[0];
      const b = leg.path[leg.path.length - 1];
      if (!originPt && Number.isFinite(a?.lat) && Number.isFinite(a?.lon)) {
        originPt = { lat: a.lat, lon: a.lon, label: plan.fromLabel || "" };
      }
      if (Number.isFinite(b?.lat) && Number.isFinite(b?.lon)) {
        destPt = { lat: b.lat, lon: b.lon, label: plan.toLabel || destPt?.label || "" };
      }
    }
  }
  if (originPt && plan.fromLabel && !originPt.label) originPt.label = plan.fromLabel;
  if (destPt && plan.toLabel && !destPt.label) destPt.label = plan.toLabel;
  return {
    origin: originPt,
    destination: destPt,
    vias: viaPts.length
      ? viaPts
      : storedVias.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)),
  };
}

function showPreviewEndpointMarkers(ends) {
  clearTripEndpointMarkers();
  if (ends?.origin) {
    originMarker = placeEndpointMarker(
      "origin",
      ends.origin.lat,
      ends.origin.lon,
      ends.origin.label || t("Origin"),
    );
  }
  (ends?.vias || []).forEach((pt, i) => {
    if (!pt) return;
    const m = placeEndpointMarker(
      "via",
      pt.lat,
      pt.lon,
      pt.label ||
        ((ends.vias.length > 1 ? t("Via {n}", { n: i + 1 }) : t("Via"))),
    );
    if (m) previewViaMarkers.push(m);
  });
  if (ends?.destination) {
    destMarker = placeEndpointMarker(
      "destination",
      ends.destination.lat,
      ends.destination.lon,
      ends.destination.label || t("Destination"),
    );
  }
}

/**
 * Nearby browse pin — map tap sets location and refreshes nearby routes (Wheels-like).
 * @type {import("maplibre-gl").Marker | null}
 */
let nearbyBrowseMarker = null;

/**
 * Set the “here” point for Nearby ETA browse and refresh the list.
 * @param {number} lat
 * @param {number} lon
 * @param {{ fly?: boolean, label?: string }} [opts]
 */
function setNearbyBrowseLocation(lat, lon, opts = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  etaUserGeo = { lat, lon, at: Date.now() };

  // Pin marker on map
  try {
    if (!nearbyBrowseMarker) {
      const el = document.createElement("div");
      el.className = "nearby-browse-pin";
      el.title = "Nearby search location";
      nearbyBrowseMarker = new Marker({ element: el, anchor: "center" })
        .setLngLat([lon, lat])
        .addTo(map);
    } else {
      nearbyBrowseMarker.setLngLat([lon, lat]);
    }
  } catch (e) {
    console.warn("[nearby] marker", e);
  }

  if (opts.fly !== false) {
    try {
      map.easeTo({
        center: [lon, lat],
        zoom: Math.max(map.getZoom(), 14.2),
        duration: 650,
        padding: mapVisiblePadding(),
      });
    } catch {
      /* ignore */
    }
  }

  if (getUiMode() === "eta") {
    setDetailOpen(true);
    if (sidebarPage !== "search" && sidebarPage !== "eta-route") {
      setSidebarPage("search");
    }
    // Manual override: replay the card entrance for the new location's list
    etaNearbyReplayAnimate = true;
    void refreshEtaRouteSuggest();
  }
}

// Map click:
//  · Nearby — set browse location + refresh nearby routes (Wheels)
//  · Trip Plan — origin/destination pick only (armed or empty field)
// Path contribute mode owns map clicks while open.
map.on("click", (e) => {
  if (pathContributor?.isOpen()) return;
  const { lng, lat } = e.lngLat;

  // Nearby tab: tap map to re-center “nearby” search
  if (getUiMode() === "eta") {
    if (mapPickArmed) {
      // Ignore plan-pick arming in Nearby
      mapPickArmed = false;
      els.mapPickHint?.classList.remove("is-picking");
    }
    // Manual override: GPS stops driving the camera/pin until locate is re-tapped
    disengageGeolocateFollow();
    setNearbyBrowseLocation(lat, lng);
    reverseGeocode(lat, lng).then((label) => {
      if (label && nearbyBrowseMarker) {
        nearbyBrowseMarker.getElement().title = label;
      }
    });
    return;
  }

  // Trip Plan only below
  if (getUiMode() !== "route") return;

  if (!mapPickArmed) {
    if (!origin) {
      pickMode = "origin";
    } else if (!destination) {
      pickMode = "destination";
    } else {
      return; // origin + dest set — ignore unless armed (via needs explicit pick)
    }
  }
  const kind = pickMode === "via" ? "via" : pickMode === "origin" ? "origin" : "destination";
  const viaId = kind === "via" ? activeViaId : null;
  setPoint(kind, lat, lng, fmtCoord(lat, lng), viaId ? { viaId } : {});
  reverseGeocode(lat, lng).then((label) => {
    const cur =
      kind === "origin"
        ? origin
        : kind === "via"
          ? getViaSlot(viaId || activeViaId)?.point
          : destination;
    if (cur && Math.abs(cur.lat - lat) < 1e-8 && Math.abs(cur.lon - lng) < 1e-8) {
      setPoint(kind, lat, lng, label, {
        isMtr: looksLikeMtrStation(label),
        ...(viaId ? { viaId } : {}),
      });
    }
  });
  if (kind === "origin" && !destination) {
    setPickMode("destination", { armMap: true });
  } else {
    mapPickArmed = false;
    els.mapPickHint?.classList.remove("is-picking");
  }
});

els.btnPickOrigin?.addEventListener("click", () =>
  setPickMode("origin", { armMap: true }),
);
els.btnPickDest?.addEventListener("click", () =>
  setPickMode("destination", { armMap: true }),
);

// ── Search suggest ───────────────────────────────────────────────────────────
/** @type {Record<string, Array|null>} */
const lastResults = { origin: null, destination: null };

function suggestList(which) {
  if (which === "origin") return els.suggestOrigin;
  if (isViaSlot(which)) {
    const slot = getViaSlot(viaIdFromSlot(which));
    return slot?.list || null;
  }
  return els.suggestDest;
}

function hideSuggestExcept(keep) {
  for (const k of allSearchSlots()) {
    if (k !== keep) hideSuggest(k);
  }
}

function hideSuggest(which) {
  const list = suggestList(which);
  if (!list) return;
  list.hidden = true;
  list.innerHTML = "";
  list.classList.remove("is-open");
}

function showSuggestMessage(which, message, kind = "muted") {
  const list = suggestList(which);
  if (!list) return;
  // Always keep "Tap the map" action even for loading / empty / error
  list.innerHTML =
    mapPickSuggestItemHtml(which) +
    `<li class="loc-suggest-msg loc-suggest-msg-${kind}" role="status">${escapeHtml(message)}</li>`;
  list.hidden = false;
  list.classList.add("is-open");
  wireMapPickSuggest(list, which);
}

function mapPickSuggestItemHtml(which) {
  const field = isViaSlot(which)
    ? "via"
    : PLAN_POINT_KINDS.includes(which)
      ? which
      : "destination";
  const fieldLabel =
    field === "origin" ? t("Origin") : field === "via" ? t("Via") : t("Destination");
  return `<li role="option">
    <button type="button" class="loc-suggest-item loc-suggest-map" data-action="map-pick" data-field="${field}">
      <span class="material-symbols-outlined s-icon" aria-hidden="true">touch_app</span>
      <span class="s-text">
        <span class="s-name">${t("Tap the map to set")}</span>
        <span class="s-label">${t("Click anywhere on the map for {field}", { field: fieldLabel })}</span>
      </span>
    </button>
  </li>`;
}

function wireMapPickSuggest(list, which) {
  list.querySelectorAll('button[data-action="map-pick"]').forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      hideSuggest(which);
      setPickMode(
        which === "origin" ? "origin" : isViaSlot(which) ? "via" : "destination",
        { armMap: true, viaId: isViaSlot(which) ? viaIdFromSlot(which) : null },
      );
    });
  });
}

function pickResult(which, r) {
  if (!r) return;
  let lat = r.lat;
  let lon = r.lon;
  let label = r.label || r.name;
  const mode = r.mode || null;
  const source = r.source || "";
  let isLrt = !!(r.isLrt || mode === "lrt" || source === "lrt-local");
  // Explicit heavy-rail pick from MTR directory must stay on TML/EAL/…
  const explicitHeavy =
    source === "mtr-local" || source === "mtr-snap" || mode === "mtr";
  let isMtr = !isLrt && !!(r.isMtr || explicitHeavy);

  // Free-text / Nominatim: if this is really an LRT stop, pin to LRT coords
  // and never run heavy-rail snap (Tin Yat sits next to Tin Shui Wai TML).
  if (!isLrt && !explicitHeavy && mode !== "bus") {
    const byName = matchLrtStop(label, null, null, 0);
    const byNear = matchLrtStop(label, lat, lon, 220);
    const lrtHit = byName || byNear;
    if (lrtHit) {
      // Dual-name hubs (Tin Shui Wai / Yuen Long / Tuen Mun): only take LRT
      // when the result is already near the LRT pin or labelled Light Rail.
      const dualHub = /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
        String(lrtHit.name_en || "").trim(),
      );
      const nearLrt =
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.hypot(lat - lrtHit.lat, lon - lrtHit.lon) * 111320 < 200;
      const labelledLrt = /light\s*rail|輕鐵/i.test(`${r.name || ""} ${r.label || ""}`);
      if (!dualHub || nearLrt || labelledLrt || (byName && !searchMtrStationsLocal(label, 1).length)) {
        const hit = lrtStopToHit(lrtHit);
        lat = hit.lat;
        lon = hit.lon;
        label = hit.label;
        isLrt = true;
        isMtr = false;
      }
    }
  }

  // Snap onto heavy-rail centroids only for non-LRT, non-bus picks
  if (!isLrt && mode !== "bus") {
    // Refuse snap when the label is an LRT-only stop name (e.g. Tin Yat, Tin Wing)
    const lrtOnly = matchLrtStop(label, null, null, 0);
    const heavyMatch = searchMtrStationsLocal(label, 1)[0];
    const isLrtOnlyName = lrtOnly && !heavyMatch;

    if (!isLrtOnlyName) {
      const snapped = snapToMtrStation(lat, lon, label, 400);
      if (
        snapped &&
        (isMtr || wantsStationQuery(label) || r.category === "railway")
      ) {
        // Proximity snap can still drag LRT-only pins — block if nearer to LRT
        const nearLrt = matchLrtStop(null, lat, lon, 180);
        if (nearLrt) {
          const dLrt =
            Math.hypot(lat - nearLrt.lat, lon - nearLrt.lon) * 111320;
          const dMtr =
            Math.hypot(lat - snapped.lat, lon - snapped.lon) * 111320;
          if (dLrt <= dMtr) {
            const hit = lrtStopToHit(nearLrt);
            lat = hit.lat;
            lon = hit.lon;
            label = hit.label;
            isLrt = true;
            isMtr = false;
          } else {
            lat = snapped.lat;
            lon = snapped.lon;
            label = snapped.label;
            isMtr = true;
          }
        } else {
          lat = snapped.lat;
          lon = snapped.lon;
          label = snapped.label;
          isMtr = true;
        }
      } else if (!snapped && isMtr && heavyMatch) {
        lat = heavyMatch.lat;
        lon = heavyMatch.lon;
        label = heavyMatch.label;
        isMtr = true;
      }
    } else if (lrtOnly) {
      const hit = lrtStopToHit(lrtOnly);
      lat = hit.lat;
      lon = hit.lon;
      label = hit.label;
      isLrt = true;
      isMtr = false;
    }
  }

  const viaId = isViaSlot(which) ? viaIdFromSlot(which) : null;
  setPoint(isViaSlot(which) ? "via" : which === "origin" ? "origin" : "destination", lat, lon, label, {
    // Keep LRT distinct from heavy-rail MTR so runPlan does not snap to TML
    isMtr: isMtr && !isLrt,
    isLrt,
    category: isMtr || isLrt ? "railway" : r.category,
    type: isLrt ? "halt" : isMtr ? "station" : r.type,
    ...(viaId ? { viaId } : {}),
  });
  map.flyTo({
    center: [lon, lat],
    zoom: Math.max(map.getZoom(), 15),
    duration: 800,
    padding: mapVisiblePadding(),
  });
  hideSuggest(which);
  if ((which === "origin" || isViaSlot(which)) && !destination) {
    els.inputDest?.focus();
  }
}

function wantsStationQuery(s) {
  return /\bstation\b|\bstn\b|\bmtr\b|站/i.test(String(s || ""));
}

function modeBadgeHtml(r) {
  const mode = String(r.mode || "").toLowerCase();
  if (mode === "lrt" || r.isLrt || r.source === "lrt-local") {
    return `<span class="s-badge s-badge-lrt">${t("LRT")}</span>`;
  }
  if (mode === "bus") {
    return `<span class="s-badge s-badge-bus">${t("Bus")}</span>`;
  }
  // Never badge LRT-looking names as MTR if they match the LRT directory
  if (matchLrtStop(r.name || r.label, r.lat, r.lon, 120)) {
    return `<span class="s-badge s-badge-lrt">${t("LRT")}</span>`;
  }
  const isRail =
    r.isMtr ||
    mode === "mtr" ||
    String(r.category || r.class || "").toLowerCase() === "railway" ||
    String(r.type || "").toLowerCase() === "station";
  if (isRail) return `<span class="s-badge">${t("MTR")}</span>`;
  return "";
}

function modeIcon(r) {
  const mode = String(r.mode || "").toLowerCase();
  if (mode === "lrt" || r.isLrt || r.source === "lrt-local") return "tram";
  if (mode === "bus") return "directions_bus";
  if (matchLrtStop(r.name || r.label, r.lat, r.lon, 120)) return "tram";
  const isRail =
    r.isMtr ||
    mode === "mtr" ||
    String(r.category || "").toLowerCase() === "railway";
  return isRail ? "train" : "location_on";
}

function renderSuggest(which, results, meta = {}) {
  const list = suggestList(which);
  if (!list) return;
  lastResults[which] = results;

  const filterNote = meta.mode
    ? `<li class="loc-suggest-msg loc-suggest-filter" role="status">${t("Showing @{mode} stops", { mode: `<strong>@${String(meta.mode).toUpperCase()}</strong>` })}</li>`
    : "";

  if (!results.length) {
    list.innerHTML =
      mapPickSuggestItemHtml(which) +
      filterNote +
      `<li class="loc-suggest-msg loc-suggest-msg-empty" role="status">${escapeHtml(
        meta.mode
          ? t("No {mode} stops matched — try another name", { mode: String(meta.mode).toUpperCase() })
          : t("No places found — try “Yuen Long Station”, @MTR, or tap the map"),
      )}</li>`;
    list.hidden = false;
    list.classList.add("is-open");
    wireMapPickSuggest(list, which);
    return;
  }

  list.innerHTML =
    mapPickSuggestItemHtml(which) +
    filterNote +
    results
      .map((r, i) => {
        const badge = modeBadgeHtml(r);
        const icon = modeIcon(r);
        return `<li role="option">
        <button type="button" data-idx="${i}" class="loc-suggest-item">
          <span class="material-symbols-outlined s-icon" aria-hidden="true">${icon}</span>
          <span class="s-text">
            <span class="s-name">${escapeHtml(r.name)}${badge}</span>
            <span class="s-label">${escapeHtml(r.label)}</span>
          </span>
        </button>
      </li>`;
      })
      .join("");
  list.hidden = false;
  list.classList.add("is-open");

  wireMapPickSuggest(list, which);
  list.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      const r = results[Number(btn.dataset.idx)];
      pickResult(which, r);
    });
  });
}

function scheduleSearch(which, query) {
  clearTimeout(searchTimers[which]);
  searchAbort[which]?.abort();
  const q = query.trim();
  const { mode, text } = parseSearchModeFilter(q);

  // Empty: still offer map pick; @MTR/@LRT alone list stops
  if (q.length < 1) {
    lastResults[which] = [];
    renderSuggest(which, [], {});
    return;
  }
  if (q.length < 2 && !mode) {
    lastResults[which] = [];
    renderSuggest(which, [], {});
    return;
  }

  showSuggestMessage(which, "Searching…", "loading");

  searchTimers[which] = setTimeout(async () => {
    const ac = new AbortController();
    searchAbort[which] = ac;
    try {
      const results = await searchPlaces(q, {
        limit: 10,
        signal: ac.signal,
        mode,
      });
      if (ac.signal.aborted) return;
      renderSuggest(which, results, { mode, text });
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("[geocode]", err);
      const hint =
        String(err.message || "").includes("Failed to fetch") ||
        String(err.message || "").includes("proxy")
          ? t("Search unavailable — run npm run dev (needs /geocode proxy), or tap the map")
          : err.message || t("Search failed");
      showSuggestMessage(which, hint, "error");
      showToast(hint, 4500);
    }
  }, 280);
}

function wireSearchInput(input, which) {
  if (!input) return;

  input.addEventListener("input", (e) => {
    if (which === "origin") origin = null;
    else if (isViaSlot(which)) {
      const slot = getViaSlot(viaIdFromSlot(which));
      if (slot) slot.point = null;
    } else destination = null;
    updatePlanButton();
    scheduleSearch(which, e.target.value);
  });

  input.addEventListener("focus", () => {
    // Switching fields closes the other field’s suggest popup
    hideSuggestExcept(which);
    setPickMode(
      which === "origin" ? "origin" : isViaSlot(which) ? "via" : "destination",
      { armMap: false, viaId: isViaSlot(which) ? viaIdFromSlot(which) : null },
    );
    const q = input.value.trim();
    if (q.length >= 1) {
      if (lastResults[which]?.length) {
        const { mode } = parseSearchModeFilter(q);
        renderSuggest(which, lastResults[which], { mode });
      } else scheduleSearch(which, q);
    } else {
      // Always show map-pick row on focus
      renderSuggest(which, [], {});
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideSuggest(which);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = lastResults[which]?.[0];
      if (first) pickResult(which, first);
      else scheduleSearch(which, input.value);
    }
  });
}

wireSearchInput(els.inputOrigin, "origin");
wireSearchInput(els.inputDest, "destination");

// Hide suggestions when clicking outside the field — or when switching fields
// (each .loc-field carries its own popup, so clicking the other field closes it)
document.addEventListener("pointerdown", (e) => {
  const loc = e.target.closest?.(".loc-field");
  const field = loc?.getAttribute("data-field");
  const viaId = loc?.getAttribute("data-via-id");
  if (field === "via" && viaId) {
    hideSuggestExcept(viaSlotKey(viaId));
  } else if (field === "origin" || field === "destination") {
    hideSuggestExcept(field);
  } else {
    hideSuggestExcept(null);
  }
});

els.btnAddVia?.addEventListener("click", () => {
  const slot = addViaSlot({ focus: true });
  if (slot) renderSuggest(viaSlotKey(slot.id), lastResults[viaSlotKey(slot.id)] || [], {});
});

// ETA panels: “Updated Ns ago” chips tick every second (route detail / trip / pinned)
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  document.querySelectorAll("[data-eta-updated]").forEach((el) => {
    const t = Number(el.dataset.fetchedAt || 0);
    if (Number.isFinite(t) && t > 0) el.textContent = formatUpdatedAgo(t, now);
  });
}, 1_000);

// ── Current location ─────────────────────────────────────────────────────────
els.btnUseLocation?.addEventListener("click", async () => {
  const btn = els.btnUseLocation;
  btn.classList.add("is-loading");
  btn.disabled = true;
  showToast(t("Getting your location…"));
  try {
    const pos = await getCurrentPosition();
    let label = t("Current location");
    try {
      label = await reverseGeocode(pos.lat, pos.lon);
    } catch {
      /* keep generic label */
    }
    setPoint("origin", pos.lat, pos.lon, label);
    map.flyTo({
      center: [pos.lon, pos.lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: 900,
      padding: mapVisiblePadding(),
    });
    showToast(t("Origin set to current location"));
    if (!destination) els.inputDest?.focus();
  } catch (err) {
    console.warn("[geo]", err);
    showToast(err.message || t("Could not get location"), 4000);
  } finally {
    btn.classList.remove("is-loading");
    btn.disabled = false;
  }
});

// ── Swap origin / destination ────────────────────────────────────────────────
els.btnSwap?.addEventListener("click", () => {
  const o = origin;
  const d = destination;
  const oVal = els.inputOrigin?.value || "";
  const dVal = els.inputDest?.value || "";

  // Spin the swap icon once (CSS keyframe; restarts via class toggle)
  if (els.btnSwap) {
    els.btnSwap.classList.remove("is-swapped");
    void els.btnSwap.offsetWidth;
    els.btnSwap.classList.add("is-swapped");
  }

  originMarker?.remove();
  destMarker?.remove();
  originMarker = null;
  destMarker = null;
  origin = null;
  destination = null;

  if (d) {
    setPoint("origin", d.lat, d.lon, d.label || dVal, { isMtr: d.isMtr });
  } else if (els.inputOrigin) {
    els.inputOrigin.value = dVal;
  }

  if (o) {
    setPoint("destination", o.lat, o.lon, o.label || oVal, { isMtr: o.isMtr });
  } else if (els.inputDest) {
    els.inputDest.value = oVal;
  }

  if (vias.length > 1) {
    vias.reverse();
    vias.forEach((slot) => els.viaStack?.appendChild(slot.field));
    syncViaUi();
  }

  updatePlanButton();
});

els.btnPlanCta?.addEventListener("click", () => {
  if (!origin || !destination || !isRouterReady()) return;
  runPlan();
});

/**
 * Stop marker radius scales with zoom: small at low zoom so nearby stops don't
 * merge into one blob, full size at high zoom. Board stop stays larger.
 * MapLibre only allows ONE zoom-based interpolate per expression, so the
 * board/via case must live inside each zoom stop value, not outside.
 * @returns {unknown[]}
 */
function stopRadiusExpr() {
  const at = (via, board) => [
    "case",
    ["==", ["get", "role"], "board"],
    board,
    via,
  ];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    10, at(2.6, 3.2),
    12, at(3.4, 4.2),
    14, at(4.6, 5.6),
    16, at(6, 7),
    18, at(8, 9),
  ];
}

function ensureRouteLayers() {
  if (!map.getSource("route-line")) {
    map.addSource("route-line", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getSource("route-stops")) {
    map.addSource("route-stops", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer("route-line-casing")) {
    map.addLayer({
      id: "route-line-casing",
      type: "line",
      source: "route-line",
      paint: {
        "line-color": "#000000",
        "line-width": 8,
        "line-opacity": 0.45,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });
  }
  if (!map.getLayer("route-line-main")) {
    map.addLayer({
      id: "route-line-main",
      type: "line",
      source: "route-line",
      paint: {
        "line-color": [
          "case",
          ["==", ["get", "walk_style"], "indoor"],
          "#c4b5fd",
          ["==", ["get", "walk_style"], "free"],
          "#c4b5fd",
          ["==", ["get", "kind"], "walk"],
          "#ff9500",
          // Passed features carry passed_color — opaque white-mixed route colour
          ["coalesce", ["get", "passed_color"], ["coalesce", ["get", "color"], "#c0aefc"]],
        ],
        "line-width": [
          "case",
          ["==", ["get", "walk_style"], "indoor"],
          3.5,
          ["==", ["get", "walk_style"], "free"],
          3.5,
          4,
        ],
        "line-opacity": [
          "case",
          ["==", ["get", "passed"], true],
          1,
          0.95,
        ],
        "line-dasharray": [
          "case",
          ["==", ["get", "walk_style"], "indoor"],
          ["literal", [1.4, 1.6]],
          ["==", ["get", "walk_style"], "free"],
          ["literal", [1.4, 1.6]],
          ["literal", [1, 0]],
        ],
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });
  }

  if (!map.getLayer("route-stops-circle")) {
    map.addLayer({
      id: "route-stops-circle",
      type: "circle",
      source: "route-stops",
      paint: {
        // Radius scales with zoom so nearby stops don't merge at low zoom
        "circle-radius": stopRadiusExpr(),
        // Passed features carry passed_color — opaque white-mixed route colour
        "circle-color": [
          "coalesce",
          ["get", "passed_color"],
          ["coalesce", ["get", "color"], "#c0aefc"],
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": [
          "case",
          ["==", ["get", "role"], "board"],
          2.5,
          2,
        ],
        "circle-opacity": 1,
        "circle-stroke-opacity": 1,
      },
    });
  }
  if (!map.getLayer("route-stops-label")) {
    map.addLayer({
      id: "route-stops-label",
      type: "symbol",
      source: "route-stops",
      filter: [
        "any",
        ["!=", ["get", "role"], "via"],
        [">=", ["zoom"], 14],
      ],
      layout: {
        "text-field": ["get", "stop_name"],
        "text-size": 11,
        "text-offset": [0, 1.25],
        "text-anchor": "top",
        "text-font": ["Noto Sans Regular"],
        "text-max-width": 9,
        "text-optional": true,
        "text-allow-overlap": false,
        "icon-allow-overlap": true,
      },
      paint: {
        "text-color": "#f5f5fa",
        "text-halo-color": "#000000",
        "text-halo-width": 1.4,
      },
    });
  }

  // Re-apply paint in case an older HMR/session left a broken expression
  try {
    if (map.getLayer("route-line-main")) {
      map.setPaintProperty("route-line-main", "line-color", [
        "case",
        ["==", ["get", "walk_style"], "indoor"],
        "#c4b5fd",
        ["==", ["get", "walk_style"], "free"],
        "#c4b5fd",
        ["==", ["get", "kind"], "walk"],
        "#ff9500",
        ["coalesce", ["get", "passed_color"], ["coalesce", ["get", "color"], "#c0aefc"]],
      ]);
      map.setPaintProperty("route-line-main", "line-opacity", [
        "case",
        ["==", ["get", "passed"], true],
        1,
        0.95,
      ]);
    }
    if (map.getLayer("route-stops-circle")) {
      map.setPaintProperty("route-stops-circle", "circle-radius", stopRadiusExpr());
      map.setPaintProperty("route-stops-circle", "circle-color", [
        "coalesce", ["get", "passed_color"], ["coalesce", ["get", "color"], "#c0aefc"],
      ]);
      map.setPaintProperty("route-stops-circle", "circle-stroke-color", "#ffffff");
      map.setPaintProperty("route-stops-circle", "circle-stroke-width", [
        "case",
        ["==", ["get", "role"], "board"],
        2.5,
        2,
      ]);
      map.setPaintProperty("route-stops-circle", "circle-opacity", 1);
      map.setLayoutProperty("route-stops-circle", "visibility", "visible");
    }
    if (map.getLayer("route-stops-label")) {
      map.setLayoutProperty("route-stops-label", "visibility", "visible");
    }
  } catch (e) {
    console.warn("[stops] paint refresh", e);
  }

  promoteRouteStopLayers();
}

/** Keep stop dots above basemap, route lines, and MTR exit/platform layers. */
function promoteRouteStopLayers() {
  try {
    if (map.getLayer("route-stops-circle")) map.moveLayer("route-stops-circle");
    if (map.getLayer("route-stops-label")) map.moveLayer("route-stops-label");
  } catch {
    /* style not ready */
  }
  // Live-bus markers must stay above stop dots after a stop-switch redraw.
  promoteBusPosLayers();
}

/**
 * Pull lon/lat from WASM / GTFS stop shapes.
 * @returns {[number, number] | null}
 */
function extractStopLonLat(stop) {
  if (!stop) return null;
  const loc = stop.location;
  let lon =
    loc?.lon ??
    loc?.lng ??
    loc?.longitude ??
    stop.lon ??
    stop.lng ??
    stop.longitude;
  let lat =
    loc?.lat ?? loc?.latitude ?? stop.lat ?? stop.latitude;
  // Rare: location as [lon, lat]
  if (
    (!Number.isFinite(lon) || !Number.isFinite(lat)) &&
    Array.isArray(loc) &&
    loc.length >= 2
  ) {
    lon = loc[0];
    lat = loc[1];
  }
  lon = Number(lon);
  lat = Number(lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/**
 * Board stop label for an MTR station in the current language: English-only
 * for en / ja / ko; combined “中文 English” for zh modes (Simplified via the
 * zhMap for zh-cn) — matches stopDisplayName's MTR/LRT combined style.
 * @param {{ name_en?: string, name_zh?: string, name_tc?: string } | null | undefined} st
 */
function mtrBoardStopLabel(st) {
  const mode = LANG_META[getLang()].stationMode;
  const en = String(st?.name_en || "").trim();
  const zh = String(st?.name_zh || st?.name_tc || "").trim();
  if (mode === "en") return en || zh;
  const zhOut = zh ? (mode === "hans" ? simplifyZh(zh) : zh) : "";
  if (!zhOut) return en;
  return `${zhOut} ${en}`.trim();
}

/**
 * Wheels-style map route number (bottom-left over basemap).
 * @param {string} coLabel
 * @param {string} routeId
 * @param {string} [color]
 */
function setMapRouteBadge(coLabel, routeId, color = "#fff", label = "", kind = "", route = null) {
  const badge = document.getElementById("map-route-badge");
  const coEl = document.getElementById("map-route-badge-co");
  const idEl = document.getElementById("map-route-badge-id");
  if (!badge || !idEl) return;
  const joint = route && isJointBusRoute(route);
  if (coEl) {
    coEl.classList.toggle("map-route-badge-co-mtr", kind === "mtr");
    coEl.classList.toggle("is-joint-cos", !!joint);
    if (joint) {
      coEl.hidden = false;
      coEl.style.color = "";
      coEl.innerHTML = `<span class="joint-co-kmb">KMB</span><span class="joint-co-ctb">Citybus</span>`;
    } else {
      coEl.textContent = coLabel || "";
      coEl.style.color = color || "";
      coEl.hidden = !coLabel;
    }
  }
  if (kind === "mtr") {
    // Coloured pill: localized line name over the English full name
    idEl.innerHTML = mtrLineBadgeHtml(routeId, color, label, "map-route-badge-mtr");
    idEl.style.color = "";
    idEl.classList.remove("is-joint");
  } else if (joint) {
    idEl.textContent = routeId || "";
    idEl.style.color = "";
    idEl.classList.add("is-joint");
  } else {
    idEl.textContent = routeId || "";
    idEl.style.color = color || "#fff";
    idEl.classList.remove("is-joint");
  }
  badge.hidden = !routeId;
  badge.setAttribute("aria-hidden", routeId ? "false" : "true");
  if (routeId) {
    badge.setAttribute(
      "aria-label",
      `${coLabel || "Route"} ${routeId}`.trim(),
    );
  }
}

function clearMapRouteBadge() {
  const badge = document.getElementById("map-route-badge");
  if (!badge) return;
  badge.hidden = true;
  badge.setAttribute("aria-hidden", "true");
  const coEl = document.getElementById("map-route-badge-co");
  const idEl = document.getElementById("map-route-badge-id");
  if (coEl) coEl.textContent = "";
  if (idEl) idEl.textContent = "";
}

function clearRouteGeometry() {
  etaMapGeomCache = null;
  const src = map.getSource("route-line");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
  const stops = map.getSource("route-stops");
  if (stops) stops.setData({ type: "FeatureCollection", features: [] });
  setRouteStationCodes(map, []);
  if (mtrPopup) {
    mtrPopup.remove();
    mtrPopup = null;
  }
  // Keep map route badge only while route-detail page is open
  if (sidebarPage !== "eta-route") clearMapRouteBadge();
}

/**
 * Blur the map and show a loading card while densified path is calculated.
 * Route geometry is only painted after densify finishes (no skeleton flash).
 * @param {boolean} on
 * @param {string} [message]
 */
function setMapRouteLoading(on, message = t("Drawing route…")) {
  const stage = document.getElementById("map-stage");
  const overlay = document.getElementById("map-route-loading");
  const label = overlay?.querySelector(".map-route-loading-label");
  if (label && message) label.textContent = message;

  if (on) {
    stage?.classList.add("is-drawing-route");
    document.body.classList.add("is-drawing-route");
    if (overlay) {
      overlay.hidden = false;
      overlay.setAttribute("aria-busy", "true");
    }
  } else {
    stage?.classList.remove("is-drawing-route");
    document.body.classList.remove("is-drawing-route");
    if (overlay) {
      // Let exit transition play, then hide for a11y
      window.setTimeout(() => {
        if (!document.body.classList.contains("is-drawing-route")) {
          overlay.hidden = true;
        }
      }, 420);
      overlay.setAttribute("aria-busy", "false");
    }
  }
}

/**
 * GeoJSON points for stops the selected plan actually uses.
 * Roles: board | via | alight | transfer
 * MTR: prefer platform pins; fall back to GTFS stop coords (never drop markers).
 * Bus: GTFS coords, later snapped onto densified route line.
 */
function stopsGeoFromPlan(plan) {
  const features = [];
  const seen = new Set();
  const platformKeys = new Set();
  const stationCodes = new Set();
  const legs = plan.legs || [];

  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const leg = legs[legIdx];
    if (leg.type !== "transit" || !leg.route_options?.[0]) continue;
    const opt = leg.route_options[0];
    const color = routeColorCss(opt) || "#c0aefc";
    const route =
      opt.route_short_name || opt.route_name || opt.route_id || "";
    const mode = String(opt.mode || "");
    const rail = isRailOption(opt);
    // Prefer full stop list; always include from/to as endpoints
    let raw =
      opt.stops?.length >= 2
        ? opt.stops
        : [opt.from, opt.to].filter(Boolean);
    if (!raw.length && opt.from) raw = [opt.from];
    if (raw.length === 1 && opt.to && opt.to !== opt.from) raw = [...raw, opt.to];
    if (!rail) raw = mergeStopSequence(raw, { nearbyM: 90 });

    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      let role = "via";
      if (i === 0) role = "board";
      else if (i === raw.length - 1) role = "alight";

      const ll = extractStopLonLat(s);
      let lon = ll?.[0];
      let lat = ll?.[1];
      let stopName = formatStopName(s) || s?.stop_name || s?.address || "Stop";
      let code = "";
      let platformKey = "";
      let platformRef = String(s?.platform || s?.platform_code || "").trim();
      const publicStopCode = !rail ? extractPublicStopCode(s) : "";

      if (rail) {
        const plat = resolvePlatformForStop(s, opt);
        if (plat) {
          lon = plat.lon;
          lat = plat.lat;
          code = plat.station_code;
          platformKey = plat.platform_key;
          platformRef = plat.ref || platformRef;
          stopName = platformRef
            ? `${plat.station_name} · P${platformRef}`
            : plat.station_name || stopName;
          if (platformKey) platformKeys.add(platformKey);
          if (code) stationCodes.add(code);
        } else {
          // Platform GeoJSON missing / unmatched — still show GTFS pin
          code = stationCodeFromName(stopName) || stationCodeFromName(s?.stop_name) || "";
          if (code) stationCodes.add(code);
        }
      } else {
        code = publicStopCode || stationCodeFromName(stopName) || "";
        if (publicStopCode) {
          stopName = stopLabelWithPublicId(s, stopName.replace(/\s*\([A-Z]{1,4}\d{2,5}[A-Z]?\)\s*$/i, "").trim());
        }
      }

      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      // Dedupe map pins: public KMB code, else stop_id, else coords
      const key =
        platformKey ||
        (publicStopCode ? `PUB:${publicStopCode}` : "") ||
        s?.stop_id ||
        s?.id ||
        `L${legIdx}:${Number(lon).toFixed(5)},${Number(lat).toFixed(5)}`;
      if (seen.has(key)) {
        const prev = features.find((f) => f.properties._key === key);
        if (
          prev &&
          (role === "board" || role === "alight") &&
          (prev.properties.role === "board" ||
            prev.properties.role === "alight" ||
            prev.properties.role === "via")
        ) {
          if (prev.properties.role !== role) prev.properties.role = "transfer";
        }
        continue;
      }
      seen.add(key);

      // MapLibre paint props must be primitives (no null color)
      const colorSafe =
        typeof color === "string" && color.startsWith("#") ? color : "#c0aefc";

      features.push({
        type: "Feature",
        properties: {
          _key: key,
          stop_name: String(stopName || "Stop"),
          stop_id: String(s?.stop_id || s?.id || ""),
          role: String(role),
          color: colorSafe,
          route: String(route || ""),
          mode: String(mode || ""),
          station_code: String(code || ""),
          platform_key: String(platformKey || ""),
          platform_ref: String(platformRef || ""),
          leg_index: legIdx,
          stop_index: i,
          rail: rail ? 1 : 0,
        },
        geometry: {
          type: "Point",
          coordinates: [Number(lon), Number(lat)],
        },
      });
    }
  }

  for (const f of features) delete f.properties._key;
  return {
    type: "FeatureCollection",
    features,
    _mtr: {
      stationCodes: [...stationCodes],
      platformKeys: [...platformKeys],
    },
  };
}

/**
 * Max distance (m) to snap a bus stop onto the densified route line.
 * Keep tight: OSRM sometimes draws airport legs on HZMB Hong Kong Link Road
 * parallel to Chek Lap Kok South Road; a large threshold pulls the pin onto
 * the wrong road. Prefer official kerbside coords when the line is far.
 */
const STOP_SNAP_MAX_M = 95;
/** Platforms sit off track centreline — allow a bit more than kerbside bus. */
const PLATFORM_SNAP_MAX_M = 120;

/**
 * Project stop markers onto their transit LineString so dots sit on the
 * densified path (bus: OSRM road; rail/LRT: track centreline) — not the
 * raw GTFS kerbside / platform offset beside the track.
 * @param {GeoJSON.FeatureCollection} stopFc
 * @param {GeoJSON.FeatureCollection | null | undefined} routeGeo
 */
function snapStopsToRouteLines(stopFc, routeGeo) {
  if (!stopFc?.features?.length || !routeGeo?.features?.length) return stopFc;

  /** @type {Map<number, Array<{ lon: number, lat: number }>>} */
  const linesByLeg = new Map();
  /** @type {Array<{ lon: number, lat: number }>} ordered fallback when leg_index missing */
  const transitLinesOrdered = [];

  for (const f of routeGeo.features) {
    const kind = f.properties?.kind;
    if (kind != null && String(kind) !== "transit") continue;
    const isLine =
      f.geometry?.type === "LineString" &&
      Array.isArray(f.geometry.coordinates) &&
      f.geometry.coordinates.length >= 2;
    if (!isLine) continue;
    if (kind == null && f.properties?.walk_style) continue; // walk feature

    const coords = f.geometry.coordinates.map((c) => ({
      lon: Number(c[0]),
      lat: Number(c[1]),
    }));
    const li = Number(f.properties?.leg_index);
    if (Number.isFinite(li)) {
      linesByLeg.set(li, coords);
    }
    if (String(kind) === "transit" || Number.isFinite(li)) {
      transitLinesOrdered.push(coords);
    }
  }

  /** @type {Map<number, object[]>} */
  const stopsByLeg = new Map();
  for (const f of stopFc.features) {
    const li = Number(f.properties?.leg_index);
    if (!Number.isFinite(li)) continue;
    if (!stopsByLeg.has(li)) stopsByLeg.set(li, []);
    stopsByLeg.get(li).push(f);
  }

  // If leg_index on lines failed, map legs in plan order onto transit lines
  const stopLegIds = [...stopsByLeg.keys()].sort((a, b) => a - b);
  if (!linesByLeg.size && transitLinesOrdered.length && stopLegIds.length) {
    stopLegIds.forEach((legId, i) => {
      const line = transitLinesOrdered[Math.min(i, transitLinesOrdered.length - 1)];
      if (line) linesByLeg.set(legId, line);
    });
  }

  if (!linesByLeg.size) {
    console.warn("[stops] no transit lines to snap stops onto");
    return stopFc;
  }

  let snappedBus = 0;
  let snappedRail = 0;
  for (const [li, feats] of stopsByLeg) {
    const route = linesByLeg.get(li);
    if (!route || route.length < 2) continue;
    feats.sort(
      (a, b) =>
        (Number(a.properties.stop_index) || 0) -
        (Number(b.properties.stop_index) || 0),
    );

    const projected = projectStops(
      route,
      feats.map((f, i) => ({
        id: String(i),
        lon: Number(f.geometry.coordinates[0]),
        lat: Number(f.geometry.coordinates[1]),
      })),
    );

    for (let i = 0; i < feats.length; i++) {
      const p = projected[i];
      if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
      const isRail =
        feats[i].properties?.rail === true || feats[i].properties?.rail === 1;
      const maxErr = isRail ? PLATFORM_SNAP_MAX_M : STOP_SNAP_MAX_M;

      if (typeof p.error === "number" && p.error > maxErr) {
        // Keep official GTFS / open-data coords — do not drag onto a wrong
        // parallel road (e.g. CLK South Road → Hong Kong Link Road).
        // Only soft-pin board/alight when the projection is still reasonably near.
        const role = feats[i].properties?.role;
        const softMax = maxErr * 1.8;
        if (
          (role === "board" || role === "alight") &&
          typeof p.error === "number" &&
          p.error <= softMax
        ) {
          if (role === "board") {
            feats[i].geometry = {
              type: "Point",
              coordinates: [route[0].lon, route[0].lat],
            };
          } else {
            const last = route[route.length - 1];
            feats[i].geometry = {
              type: "Point",
              coordinates: [last.lon, last.lat],
            };
          }
          feats[i].properties.snapped = true;
          if (isRail) snappedRail += 1;
          else snappedBus += 1;
        }
        // else: leave official geometry (already set from stopsGeoFromPlan)
        continue;
      }
      feats[i].geometry = {
        type: "Point",
        coordinates: [p.lon, p.lat],
      };
      feats[i].properties.snapped = true;
      if (isRail) snappedRail += 1;
      else snappedBus += 1;
    }
  }

  if (snappedBus || snappedRail) {
    console.info(
      "[stops] snapped onto route lines — bus:",
      snappedBus,
      "platform/rail:",
      snappedRail,
    );
  }
  return stopFc;
}

/** @deprecated name — use snapStopsToRouteLines */
function snapBusStopsToRouteLines(stopFc, routeGeo) {
  return snapStopsToRouteLines(stopFc, routeGeo);
}

/**
 * For bus legs with a published shape that includes visual_stops, move map pins
 * to contributed visual positions. Does not change stop_id / merge / ETA identity.
 * @param {object} plan
 * @param {GeoJSON.FeatureCollection} stopFc
 */
function applyContributedVisualStops(plan, stopFc) {
  if (!plan || !stopFc?.features?.length) return;
  const legs = plan.legs || [];
  let total = 0;
  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const leg = legs[legIdx];
    if (leg.type !== "transit" || !leg.route_options?.[0]) continue;
    const opt = leg.route_options[0];
    if (isRailOption(opt)) continue;
    const shape = matchBusShapeOverride(opt);
    if (!shape?.visual_stops?.length) continue;
    const feats = stopFc.features.filter(
      (f) => Number(f.properties?.leg_index) === legIdx,
    );
    total += applyVisualStopsFromShape(feats, shape);
  }
  if (total) {
    console.info("[stops] applied contributed visual_stops:", total);
  }
}

function isRailOption(opt) {
  const mode = String(opt?.mode || "").toLowerCase();
  const name = String(
    opt?.route_short_name || opt?.route_name || opt?.route_long_name || "",
  ).toLowerCase();
  const agency = String(opt?.agency?.id || opt?.agency?.name || "").toLowerCase();
  if (agency === "lr" || /light\s*rail|輕鐵/.test(agency)) return true;
  return (
    mode.includes("subway") ||
    mode.includes("rail") ||
    mode.includes("metro") ||
    mode.includes("tram") ||
    mode.includes("funicular") ||
    mode.includes("monorail") ||
    /mtr|eal|twl|isl|ktl|tml|tcl|tkl|ael|sil|drl|light\s*rail|輕鐵|\blrt\b/.test(
      name,
    )
  );
}

/**
 * Stops for rail geometry: platform coords when known (better basemap snap).
 * @param {object} opt
 */
function railStopsForGeometry(opt) {
  const raw = opt.stops?.length
    ? opt.stops
    : [opt.from, opt.to].filter(Boolean);
  return raw.map((s, i) => {
    const plat = resolvePlatformForStop(s, opt);
    if (plat) {
      return {
        stop_id: s?.stop_id || s?.id || String(i),
        location: { lon: plat.lon, lat: plat.lat },
        lon: plat.lon,
        lat: plat.lat,
        stop_name: s?.stop_name,
        platform: plat.ref,
      };
    }
    return s;
  });
}

/**
 * @param {object | null} plan
 * @param {GeoJSON.FeatureCollection | null} [routeGeo] densified lines to snap bus stops onto
 */
function setRouteStops(plan, routeGeo = null) {
  ensureRouteLayers();
  if (!plan) {
    map.getSource("route-stops")?.setData({
      type: "FeatureCollection",
      features: [],
    });
    setRouteStationCodes(map, { stationCodes: [], platformKeys: [] });
    promoteRouteStopLayers();
    return;
  }
  const geo = stopsGeoFromPlan(plan);
  if (routeGeo) {
    try {
      snapBusStopsToRouteLines(geo, routeGeo);
    } catch (e) {
      // Never block markers if snap fails (e.g. bad line geometry)
      console.warn("[stops] snap to route line failed", e);
    }
  }
  // Published path contributions may include visual_stops — override display only
  // (official GTFS / merge identity stays from stopsGeoFromPlan).
  try {
    applyContributedVisualStops(plan, geo);
  } catch (e) {
    console.warn("[stops] visual_stops override failed", e);
  }

  const features = (geo.features || [])
    .map((f) => {
      const c = f.geometry?.coordinates;
      if (!Array.isArray(c) || c.length < 2) return null;
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      // Flatten props — MapLibre can drop features with bad property types
      const p = f.properties || {};
      const props = {};
      for (const [k, v] of Object.entries(p)) {
        if (v == null) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          props[k] = v;
        } else {
          props[k] = String(v);
        }
      }
      if (!props.color || typeof props.color !== "string") props.color = "#c0aefc";
      if (!props.role) props.role = "via";
      if (!props.stop_name) props.stop_name = "Stop";
      return {
        type: "Feature",
        properties: props,
        geometry: { type: "Point", coordinates: [lon, lat] },
      };
    })
    .filter(Boolean);

  const fc = { type: "FeatureCollection", features };
  const src = map.getSource("route-stops");
  if (src) {
    src.setData(fc);
  } else {
    console.warn("[stops] route-stops source missing");
  }
  console.info("[stops] markers", features.length, "for plan");

  // Exits for stations on the plan. Platform pins live in route-stops.
  setRouteStationCodes(map, {
    stationCodes: geo._mtr?.stationCodes || [],
    platformKeys: [],
  });
  promoteRouteStopLayers();
}

/**
 * Build GeoJSON for a plan. Bus/trolley legs densify along roads via OSRM
 * (route-snapper); rail uses track snap / stop chords.
 * Walk: access & egress are straight lines; transfers & walk-only use path.
 * Indoor / free MTR interchanges → straight platform chord.
 * @param {object} plan
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function geometryFromPlan(plan, opts = {}) {
  const features = [];
  const legs = plan.legs || [];
  for (let i = 0; i < legs.length; i++) {
    if (opts.signal?.aborted) break;
    const leg = legs[i];
    if (leg.type === "walk") {
      const walkFeat = await walkFeatureForLeg(legs, i, opts);
      if (walkFeat) features.push(walkFeat);
    } else if (leg.type === "transit" && leg.route_options?.[0]) {
      const opt = leg.route_options[0];
      // Prefer platform pins for rail (matches stop markers + basemap snap)
      const railStops = isRailOption(opt) ? railStopsForGeometry(opt) : null;
      const optForGeom = railStops ? { ...opt, stops: railStops } : opt;
      let poly = await buildTransitPolyline(optForGeom, {
        signal: opts.signal,
        forceRail: isRailOption(opt),
      });
      // Clip overshoot + pin to board/alight platforms (TML ends at ETS P2)
      if (railStops?.length >= 2 && poly?.length >= 2) {
        const { clipPolylineToEndpoints } = await import("./railSnapper.js");
        const a = railStops[0];
        const b = railStops[railStops.length - 1];
        poly = clipPolylineToEndpoints(
          poly,
          {
            lon: a.location?.lon ?? a.lon,
            lat: a.location?.lat ?? a.lat,
          },
          {
            lon: b.location?.lon ?? b.lon,
            lat: b.location?.lat ?? b.lat,
          },
        );
      }
      if (poly.length >= 2) {
        features.push({
          type: "Feature",
          properties: {
            kind: "transit",
            leg_index: i,
            color: routeColorCss(opt) || "#c0aefc",
            name: opt.route_short_name || opt.route_name,
            mode: opt.mode || "",
          },
          geometry: {
            type: "LineString",
            coordinates: poly.map((p) => [p.lon, p.lat]),
          },
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
}

/** Previous / next transit leg around a walk (skips waits). */
function adjacentTransitLeg(legs, walkIdx, dir) {
  for (let i = walkIdx + dir; i >= 0 && i < legs.length; i += dir) {
    if (legs[i].type === "transit") return { leg: legs[i], index: i };
    if (legs[i].type === "meet") {
      // Via / meet-up is a journey break — do not treat walks on either
      // side as one transfer between the two hops.
      break;
    }
    if (legs[i].type === "walk" && dir !== 0) {
      // another walk — stop scanning past it for "adjacent" transfer context
      break;
    }
  }
  return null;
}

function transitAlightStop(opt) {
  if (!opt) return null;
  if (opt.to) return opt.to;
  if (opt.stops?.length) return opt.stops[opt.stops.length - 1];
  return null;
}

function transitBoardStop(opt) {
  if (!opt) return null;
  if (opt.from) return opt.from;
  if (opt.stops?.length) return opt.stops[0];
  return null;
}

/**
 * Map coordinate for end of a transit leg (platform when MTR).
 * @param {object} opt
 * @param {"board"|"alight"} which
 * @returns {[number, number] | null}
 */
function transitEndpointCoord(opt, which) {
  if (!opt) return null;
  const stop = which === "alight" ? transitAlightStop(opt) : transitBoardStop(opt);
  if (!stop) return null;
  if (isRailOption(opt)) {
    const plat = resolvePlatformForStop(stop, opt);
    if (plat) return [plat.lon, plat.lat];
  }
  const lon = stop.location?.lon ?? stop.lon;
  const lat = stop.location?.lat ?? stop.lat;
  if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  return null;
}

function stopCoord(stop) {
  if (!stop) return null;
  const lon = stop.location?.lon ?? stop.lon;
  const lat = stop.location?.lat ?? stop.lat;
  if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  return null;
}

/**
 * Classify walk role for map geometry.
 * @param {object} leg
 * @param {number} walkIdx
 * @param {object[]} legs
 * @returns {"access"|"egress"|"transfer"|"walk_only"|"other"}
 */
function walkGeometryRole(leg, walkIdx, legs) {
  if (!leg || leg.type !== "walk") return "other";
  const wtype = String(leg.walk_type || "").toLowerCase();
  if (wtype === "access" || wtype === "station_access") return "access";
  if (wtype === "egress" || wtype === "station_egress") return "egress";

  const hasTransit = (legs || []).some((l) => l.type === "transit");
  if (!hasTransit) return "walk_only";

  const prev = adjacentTransitLeg(legs, walkIdx, -1);
  const next = adjacentTransitLeg(legs, walkIdx, 1);
  if (prev && next) return "transfer";
  if (!prev && next) return "access";
  if (prev && !next) return "egress";
  return "other";
}

/**
 * Whether this walk should draw the detailed router path (not a straight chord).
 * Access / egress → straight line; transfers + full walk plans → actual path.
 * @param {object} leg
 * @param {number} walkIdx
 * @param {object[]} legs
 */
function walkUsesDetailedPath(leg, walkIdx, legs) {
  const role = walkGeometryRole(leg, walkIdx, legs);
  return role === "transfer" || role === "walk_only";
}

/**
 * Straight-line LineString feature for a walk chord.
 * @param {[number, number]} endA
 * @param {[number, number]} endB
 * @param {object} props
 */
function walkChordFeature(endA, endB, props) {
  let coords = [endA, endB];
  if (endA[0] === endB[0] && endA[1] === endB[1]) {
    coords = [endA, [endA[0] + 0.00002, endA[1] + 0.00002]];
  }
  return {
    type: "Feature",
    properties: props,
    geometry: { type: "LineString", coordinates: coords },
  };
}

/**
 * Walk leg geometry:
 *  - Access (walk to station) / egress (walk to destination) → straight line
 *  - Indoor / free MTR interchange → straight platform chord
 *  - Street transfer between vehicles → detailed router path when available
 *  - Full walk-only plan → detailed router path when available
 * @param {object[]} legs
 * @param {number} walkIdx
 * @param {{ signal?: AbortSignal, skipOsrm?: boolean }} [opts]
 */
async function walkFeatureForLeg(legs, walkIdx, opts = {}) {
  const leg = legs[walkIdx];
  if (!leg || leg.type !== "walk") return null;

  const prev = adjacentTransitLeg(legs, walkIdx, -1);
  const next = adjacentTransitLeg(legs, walkIdx, 1);
  const prevOpt = prev?.leg?.route_options?.[0] || null;
  const nextOpt = next?.leg?.route_options?.[0] || null;
  const alightStop = transitAlightStop(prevOpt) || leg.from;
  const boardStop = transitBoardStop(nextOpt) || leg.to;

  const codeA =
    stationCodeFromName(formatStopName(alightStop) || alightStop?.stop_name) ||
    null;
  const codeB =
    stationCodeFromName(formatStopName(boardStop) || boardStop?.stop_name) ||
    null;

  // Dual-access stitched CEN↔HOK (or free link) before first transit
  const indoor =
    !!leg.indoor_interchange ||
    isIndoorMtrInterchangeWalk(
      leg,
      prevOpt,
      nextOpt,
      alightStop,
      boardStop,
      { codeA, codeB },
    ) ||
    (leg.free_mtr_link &&
      isFreeMtrInterchangeWalk(alightStop, boardStop, leg.distance_meters || 0) &&
      /\bcentral\b|中環/i.test(
        `${formatStopName(alightStop)} ${formatStopName(boardStop)}`,
      ) &&
      /\bhong\s*kong\b|香港/i.test(
        `${formatStopName(alightStop)} ${formatStopName(boardStop)}`,
      ));

  // Prefer MTR platform pins so free ETS↔TST starts exactly at East TST P2
  const endA =
    transitEndpointCoord(prevOpt, "alight") ||
    stopCoord(alightStop) ||
    stopCoord(leg.from) ||
    (leg.path?.[0] ? [leg.path[0].lon, leg.path[0].lat] : null);
  const endB =
    transitEndpointCoord(nextOpt, "board") ||
    stopCoord(boardStop) ||
    stopCoord(leg.to) ||
    (leg.path?.length
      ? [
          leg.path[leg.path.length - 1].lon,
          leg.path[leg.path.length - 1].lat,
        ]
      : null);

  const freeOutdoor =
    !indoor &&
    (isCrossStationInterchange(alightStop, boardStop, codeA, codeB) ||
      isFreeMtrInterchangeWalk(
        alightStop,
        boardStop,
        leg.distance_meters || 0,
      ) ||
      !!leg.free_mtr_link);

  // Indoor in-station OR free MTR link: always straight chord
  if ((indoor || freeOutdoor) && endA && endB) {
    return walkChordFeature(endA, endB, {
      kind: "walk",
      walk_style: freeOutdoor && !indoor ? "free" : "indoor",
      walk_type:
        leg.walk_type ||
        (freeOutdoor ? "free_mtr_link" : "station_transfer"),
    });
  }

  const role = walkGeometryRole(leg, walkIdx, legs);
  const useDetail = walkUsesDetailedPath(leg, walkIdx, legs);

  // Access / egress (walk to station or destination): always straight line
  if (!useDetail && endA && endB) {
    return walkChordFeature(endA, endB, {
      kind: "walk",
      walk_style: "street",
      walk_type:
        leg.walk_type ||
        (role === "access"
          ? "access"
          : role === "egress"
            ? "egress"
            : ""),
    });
  }

  // Transfer / full walk plan: detailed router path when present
  let coords = null;
  if (useDetail && Array.isArray(leg.path) && leg.path.length >= 2) {
    coords = leg.path.map((p) => [p.lon, p.lat]);
    // Pin ends to station/platform pins when known
    if (endA) coords[0] = endA;
    if (endB) coords[coords.length - 1] = endB;
  } else if (endA && endB) {
    coords = [endA, endB];
  }
  if (!coords || coords.length < 2) return null;

  return {
    type: "Feature",
    properties: {
      kind: "walk",
      walk_style: "street",
      walk_type: leg.walk_type || (role === "transfer" ? "transfer" : ""),
    },
    geometry: { type: "LineString", coordinates: coords },
  };
}

function addSecondsIso(iso, seconds) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + Math.max(0, Number(seconds) || 0) * 1000).toISOString();
}

function placesTooClose(a, b, meters = 80) {
  if (!a || !b) return false;
  const dLat = Number(a.lat) - Number(b.lat);
  const dLon = Number(a.lon) - Number(b.lon);
  if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) return false;
  return Math.hypot(dLat, dLon) * 111320 < meters;
}

/**
 * Snap a trip-plan pin: LRT stays on Light Rail; heavy-rail may snap to
 * station centroids. Same rules as the original OD snap in runPlan.
 * @param {{ lat: number, lon: number, label?: string, name?: string, isMtr?: boolean, isLrt?: boolean }} point
 */
function snapPlanEndpoint(point) {
  let lat = point.lat;
  let lon = point.lon;
  let isLrt = !!point.isLrt;
  let isMtr = !!point.isMtr && !isLrt;
  const label = point.label || point.name || "";

  const pinLrt = (lbl, la, lo) => matchLrtStop(lbl, la, lo, 350);
  if (isLrt || matchLrtStop(label, null, null, 0)) {
    const hit = pinLrt(label, lat, lon);
    if (hit) {
      const dualHub = /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
        String(hit.name_en || "").trim(),
      );
      const lrtSpecific = !dualHub || isLrt || /light\s*rail|輕鐵/i.test(label);
      if (lrtSpecific) {
        lat = hit.lat;
        lon = hit.lon;
        isLrt = true;
        isMtr = false;
      }
    }
  }
  if (!isLrt) {
    const snap = snapToMtrStation(lat, lon, label, isMtr ? 500 : 200);
    if (snap && (isMtr || wantsStationQuery(label))) {
      const lrtOnly = matchLrtStop(label, null, null, 0);
      const dualHub =
        lrtOnly &&
        /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
          String(lrtOnly.name_en || "").trim(),
        );
      if (!lrtOnly || dualHub) {
        lat = snap.lat;
        lon = snap.lon;
        isMtr = true;
      }
    }
  }
  return { lat, lon, isMtr, isLrt, label };
}

function shiftServiceDayIso(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(.+)$/.exec(String(iso || ""));
  if (!m) return iso;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days, 12, 0, 0),
  );
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}T${m[4]}`;
}

function planListHasRail(list) {
  return (list || []).some((p) => {
    if (p.mtr_only || p.has_mtr || p.has_lrt) return true;
    return (p.legs || []).some((l) => {
      if (l.type !== "transit") return false;
      const opt = l.route_options?.[0];
      const mode = String(opt?.mode || "").toLowerCase();
      return (
        mode === "subway" ||
        mode === "rail" ||
        mode === "light_rail" ||
        !!detectMtrLineCode(opt)
      );
    });
  });
}

function planHop(from, to, departAtIso, { compact = false } = {}) {
  const bothMtr = !!(from.isMtr && to.isMtr && !from.isLrt && !to.isLrt);
  // Access-to-station only. Keep under ~1.5 km so RAPTOR cannot treat a
  // Victoria Harbour crossing as a single walk (Central↔Austin ≈ 2.5 km).
  const maxWalk = bothMtr ? 1000 : from.isMtr || to.isMtr ? 1400 : 1200;

  function runQuery(walkM, speed, transfers, departOverride) {
    return planTrip({
      origin: [from.lat, from.lon],
      destination: [to.lat, to.lon],
      departAt: departOverride || departAtIso,
      maxResults: compact ? 4 : bothMtr ? 8 : 5,
      maxTransfers: transfers ?? (bothMtr ? 5 : 3),
      maxWalkDistance: walkM,
      walkingSpeed: speed,
      originIsMtr: !!from.isMtr,
      destIsMtr: !!to.isMtr,
      originIsStation: !!(from.isMtr || from.isLrt),
      destIsStation: !!(to.isMtr || to.isLrt),
      originLabel: from.label || "",
      destLabel: to.label || "",
      preferences: routePreferences,
      trafficMethods,
      busCompanies,
      modes: routerModesFromTrafficMethods(trafficMethods, ROUTER_MODES),
      fareEstimator: (p) => {
        try {
          const f = estimatePlanFare(p, getFareType());
          if (!f || f.total == null) return null;
          if (f.incomplete) return null;
          return f.total;
        } catch {
          return null;
        }
      },
    });
  }

  let result = runQuery(maxWalk, "slow");
  if (!result.plans?.length) {
    result = runQuery(bothMtr ? 1200 : Math.max(maxWalk, 1800), "normal");
  }
  if (!result.plans?.length && (from.isMtr || to.isMtr)) {
    result = runQuery(bothMtr ? 1400 : 2000, "normal", bothMtr ? 6 : 4);
  }
  // After last train, today's remaining rail can be empty even at 10:00 if
  // the feed's calendar_dates already rolled. Retry tomorrow morning.
  if ((from.isMtr || to.isMtr || from.isLrt || to.isLrt) && !planListHasRail(result.plans)) {
    const nextMorning = shiftServiceDayIso(departAtIso, 1).replace(
      /T\d{2}:\d{2}:/,
      "T05:30:",
    );
    const retry = runQuery(maxWalk, "normal", bothMtr ? 6 : 4, nextMorning);
    if (planListHasRail(retry.plans)) {
      console.info("[plan] rail retry next morning", nextMorning);
      result = retry;
    }
  }
  return { result, bothMtr };
}

function stitchViaPlans(first, second, viaPoint) {
  const meetLeg = {
    type: "meet",
    duration_seconds: 0,
    via_label: viaPoint.label,
    via_lat: viaPoint.lat,
    via_lon: viaPoint.lon,
  };
  const startMs = Date.parse(first.start_time);
  const endIso = addSecondsIso(second.start_time, second.duration_seconds || 0);
  const endMs = Date.parse(endIso);
  const duration =
    Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, Math.round((endMs - startMs) / 1000))
      : (first.duration_seconds || 0) + (second.duration_seconds || 0);
  const viaPoints = [
    ...(first.via_points || (first.via_point ? [first.via_point] : [])),
    viaPoint,
  ];
  const viaLabels = viaPoints.map((p) => p.label).filter(Boolean);
  return {
    duration_seconds: duration,
    start_time: first.start_time,
    legs: [...(first.legs || []), meetLeg, ...(second.legs || [])],
    transfer_count: (first.transfer_count || 0) + (second.transfer_count || 0),
    bus_transfer_count:
      (first.bus_transfer_count || 0) + (second.bus_transfer_count || 0),
    mtr_transfer_count:
      (first.mtr_transfer_count || 0) + (second.mtr_transfer_count || 0),
    mixed_transfer_count:
      (first.mixed_transfer_count || 0) + (second.mixed_transfer_count || 0),
    kcr_mtr_legacy_interchange_count:
      (first.kcr_mtr_legacy_interchange_count || 0) +
      (second.kcr_mtr_legacy_interchange_count || 0),
    walk_meters: (first.walk_meters || 0) + (second.walk_meters || 0),
    free_mtr_interchange_walks:
      (first.free_mtr_interchange_walks || 0) +
      (second.free_mtr_interchange_walks || 0),
    mtr_only: !!(first.mtr_only && second.mtr_only),
    via_point: viaPoint,
    via_points: viaPoints,
    via_label: viaLabels.join(" · "),
    via_labels: viaLabels,
    via_stitched: true,
    human_score: (first.human_score || 0) + (second.human_score || 0),
  };
}

function rankStitchedViaPlans(list) {
  const prefs = new Set(routePreferences.length ? routePreferences : ["fastest"]);
  const scored = list.map((p, i) => ({ p, i }));
  scored.sort((a, b) => {
    if (prefs.has("cheapest")) {
      const fa = a.p.fare;
      const fb = b.p.fare;
      const aOk = !!(fa && !fa.incomplete && fa.total != null);
      const bOk = !!(fb && !fb.incomplete && fb.total != null);
      if (aOk !== bOk) return aOk ? -1 : 1;
      if (aOk && bOk && fa.total !== fb.total) return fa.total - fb.total;
    }
    if (prefs.has("simplest")) {
      const ta = a.p.transfer_count ?? 99;
      const tb = b.p.transfer_count ?? 99;
      if (ta !== tb) return ta - tb;
    }
    const da = a.p.duration_seconds ?? 1e9;
    const db = b.p.duration_seconds ?? 1e9;
    if (da !== db) return da - db;
    return a.i - b.i;
  });
  return scored.map(({ p }, idx) => ({
    ...p,
    is_recommended: idx === 0,
  }));
}

function planThroughVias(stops, viaUsers, departAtIso) {
  const hopKeep = viaUsers.length > 1 ? 2 : 3;
  const beamKeep = 3;
  /** @type {Array<{ plan: object | null, arrive: string }>} */
  let beam = [{ plan: null, arrive: departAtIso }];
  for (let h = 0; h < stops.length - 1; h++) {
    const nextBeam = [];
    const seen = new Set();
    for (const partial of beam) {
      const hop = planHop(stops[h], stops[h + 1], partial.arrive, {
        compact: true,
      });
      for (const p of (hop.result.plans || []).slice(0, hopKeep)) {
        const combined = partial.plan
          ? stitchViaPlans(partial.plan, p, viaUsers[h - 1])
          : p;
        const key = planPinKey(combined);
        if (seen.has(key)) continue;
        seen.add(key);
        nextBeam.push({
          plan: combined,
          arrive: addSecondsIso(p.start_time, p.duration_seconds || 0),
        });
      }
    }
    if (!nextBeam.length) {
      return { plans: [], firstEmpty: h === 0 };
    }
    const ranked = rankStitchedViaPlans(nextBeam.map((x) => x.plan)).slice(
      0,
      beamKeep,
    );
    beam = ranked.map((plan) => ({
      plan,
      arrive: addSecondsIso(plan.start_time, plan.duration_seconds || 0),
    }));
  }
  const from = stops[0];
  const to = stops[stops.length - 1];
  return {
    plans: beam.map((b) => b.plan).slice(0, 5),
    bothMtr: !!(from.isMtr && to.isMtr && !from.isLrt && !to.isLrt),
    firstEmpty: false,
  };
}

function collectViaWaypoints(from, to) {
  const users = [];
  const snaps = [];
  let prev = from;
  for (const slot of vias) {
    const typed = String(slot.input?.value || "").trim();
    if (!slot.point) {
      if (typed) return { error: "unpicked" };
      continue;
    }
    const snap = snapPlanEndpoint(slot.point);
    if (placesTooClose(prev, snap) || placesTooClose(snap, to)) {
      showToast(t("Skipped a via that is too close to another point"), 2200);
      continue;
    }
    users.push(slot.point);
    snaps.push(snap);
    prev = snap;
  }
  return { users, snaps };
}

let planRunGen = 0;

function runPlan() {
  if (els.btnPlanCta) els.btnPlanCta.disabled = true;
  els.planResults.hidden = false;
  els.planResults.innerHTML = `<p class="hint">${escapeHtml(t("Planning…"))}</p>`;
  // Hide any previous path; blur until densified geometry is ready
  clearRouteGeometry();
  setMapRouteLoading(true, t("Planning…"));
  const myGen = ++planRunGen;
  // Paint “Planning…” before RAPTOR blocks the main thread.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (myGen !== planRunGen) return;
      runPlanCompute(myGen);
    });
  });
}

function runPlanCompute(myGen) {
  const t0 = performance.now();
  try {
    if (myGen !== planRunGen) return;
    const from = snapPlanEndpoint(origin);
    const to = snapPlanEndpoint(destination);
    const viaPack = collectViaWaypoints(from, to);
    if (viaPack.error === "unpicked") {
      setMapRouteLoading(false);
      els.planResults.innerHTML = `<p class="hint">${escapeHtml(
        t("Pick a via place from the list, or clear Via"),
      )}</p>`;
      showToast(t("Pick a via place from the list, or clear Via"), 2800);
      return;
    }
    const viaUsers = viaPack.users || [];
    const viaSnaps = viaPack.snaps || [];

    const departTimeResolved = resolveDepartTimeForPlan();
    const departAtIso = departAtForServiceDay(
      serviceDay,
      new Date(),
      departTimeResolved,
    );
    const viaNames = viaUsers.map((v) => v.label).filter(Boolean);
    console.info(
      "[plan] depart",
      departTimeResolved,
      serviceDay,
      departAtIso,
      viaNames.length ? `via ${viaNames.join(" · ")}` : "direct",
    );

    let resultPlans;
    let bothMtr;
    if (viaSnaps.length) {
      setMapRouteLoading(
        true,
        t("Planning via {place}…", { place: viaNames.join(" · ") }),
      );
      const viaResult = planThroughVias(
        [from, ...viaSnaps, to],
        viaUsers,
        departAtIso,
      );
      bothMtr = viaResult.bothMtr;
      resultPlans = viaResult.plans;
    } else {
      const hop = planHop(from, to, departAtIso);
      bothMtr = hop.bothMtr;
      resultPlans = hop.result.plans || [];
    }

    const ms = Math.round(performance.now() - t0);
    const ticket = getFareType();
    const leastFareOn = routePreferences.includes("cheapest");
    plans = (resultPlans || []).map((p) => {
      const fare = estimatePlanFare(p, ticket);
      return { ...p, fare };
    });
    if (viaSnaps.length && plans.length > 1) {
      plans = rankStitchedViaPlans(plans);
    } else if (leastFareOn && plans.length > 1) {
      plans = prioritizeCompleteFares(plans);
    }
    if (myGen !== planRunGen) return;
    renderPlans(plans, ms, {
      bothMtr,
      leastFareOn,
      viaLabel: viaNames.join(" · "),
    });
    if (plans.length) {
      // selectPlan keeps the veil until densified path is painted
      setMapRouteLoading(true, "Drawing route…");
      selectPlan(0);
    } else {
      clearRouteGeometry();
      setMapRouteLoading(false);
    }
    const rec = plans[0];
    const fareHint =
      leastFareOn && rec?.fare?.incomplete
        ? ""
        : rec?.fare
          ? ` · ${formatPlanFare(rec.fare)}`
          : "";
    const hint = bothMtr
      ? rec?.mtr_only
        ? " · " + t("MTR preferred")
        : " · " + t("MTR ends")
      : "";
    const emptyMsg = viaSnaps.length
      ? t("No routes found through via — try another meeting point")
      : t("No routes found — try other points");
    const okMsg = viaNames.length
      ? t("{n} plan(s) via {place} · {ms} ms", {
          n: plans.length,
          place: viaNames.join(" · "),
          ms,
        })
      : t("{n} plan(s) · {ms} ms", { n: plans.length, ms });
    showToast(plans.length ? okMsg + fareHint + hint : emptyMsg);
  } catch (err) {
    console.error("[plan]", err);
    clearRouteGeometry();
    setMapRouteLoading(false);
    els.planResults.innerHTML = `<p class="hint plan-error">${escapeHtml(err.message || String(err))}</p>`;
    showToast(t("Plan failed: {msg}", { msg: err.message || err }), 5000);
  } finally {
    updatePlanButton();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Hex-only colour for style attributes — never interpolate raw GTFS strings. */
function safeCssColor(color, fallback = "") {
  return normalizeHex(color) || fallback;
}

/** Class tokens only (no quotes / style breakout). */
function safeCssClass(s) {
  return String(s || "")
    .split(/\s+/)
    .filter((t) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t))
    .join(" ");
}

/** Material Symbols ligature names. */
function safeIconName(s, fallback = "directions_bus") {
  return /^[a-z0-9_]+$/i.test(String(s || "")) ? String(s) : fallback;
}

/**
 * Route colour for UI + map: prefer official MTR brand colours,
 * then GTFS/WASM color (often generic #003DA5 for all MTR lines).
 * @param {{ route_short_name?: string, route_long_name?: string, route_id?: string, color?: string }} [opt]
 * @param {string} [fallbackColor] raw hex when only a string is available
 */
function routeColorCss(opt, fallbackColor) {
  if (opt && typeof opt === "object") {
    return resolveRouteColor(opt);
  }
  // Legacy: first arg was a raw color string
  return resolveRouteColor({ color: opt || fallbackColor });
}

/** Prefer station-quality labels; hide bare "Platform N" when we have no parent. */
function formatStopName(stop) {
  if (!stop) return "";
  const localized = stopDisplayName(stop);
  const name = (localized || stop.stop_name || stop.address || "").trim();
  const platform = (stop.platform || "").trim();
  if (!name) {
    return platform ? t("Platform {p}", { p: platform }) : "";
  }
  // Already enriched by WASM (e.g. "Tung Chung (Platform 1)")
  if (/\(Platform\s+/i.test(name) || /月台/.test(name)) return name;
  // Bare platform label without station — still show what we have
  if (/^platform\s*\d+/i.test(name) && platform) {
    return t("Platform {p}", { p: platform });
  }
  return name;
}

function routeDisplayName(opt) {
  if (!opt) return "Transit";
  const short = opt.route_short_name || "";
  const long = opt.route_long_name || "";
  const name = opt.route_name || opt.route_id || "";
  // "TCL · Tung Chung Line …" when both present
  if (short && long && long.toLowerCase() !== short.toLowerCase()) {
    // Trim verbose long names: "Tung Chung Line (Tung Chung - Hong Kong)" → keep short + first clause
    const brief = long.split("(")[0].trim();
    return brief && brief !== short ? `${short} · ${brief}` : short;
  }
  return short || name || "Transit";
}

/**
 * Localized MTR line identifiers for the badge: upper = short code for
 * en / ja / ko, Chinese name for zh modes (Simplified via the zhMap for
 * zh-cn); lower = full English line name for every language.
 * @param {string} code
 * @param {string} [labelFallback]
 */
function mtrLineDisplayNames(code, labelFallback) {
  const rec = MTR_LINE_NAMES[String(code || "").toUpperCase()];
  const en = rec?.en || labelFallback || code || "";
  const zh = rec?.zh || "";
  const mode = LANG_META[getLang()].stationMode;
  let upper = code || en;
  if (mode === "hant" && zh) upper = zh;
  else if (mode === "hans" && zh) upper = simplifyZh(zh);
  return { upper, lower: en };
}

/**
 * MTR route badge: rounded pill in the official line colour, white text.
 * Upper = localized line name / code; lower = full English line name.
 * @param {string} code
 * @param {string} color
 * @param {string} [label]
 * @param {string} [extraClass]
 */
function mtrLineBadgeHtml(code, color, label, extraClass = "") {
  const names = mtrLineDisplayNames(code, label);
  const klass = safeCssClass(extraClass);
  const hex = safeCssColor(color, "#003DA5");
  return `<span class="mtr-route-badge${klass ? ` ${klass}` : ""}" style="--mtr-color:${hex}">
    <span class="mtr-route-badge-main">${escapeHtml(names.upper)}</span>
    <span class="mtr-route-badge-sub">${escapeHtml(names.lower)}</span>
  </span>`;
}

/**
 * Stop name for the current language: KMB directories carry name_tc +
 * name_en (GTFS fallbacks only English). zh modes prefer Chinese (Simplified
 * via the zhMap for zh-cn); en / ja / ko prefer English.
 * @param {{ name_en?: string, name?: string, name_tc?: string, name_zh?: string } | null | undefined} s
 */
function etaStopNameLabel(s) {
  if (!s) return "";
  const en = String(s.nameEn || s.name_en || "").trim();
  const tc = String(
    s.nameTc || s.name_tc || s.nameZh || s.name_zh || "",
  ).trim();
  const raw = String(s.name || s.stopLabel || s.stopName || "").trim();
  const looksZh = /[\u4e00-\u9fff]/.test(raw);
  return stopDisplayName({
    nameEn: en || (!looksZh ? raw : ""),
    nameTc: tc || (looksZh ? raw : ""),
    name: en || (!looksZh ? raw : ""),
  });
}

/** Display text for an ETA card’s current-stop line (language-aware). */
function etaCardStopLine(r, dir, eta = {}) {
  const fromFields = etaStopNameLabel({
    nameEn: eta.stopNameEn,
    nameTc: eta.stopNameTc,
    name: eta.stopLabel,
    stopId: eta.stopId,
  });
  if (fromFields) return fromFields;
  if (eta.stopId) {
    const lab = gtfsDirStopLabel(
      etaGtfsDir,
      eta.stopId,
      r?.co,
      "",
    );
    if (lab.name) return lab.name;
  }
  const raw = String(eta.stopLabel || r?.nearbyHint || "")
    .replace(/\s*·\s*\d+\s*m\s*$/i, "")
    .trim();
  if (raw) return etaStopNameLabel({ name: raw, stopId: eta.stopId });
  return dir?.orig ? localizeDirLabel(dir, "orig") : "";
}

/**
 * Classify a walk for UI copy.
 * - indoor / free: ONLY official cross-station free links (CEN↔HOK, TST↔ETS, MOK↔MKK)
 * - in_station: same MTR station line change (e.g. Admiralty TWL↔ISL)
 * - transfer: bus–bus, bus–MTR, or other walk between vehicles
 *
 * @returns {{ kind: string, from: string, to: string } | null}
 */
function classifyWalkBetweenTransit(leg, prevLeg, nextLeg) {
  if (!leg || leg.type !== "walk") return null;
  const fromStop =
    prevLeg?.type === "transit"
      ? prevLeg.route_options?.[0]?.to
      : leg.from;
  const toStop =
    nextLeg?.type === "transit"
      ? nextLeg.route_options?.[0]?.from
      : leg.to;
  const from = formatStopName(fromStop) || formatStopName(leg.from);
  const to = formatStopName(toStop) || formatStopName(leg.to);
  const dist =
    leg.distance_meters ??
    (typeof leg.duration_seconds === "number" ? leg.duration_seconds * 0.8 : 0);

  const prevIsMtr =
    prevLeg?.type === "transit" && isRailOption(prevLeg.route_options?.[0]);
  const nextIsMtr =
    nextLeg?.type === "transit" && isRailOption(nextLeg.route_options?.[0]);
  const betweenMtr = prevIsMtr && nextIsMtr;
  const betweenTransit =
    prevLeg?.type === "transit" && nextLeg?.type === "transit";

  // Dual-access stitch always targets a free pair (CEN↔HOK / TST↔ETS)
  if (leg.indoor_interchange || leg.free_mtr_link) {
    const blob = `${from} ${to}`.toLowerCase();
    const indoor =
      !!leg.indoor_interchange ||
      (/\bcentral\b|中環/.test(blob) &&
        /\bhong\s*kong\b|香港/.test(blob) &&
        !/university|大學/.test(blob));
    return {
      kind: indoor ? "indoor" : "free",
      from: from || "station",
      to: to || "station",
    };
  }

  // Same MTR station (platform change) — not a "free link" between stations
  if (betweenMtr && isSameMtrStation(fromStop, toStop)) {
    return {
      kind: "in_station",
      from: from || "station",
      to: to || "station",
    };
  }

  // Official free links between *different* stations only
  if (betweenMtr && isFreeMtrInterchangeWalk(fromStop, toStop, dist)) {
    const blob = `${from} ${to}`.toLowerCase();
    const indoor =
      /\bcentral\b|中環/.test(blob) &&
      /\bhong\s*kong\b|香港/.test(blob) &&
      !/university|大學/.test(blob);
    return {
      kind: indoor ? "indoor" : "free",
      from: from || "station",
      to: to || "station",
    };
  }

  const wtype = String(leg.walk_type || "").toLowerCase();
  if (wtype === "station_access" || wtype === "access") {
    return { kind: "access", from: from || "", to: to || "" };
  }
  if (wtype === "station_egress" || wtype === "egress") {
    return { kind: "egress", from: from || "", to: to || "" };
  }
  // Other MTR↔MTR (short in-station often tagged station_transfer)
  if (betweenMtr) {
    const same =
      isSameMtrStation(fromStop, toStop) ||
      (wtype === "station_transfer" && dist <= 280);
    return {
      kind: same ? "in_station" : "transfer",
      from: from || "",
      to: to || "",
    };
  }
  // Bus–bus / bus–MTR
  if (betweenTransit || wtype === "station_transfer") {
    return { kind: "transfer", from: from || "", to: to || "" };
  }
  return { kind: "walk", from: from || "", to: to || "" };
}

/**
 * True ferry service (not a bus terminus named "Ferry Pier").
 * @param {object} [opt]
 */
function isFerryTransitOption(opt) {
  if (!opt) return false;
  const mode = String(opt.mode || "").toLowerCase();
  if (mode === "bus" || mode === "trolleybus") return false;
  if (mode === "ferry") return true;
  const agency = String(opt.agency?.id || opt.agency?.name || "").toLowerCase();
  // Operators / product names — avoid bare "ferry" which matches "Ferry Pier" bus stops
  if (
    /star\s*ferry|sun\s*ferry|fortune\s*ferry|\bhkkf\b|香港油麻地|新渡輪|天星小輪/.test(
      agency,
    )
  ) {
    return true;
  }
  const routeBlob =
    `${opt.route_short_name || ""} ${opt.route_long_name || ""} ${opt.route_name || ""}`.toLowerCase();
  // Route title is a ferry product (not “… Ferry Pier” bus terminus)
  if (
    /star\s*ferry|sun\s*ferry|fortune\s*ferry/.test(routeBlob) ||
    (/\bferry\b|渡輪|小輪/.test(routeBlob) &&
      !/ferry\s*pier|碼頭|bus|巴士/.test(routeBlob))
  ) {
    return true;
  }
  return false;
}

/**
 * Material icon for a transit option (train / tram / bus / ferry).
 * @param {object} [opt]
 */
function transitModeIcon(opt) {
  const mode = String(opt?.mode || "").toLowerCase();
  const agency = String(opt?.agency?.id || opt?.agency?.name || "").toLowerCase();
  const blob = `${opt?.route_short_name || ""} ${opt?.route_long_name || ""} ${opt?.route_name || ""} ${agency}`.toLowerCase();
  // Bus first — many KMB/CTB routes end at “Central Ferry Piers” etc.
  if (mode === "bus" || mode === "trolleybus") return "directions_bus";
  if (
    agency === "lr" ||
    /light\s*rail|輕鐵|\blrt\b/.test(blob) ||
    mode === "tram" ||
    mode === "light_rail" ||
    mode === "cable_tram"
  ) {
    // HK Island tramways keep "tram"; LRT also uses tram glyph in Material
    return "tram";
  }
  if (isFerryTransitOption(opt)) return "directions_boat";
  if (
    mode.includes("subway") ||
    mode.includes("rail") ||
    mode.includes("metro") ||
    mode.includes("monorail") ||
    mode.includes("funicular") ||
    /mtr|eal|twl|isl|ktl|tml|tcl|tkl|ael|sil|drl/.test(blob)
  ) {
    return "train";
  }
  if (mode === "") return "directions_bus";
  return isRailOption(opt) ? "train" : "directions_bus";
}

/** Human mode noun for boarding copy: train / light rail / bus / ferry */
function transitModeNoun(opt) {
  const mode = String(opt?.mode || "").toLowerCase();
  const agency = String(opt?.agency?.id || opt?.agency?.name || "").toLowerCase();
  const blob = `${opt?.route_short_name || ""} ${opt?.route_long_name || ""} ${agency}`.toLowerCase();
  if (mode === "bus" || mode === "trolleybus") return "bus";
  if (agency === "lr" || /light\s*rail|輕鐵|\blrt\b/.test(blob)) return "light rail";
  if (mode === "tram" || mode === "cable_tram") {
    if (/tramways|香港電車|hk\s*tram/.test(blob)) return "tram";
    return "light rail";
  }
  if (isFerryTransitOption(opt)) return "ferry";
  if (
    mode.includes("subway") ||
    mode.includes("rail") ||
    mode.includes("metro") ||
    isRailOption(opt)
  ) {
    return "train";
  }
  return "bus";
}

/** Strip "(Platform N)" clutter for compact card titles. */
function cleanStopLabel(name) {
  return String(name || "")
    .replace(/\s*\(Platform\s*[^)]*\)/gi, "")
    .replace(/\s*月台\s*\d+/g, "")
    .trim();
}

/**
 * Board stop label for LRT: "Light Rail - Tuen Mun Station" style when useful.
 * @param {object} [opt]
 * @param {string} stopName
 */
function boardPlaceLabel(opt, stopName) {
  const clean = cleanStopLabel(stopName);
  if (!clean) return "";
  const noun = transitModeNoun(opt);
  if (noun === "light rail" && !/light\s*rail|輕鐵/i.test(clean)) {
    return `Light Rail - ${clean}`;
  }
  return clean;
}

function legSummary(leg, prevLeg, nextLeg) {
  if (leg.type === "walk") {
    const m =
      leg.distance_meters != null ? ` · ${Math.round(leg.distance_meters)} m` : "";
    const cls = classifyWalkBetweenTransit(leg, prevLeg, nextLeg);
    if (cls?.kind === "indoor") {
      return `Indoor interchange${m}: ${cls.from} → ${cls.to}`;
    }
    if (cls?.kind === "free") {
      return `Free MTR link${m}: ${cls.from} → ${cls.to}`;
    }
    if (cls?.kind === "in_station") {
      // Same station line change — e.g. Admiralty TWL ↔ ISL
      const place =
        cls.from && cls.to && cls.from !== cls.to
          ? `: ${cls.from} → ${cls.to}`
          : cls.from
            ? ` at ${cls.from.replace(/\s*\(platform[^)]*\)/gi, "").trim()}`
            : "";
      return `In-station interchange${m}${place}`;
    }
    if (cls?.kind === "transfer") {
      const places =
        cls.from && cls.to ? `: ${cls.from} → ${cls.to}` : "";
      return `Transfer walk${m}${places}`;
    }
    const from = formatStopName(leg.from);
    const to = formatStopName(leg.to);
    const places =
      from && to && from !== "START" && to !== "END"
        ? ` (${from} → ${to})`
        : "";
    if (cls?.kind === "access") {
      return `Walk to station ${formatDuration(leg.duration_seconds)}${m}${places}`;
    }
    if (cls?.kind === "egress") {
      return `Walk from station ${formatDuration(leg.duration_seconds)}${m}${places}`;
    }
    return `Walk ${formatDuration(leg.duration_seconds)}${m}${places}`;
  }
  if (leg.type === "wait") {
    return `Wait ${formatDuration(leg.duration_seconds)}`;
  }
  if (leg.type === "transit") {
    const opt = leg.route_options?.[0];
    if (!opt) return "Transit";
    const name = routeDisplayName(opt);
    const from = formatStopName(opt.from);
    const to = formatStopName(opt.to);
    return `${name}${from && to ? `: ${from} → ${to}` : ""}`;
  }
  return leg.type || "leg";
}

/** Duration label in parentheses, e.g. "(6 min)". */
function walkTimeParen(leg) {
  if (typeof leg?.duration_seconds !== "number" || leg.duration_seconds <= 0) {
    return "";
  }
  return ` (${formatDuration(leg.duration_seconds)})`;
}

/**
 * Station line: "Tung Chung - Platform 1" when platform known.
 * KMB public ids: "Tung Chung Station (TC450)".
 * @param {object} [stop]
 */
function stopLineLabel(stop) {
  if (!stop) return "";
  let name = (stopDisplayName(stop) || stop.stop_name || stop.address || "").trim();
  let platform = String(stop.platform || "").trim();
  const publicCode = extractPublicStopCode(stop);
  const m = name.match(/\(\s*Platform\s*([^)]+)\)/i);
  if (m) {
    if (!platform) platform = m[1].trim();
    name = name.replace(/\s*\(\s*Platform\s*[^)]*\)/gi, "").trim();
  }
  const zhPlat = name.match(/月台\s*(\d+)/);
  if (zhPlat) {
    if (!platform) platform = zhPlat[1];
    name = name.replace(/\s*月台\s*\d+/g, "").trim();
  }
  // Strip trailing public codes before re-attaching cleanly
  if (publicCode) {
    name = name.replace(new RegExp(`\\s*\\(${publicCode}\\)\\s*$`, "i"), "").trim();
  }
  name = cleanStopLabel(name) || name;
  if (!name) {
    if (platform) return t("Platform {p}", { p: platform });
    if (publicCode) return publicCode;
    return "";
  }
  if (platform && !/^platform\b/i.test(platform)) {
    name = t("{base} - Platform {p}", { base: name, p: platform });
  } else if (platform) {
    name = `${name} - ${platform}`;
  }
  // KMB/LWB-style public stop id (TC450) when known
  if (publicCode && !platform) {
    return stopLabelWithPublicId(stop, name);
  }
  return name;
}

/**
 * Walk step copy for the route-line timeline.
 */
function walkConnectorText(leg, prevLeg, nextLeg) {
  const cls = classifyWalkBetweenTransit(leg, prevLeg, nextLeg);
  const time = walkTimeParen(leg);

  // Final egress
  if (cls?.kind === "egress" || (!nextLeg && prevLeg?.type === "transit")) {
    const dest =
      cleanStopLabel(formatStopName(leg.to)) ||
      cleanStopLabel(cls?.to) ||
      "";
    if (dest && dest !== "END" && !/^destination$/i.test(dest)) {
      return t("Walk to {dest}", { dest }) + time;
    }
    return t("Walk to destination") + time;
  }

  // Next vehicle boarding
  if (nextLeg?.type === "transit") {
    const opt = nextLeg.route_options?.[0];
    const boardRaw =
      formatStopName(opt?.from) ||
      formatStopName(leg.to) ||
      cls?.to ||
      "";
    const place = boardPlaceLabel(opt, boardRaw);
    const noun = transitModeNoun(opt);
    const station =
      cleanStopLabel(boardRaw) ||
      cleanStopLabel(formatStopName(leg.to)) ||
      place;

    if (cls?.kind === "in_station") {
      return station
        ? t("Change platforms at {station}", { station }) + time
        : t("Change platforms") + time;
    }
    if (cls?.kind === "indoor" || cls?.kind === "free") {
      return place
        ? t("Walk the free link to {place}", { place }) + time
        : t("Free MTR link") + time;
    }
    // Walk to station (access / transfer) — show station + time
    if (cls?.kind === "access" || cls?.kind === "transfer" || cls?.kind === "walk") {
      if (station && isRailOption(opt)) {
        return t("Walk to {dest}", { dest: station }) + time;
      }
      if (station && !isRailOption(opt)) {
        return t("Please get on the {noun} at {place}", { noun, place: place || station });
      }
    }
    if (place) {
      return t("Please get on the {noun} at {place}", { noun, place });
    }
  }

  if (cls?.kind === "indoor") {
    return t("Indoor interchange: {from} → {to}", { from: cleanStopLabel(cls.from), to: cleanStopLabel(cls.to) }) + time;
  }
  if (cls?.kind === "free") {
    return t("Free MTR link: {from} → {to}", { from: cleanStopLabel(cls.from), to: cleanStopLabel(cls.to) }) + time;
  }
  if (cls?.kind === "in_station") {
    const place = cleanStopLabel(cls.from || cls.to);
    return place ? t("In-station interchange at {place}", { place }) + time : t("In-station interchange") + time;
  }
  if (cls?.kind === "transfer") {
    const to = cleanStopLabel(cls.to || formatStopName(leg.to));
    return to ? t("Walk to {dest}", { dest: to }) + time : t("Transfer walk") + time;
  }
  if (cls?.kind === "access") {
    const to =
      cleanStopLabel(formatStopName(leg.to)) || cleanStopLabel(cls?.to);
    return to ? t("Walk to {dest}", { dest: to }) + time : t("Walk to station") + time;
  }
  return time ? t("Walk") + time : t("Walk");
}

/**
 * Route chip label: short number / line id.
 * @param {object} [opt]
 */
function transitRouteLabel(opt) {
  if (!opt) return t("Transit");
  const short = (opt.route_short_name || "").trim();
  if (short) return short;
  return routeDisplayName(opt);
}

/**
 * Destination name for a transit header (no "To " prefix).
 * @param {object} [opt]
 */
function transitDirectionDest(opt) {
  if (!opt) return "";
  const head = String(opt.headsign || "").trim();
  if (head) return head.replace(/^to\s+/i, "").trim();
  return cleanStopLabel(formatStopName(opt.to));
}

/**
 * "To {headsign|destination}" for transit header.
 * @param {object} [opt]
 */
function transitDirectionLabel(opt) {
  const dest = transitDirectionDest(opt);
  return dest ? t("To {dest}", { dest }) : "";
}

/**
 * Direction label beside the route chip.
 * Heavy-rail MTR: stacked “To” + larger dest. Bus / LRT / ferry stay one line.
 * @param {object} [opt]
 */
function transitDirectionHtml(opt) {
  const dest = transitDirectionDest(opt);
  if (!dest) return "";
  const phrase = t("To {dest}", { dest });
  const mtrCode = detectMtrLineCode(opt);
  const stackMtr = !!(mtrCode && mtrCode !== "LRT");
  if (!stackMtr) {
    return `<span class="rt-route-to">${escapeHtml(phrase)}</span>`;
  }
  const idx = phrase.indexOf(dest);
  const prefix = idx > 0 ? phrase.slice(0, idx).trim() : idx < 0 ? phrase : "";
  const suffix = idx >= 0 ? phrase.slice(idx + dest.length).trim() : "";
  return `<span class="rt-route-to rt-route-to-mtr">
    ${prefix ? `<span class="rt-route-to-prefix">${escapeHtml(prefix)}</span>` : ""}
    <span class="rt-route-to-dest">${escapeHtml(dest)}</span>
    ${suffix ? `<span class="rt-route-to-prefix">${escapeHtml(suffix)}</span>` : ""}
  </span>`;
}

/**
 * Stops for a transit leg.
 * Merges KMB same public id (TC450) and CTB/NLB same-name nearby stops.
 * @param {object} opt
 * @param {{ full?: boolean }} [opts] full=true includes pass-by stops; else board+alight only
 * @returns {object[]}
 */
function transitStopSequence(opt, opts = {}) {
  if (!opt) return [];
  const raw =
    Array.isArray(opt.stops) && opt.stops.length >= 2
      ? opt.stops
      : [opt.from, opt.to].filter(Boolean);
  if (!raw.length) return [];
  // Collapse duplicate bays (joint ops / dual stop ids / same name nearby)
  const merged = mergeStopSequence(raw, { nearbyM: 90 });
  if (opts.full) return merged;
  // Result cards: board + alight only (pass-by stops live on trip detail page)
  if (merged.length <= 1) return merged;
  return [merged[0], merged[merged.length - 1]];
}

/**
 * “Ride N stops” count for plan cards (all modes: MTR, LRT, bus, ferry…).
 * N = intermediate stops + 1 = segments between board and alight.
 * When the graph only returns endpoints, N = 1.
 * @param {object} opt
 * @returns {number} 0 if unknown / same stop
 */
function rideStopCount(opt) {
  const all = transitStopSequence(opt, { full: true });
  if (all.length >= 2) {
    const a = stopLineLabel(all[0]);
    const b = stopLineLabel(all[all.length - 1]);
    if (a && b && a === b && all.length === 2) return 0;
    // middle + 1  ≡  all.length - 1
    return Math.max(1, all.length - 1);
  }
  return 0;
}

/** color-mix support check (white-mixed passed rail). */
let cssColorMix = null;
function cssSupportsColorMix() {
  if (cssColorMix == null) {
    try {
      cssColorMix = !!(
        typeof CSS !== "undefined" &&
        CSS.supports &&
        CSS.supports("color", "color-mix(in srgb, red 50%, blue)")
      );
    } catch {
      cssColorMix = false;
    }
  }
  return cssColorMix;
}

/**
 * Mix a hex colour toward white (opaque) — the passed-route look: company
 * colour lightened, no grey / no alpha. Non-hex inputs pass through.
 * @param {string} color
 * @param {number} [whiteRatio] 0..1 (0.4 = 60% colour + 40% white)
 * @returns {string}
 */
function mixTowardWhite(color, whiteRatio = 0.4) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || "").trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const w = Math.max(0, Math.min(1, Number(whiteRatio) || 0));
  const to2 = (n) => n.toString(16).padStart(2, "0");
  const mix = (v) => Math.round(v + (255 - v) * w);
  return `#${[0, 2, 4]
    .map((i) => to2(mix(parseInt(hex.slice(i, i + 2), 16))))
    .join("")}`;
}

/**
 * One timeline row: left rail (icon/dot + vertical line) + body.
 * @param {{ kind: string, line: 'solid'|'dotted'|'none', color?: string, icon?: string, bodyHtml: string, last?: boolean, extraClass?: string }} row
 */
function routeLineRowHtml(row) {
  const color = safeCssColor(row.color);
  const styleColor = color ? ` style="--rt-color:${color}"` : "";
  const lineClass =
    row.line === "solid"
      ? "rt-line rt-line-solid"
      : row.line === "dotted"
        ? "rt-line rt-line-dotted"
        : "rt-line rt-line-none";
  let marker;
  if (row.kind === "walk") {
    marker = `<span class="rt-marker rt-marker-walk material-symbols-outlined" aria-hidden="true">directions_walk</span>`;
  } else if (row.kind === "wait") {
    marker = `<span class="rt-marker rt-marker-wait material-symbols-outlined" aria-hidden="true">schedule</span>`;
  } else if (row.kind === "transit") {
    marker = `<span class="rt-marker rt-marker-mode material-symbols-outlined" aria-hidden="true">${safeIconName(row.icon)}</span>`;
  } else if (row.kind === "via") {
    // Smaller hollow circle — intermediate “Ride N stops”
    marker = `<span class="rt-marker rt-marker-via" aria-hidden="true"></span>`;
  } else if (row.kind === "meet") {
    marker = `<span class="rt-marker rt-marker-meet material-symbols-outlined" aria-hidden="true">group</span>`;
  } else {
    // stop (board / alight)
    marker = `<span class="rt-marker rt-marker-dot" aria-hidden="true"></span>`;
  }
  const extraClass = safeCssClass(row.extraClass);
  const extra = extraClass ? ` ${extraClass}` : "";
  return `<div class="rt-step rt-step-${row.kind}${extra}${row.last ? " rt-step-last" : ""}"${styleColor}>
    <div class="rt-rail" aria-hidden="true">
      ${marker}
      <span class="${lineClass}"></span>
    </div>
    <div class="rt-body">${row.bodyHtml}</div>
  </div>`;
}

/**
 * Final walk after transit to the destination pin (egress).
 * @param {object} leg
 * @param {number} index index in the full legs array
 * @param {object[]} allLegs
 */
function isFinalWalkToDestination(leg, index, allLegs) {
  if (!leg || leg.type !== "walk") return false;
  if (index !== allLegs.length - 1) return false;
  const wtype = String(leg.walk_type || "").toLowerCase();
  if (wtype === "egress" || wtype === "station_egress") return true;
  // Last leg is walk after a transit (possibly with waits) → walk to destination
  for (let i = index - 1; i >= 0; i--) {
    const t = allLegs[i]?.type;
    if (t === "transit") return true;
    if (t === "wait") continue;
    // Another walk / unknown before → not pure destination egress
    return false;
  }
  return false;
}

/**
 * Continuous route-line timeline for a plan (not per-leg cards).
 * @param {object[]} legsArr
 * @param {{ fullStops?: boolean, liveEta?: boolean, hideDestWalk?: boolean }} [opts]
 *   fullStops: include pass-by intermediate stops
 *   liveEta: board-stop ETA placeholders (trip detail)
 *   hideDestWalk: omit final “walk to destination” (default on for trip detail)
 */
function planRouteLineHtml(legsArr, opts = {}) {
  const fullStops = !!opts.fullStops;
  const liveEta = !!opts.liveEta;
  // Trip detail: never show final walk-to-destination (alight is the end)
  const hideDestWalk =
    opts.hideDestWalk !== undefined
      ? !!opts.hideDestWalk
      : !!(liveEta || fullStops);
  // Keep original indices for ETA mapping when liveEta is on
  const rawLegs = legsArr || [];
  const legs = rawLegs
    .map((l, origIndex) => ({ leg: l, origIndex }))
    .filter(({ leg: l, origIndex }) => {
      if (l.type === "wait" && !liveEta && (l.duration_seconds || 0) < 45) {
        return false;
      }
      if (
        hideDestWalk &&
        isFinalWalkToDestination(l, origIndex, rawLegs)
      ) {
        return false;
      }
      return true;
    });
  /** @type {Array<{ kind: string, line: 'solid'|'dotted'|'none', color?: string, icon?: string, bodyHtml: string, extraClass?: string }>} */
  const rows = [];

  for (let i = 0; i < legs.length; i++) {
    const { leg, origIndex } = legs[i];
    const prev = legs[i - 1]?.leg;
    const next = legs[i + 1]?.leg;

    if (leg.type === "walk") {
      const cls = classifyWalkBetweenTransit(leg, prev, next);
      const kindExtra =
        cls?.kind === "indoor"
          ? " rt-walk-indoor"
          : cls?.kind === "free"
            ? " rt-walk-free"
            : cls?.kind === "in_station"
              ? " rt-walk-in-station"
              : "";
      const text = walkConnectorText(leg, prev, next);
      rows.push({
        kind: "walk",
        line: "dotted",
        bodyHtml: `<span class="rt-walk-text${kindExtra}">${escapeHtml(text)}</span>`,
      });
      continue;
    }

    if (leg.type === "wait") {
      if (!liveEta && (leg.duration_seconds || 0) < 45) continue;
      rows.push({
        kind: "wait",
        line: "dotted",
        bodyHtml: `<span class="rt-wait-text">${escapeHtml(`Wait ${formatDuration(leg.duration_seconds)}`)}</span>`,
      });
      continue;
    }

    if (leg.type === "meet") {
      const place = leg.via_label || t("Via");
      rows.push({
        kind: "meet",
        line: next ? "dotted" : "none",
        bodyHtml: `<span class="rt-meet-text">${escapeHtml(
          t("Meet at {place}", { place }),
        )}</span>`,
      });
      continue;
    }

    if (leg.type === "transit") {
      const opt = leg.route_options?.[0];
      const color = routeColorCss(opt) || "#c0aefc";
      const icon = transitModeIcon(opt);
      const route = transitRouteLabel(opt);
      const dir = transitDirectionLabel(opt);
      // MTR legs get the coloured pill badge (line name over English full name)
      const mtrCode = detectMtrLineCode(opt);
      const routeBadge =
        mtrCode && mtrCode !== "LRT"
          ? mtrLineBadgeHtml(mtrCode, color, route, "rt-route-badge")
          : `<span class="rt-route-id">${escapeHtml(route)}</span>`;
      const stops = transitStopSequence(opt, { full: fullStops });
      // Ride N for all modes (bus / LRT / MTR / ferry…) — not MTR-only
      const rideN = rideStopCount(opt);

      rows.push({
        kind: "transit",
        line: "solid",
        color,
        icon,
        bodyHtml: `<div class="rt-transit-head">
          ${routeBadge}
          ${transitDirectionHtml(opt)}
        </div>`,
      });

      if (!stops.length) {
        rows.push({
          kind: "stop",
          line: next ? "dotted" : "none",
          color,
          bodyHtml: `<span class="rt-stop-name">${escapeHtml(t("Transit"))}</span>`,
        });
      } else if (!fullStops && stops.length >= 2) {
        // Compact plan card: board · Ride N stops · alight (MTR, LRT, bus, ferry…)
        const board = stops[0];
        const alight = stops[stops.length - 1];
        const hasVia = rideN >= 1;
        rows.push({
          kind: "stop",
          line: "solid",
          color,
          extraClass: hasVia ? "rt-stop-board-compact" : "",
          bodyHtml: `<span class="rt-stop-name">${escapeHtml(stopLineLabel(board) || t("Board"))}</span>`,
        });
        if (hasVia) {
          rows.push({
            kind: "via",
            line: "solid",
            color,
            bodyHtml: `<span class="rt-via-text">${escapeHtml(t("Ride {n} stop{s}", { n: rideN, s: rideN === 1 ? "" : "s" }))}</span>`,
          });
        }
        rows.push({
          kind: "stop",
          line: next ? "dotted" : "none",
          color,
          extraClass: hasVia ? "rt-stop-alight-compact" : "",
          bodyHtml: `<span class="rt-stop-name">${escapeHtml(stopLineLabel(alight) || t("Alight"))}</span>`,
        });
      } else {
        // Full detail page: every stop
        for (let s = 0; s < stops.length; s++) {
          const isLastStop = s === stops.length - 1;
          const isFirst = s === 0;
          let line = "solid";
          if (isLastStop) {
            line = next ? "dotted" : "none";
          }
          const label = stopLineLabel(stops[s]) || t("Stop");
          let roleClass = "";
          /** @type {"board"|"passby"|"alight"|""} */
          let role = "";
          let roleLabel = "";
          if (fullStops && stops.length >= 2) {
            if (isFirst) {
              roleClass = " rt-stop-board";
              role = "board";
              roleLabel = "BOARD";
            } else if (isLastStop) {
              roleClass = " rt-stop-alight";
              role = "alight";
              roleLabel = "ALIGHT";
            } else {
              roleClass = " rt-stop-passby";
              role = "passby";
              roleLabel = "PASS BY";
            }
          } else if (fullStops && isFirst) {
            roleClass = " rt-stop-board";
            role = "board";
            roleLabel = "BOARD";
          } else if (fullStops && isLastStop) {
            roleClass = " rt-stop-alight";
            role = "alight";
            roleLabel = "ALIGHT";
          }
          // Trip detail: role line shows "BOARD - HH:MM" once live times apply
          const roleHtml =
            liveEta && role
              ? `<span class="rt-stop-role rt-stop-time" data-eta-leg="${origIndex}" data-eta-stop="${s}" data-eta-role="${role}" aria-live="polite">${escapeHtml(roleLabel)} - <span class="rt-stop-clock">--:--</span></span>`
              : roleLabel
                ? `<span class="rt-stop-role">${escapeHtml(roleLabel)}</span>`
                : "";
          const etaCard =
            liveEta && isFirst
              ? `<div class="wheels-eta-card trip-detail-eta-card" data-eta-card-leg="${origIndex}" aria-live="polite" aria-label="Live status" style="--wheels-route-color:${safeCssColor(color, "#888888")}">
                  <div class="wheels-eta-dest">
                    <span class="material-symbols-outlined wheels-eta-dest-icon" aria-hidden="true">arrow_forward</span>
                    <span class="wheels-eta-dest-text">${dir ? escapeHtml(dir) : ""}</span>
                    <span class="wheels-eta-updated" data-eta-updated data-fetched-at="">Updated —</span>
                  </div>
                  <p class="wheels-eta-board" data-eta-card-board hidden></p>
                  <div class="wheels-eta-slots" data-eta-card-slots role="list" aria-label="Live arrivals">
                    <div class="wheels-eta-slot is-empty"><span class="wheels-eta-wait">…</span></div>
                  </div>
                  <button type="button" class="trip-eta-route-details-btn" data-eta-route-details="${origIndex}" data-acrylic>
                    <span class="btn-row">
                      <span class="material-symbols-outlined" aria-hidden="true">route</span>
                      ${escapeHtml(t("Show route details"))}
                    </span>
                  </button>
                </div>`
              : "";
          const nameAttrs =
            liveEta && isFirst
              ? ` data-eta-board-name-leg="${origIndex}" data-eta-board-base="${escapeHtml(stationBaseName(label) || label)}"`
              : "";
          rows.push({
            kind: "stop",
            line,
            color,
            extraClass: liveEta && isFirst ? "rt-stop-has-eta" : "",
            bodyHtml: `<span class="rt-stop-name${roleClass}"${nameAttrs}>${escapeHtml(label)}</span>${roleHtml}${etaCard}`,
          });
        }
      }
      continue;
    }

    rows.push({
      kind: "wait",
      line: "dotted",
      bodyHtml: `<span class="rt-wait-text">${escapeHtml(legSummary(leg, prev, next))}</span>`,
    });
  }

  if (!rows.length) {
    return `<div class="plan-timeline plan-route-line"><p class="hint">No leg details</p></div>`;
  }
  // Clear line under final row
  rows[rows.length - 1].line = "none";
  rows[rows.length - 1].last = true;

  return `<div class="plan-timeline plan-route-line${fullStops ? " plan-route-line-full" : ""}">${rows
    .map((r) => routeLineRowHtml(r))
    .join("")}</div>`;
}

/** @deprecated use planRouteLineHtml — kept for single-leg callers */
function legTimelineHtml(leg, prevLeg, nextLeg) {
  return planRouteLineHtml([leg]);
}

/**
 * Detect AEL leg and board/alight station names on a plan.
 * @param {object} plan
 * @returns {{ hasAel: boolean, board: string, alight: string, boards: string[], alights: string[] }}
 */
function aelLegInfo(plan) {
  const boards = [];
  const alights = [];
  for (const leg of plan?.legs || []) {
    if (leg.type !== "transit") continue;
    const opt = leg.route_options?.[0];
    if (!opt) continue;
    const blob =
      `${opt.route_short_name || ""} ${opt.route_long_name || ""} ${opt.route_name || ""} ${opt.route_id || ""}`.toLowerCase();
    const isAel =
      /\bael\b/.test(blob) ||
      /airport\s*express/.test(blob) ||
      /mtr-ael/.test(blob);
    if (!isAel) continue;
    const from = formatStopName(opt.from) || opt.from?.stop_name || "";
    const to = formatStopName(opt.to) || opt.to?.stop_name || "";
    if (from) boards.push(from);
    if (to) alights.push(to);
  }
  return {
    hasAel: boards.length > 0 || alights.length > 0,
    board: boards[0] || "",
    alight: alights[alights.length - 1] || "",
    boards,
    alights,
  };
}

function isAirportStationName(name) {
  const s = String(name || "");
  // Airport but not AsiaWorld-Expo / Airport Expo Boulevard bus stops alone
  if (/asia\s*world|博覽|expo\s*boulevard/i.test(s)) return false;
  return /\bairport\b|機場/.test(s) && !/express\s*boulevard/i.test(s);
}

function isAweStationName(name) {
  const s = String(name || "");
  return /asia\s*world|\bawe\b|博覽/.test(s);
}

/**
 * City-side AEL station for rebate copy (Hong Kong / Kowloon / Tsing Yi).
 * @param {string} boardName
 * @returns {"hong_kong"|"kowloon"|"tsing_yi"|null}
 */
function aelCitySideKey(boardName) {
  const s = String(boardName || "").toLowerCase();
  if (/hong\s*kong|香港/.test(s) && !/university|大學/.test(s)) return "hong_kong";
  if (/kowloon|九龍/.test(s) && !/tong|bay|塘|灣/.test(s)) return "kowloon";
  if (/tsing\s*yi|青衣/.test(s)) return "tsing_yi";
  return null;
}

/** Official-style AWE same-day rebate amounts (adult Octopus scheme). */
const AWE_AEL_REBATE = {
  tsing_yi: 20,
  kowloon: 27,
  hong_kong: 35,
};

/**
 * Promo notes for AEL trips to Airport / AsiaWorld-Expo.
 * Hidden when origin is Airport (outbound from Airport is excluded).
 * @param {object} plan
 * @param {{ label?: string } | null} [originPt]
 * @param {{ label?: string } | null} [destPt]
 * @returns {{ kind: "airport"|"awe", html: string } | null}
 */
function aelPromoForPlan(plan, originPt = origin, destPt = destination) {
  // Same-day / AWE AEL offers require Octopus, QR, or contactless — not single-ride cash
  if (getFareType() === "single_ride") return null;

  const info = aelLegInfo(plan);
  if (!info.hasAel) return null;

  const originLabel =
    originPt?.label || originPt?.name || info.board || "";
  const destLabel =
    destPt?.label || destPt?.name || info.alight || "";

  // Except from Airport — no same-day return promo when starting at Airport
  if (
    isAirportStationName(originLabel) ||
    info.boards.some(isAirportStationName)
  ) {
    return null;
  }

  const goesToAirport =
    isAirportStationName(destLabel) ||
    info.alights.some(isAirportStationName) ||
    isAirportStationName(info.alight);
  const goesToAwe =
    isAweStationName(destLabel) ||
    info.alights.some(isAweStationName) ||
    isAweStationName(info.alight);

  if (goesToAwe) {
    const city =
      aelCitySideKey(info.board) || aelCitySideKey(originLabel) || null;
    let rebatePhrase;
    if (city === "hong_kong") {
      rebatePhrase = "rebate of $35 (Hong Kong → AsiaWorld-Expo)";
    } else if (city === "kowloon") {
      rebatePhrase = "rebate of $27 (Kowloon → AsiaWorld-Expo)";
    } else if (city === "tsing_yi") {
      rebatePhrase = "rebate of $20 (Tsing Yi → AsiaWorld-Expo)";
    } else {
      rebatePhrase =
        "rebate of $20 (Tsing Yi) / $27 (Kowloon) / $35 (Hong Kong)";
    }
    return {
      kind: "awe",
      html: `<div class="plan-ael-promo plan-ael-promo-awe" role="note">
        <span class="material-symbols-outlined plan-ael-promo-icon" aria-hidden="true">confirmation_number</span>
        <div class="plan-ael-promo-body">
          <strong class="plan-ael-promo-title">AsiaWorld-Expo · Airport Express</strong>
          <p class="plan-ael-promo-text">Stay in AsiaWorld-Expo for longer than 1 hour to enjoy free return and ${escapeHtml(rebatePhrase)}, or free return for staying less than 1 hour.</p>
        </div>
      </div>`,
    };
  }

  if (goesToAirport) {
    return {
      kind: "airport",
      html: `<div class="plan-ael-promo plan-ael-promo-airport" role="note">
        <span class="material-symbols-outlined plan-ael-promo-icon" aria-hidden="true">flight</span>
        <div class="plan-ael-promo-body">
          <strong class="plan-ael-promo-title">Airport · Airport Express</strong>
          <p class="plan-ael-promo-text">Return with Airport Express on the same day for a free return ride.</p>
        </div>
      </div>`,
    };
  }

  return null;
}

function transferLabel(p) {
  const bus = p.bus_transfer_count ?? 0;
  const mtr = p.mtr_transfer_count ?? 0;
  const mixed = p.mixed_transfer_count ?? 0;
  const legacy = p.kcr_mtr_legacy_interchange_count ?? 0;
  const freeX = p.free_mtr_interchange_walks ?? 0;
  const total = p.transfer_count ?? 0;
  if (total <= 0) return "Direct";
  const parts = [];
  if (mtr > 0) {
    const freeNote =
      freeX > 0
        ? ` · ${freeX} free MTR link${freeX > 1 ? "s" : ""}`
        : "";
    const legacyNote =
      legacy > 0 ? ` (${legacy} longer hub${legacy > 1 ? "s" : ""})` : "";
    parts.push(
      `${mtr} MTR change${mtr > 1 ? "s" : ""}${freeNote}${legacyNote}`,
    );
  }
  if (bus > 0) parts.push(`${bus} bus transfer${bus > 1 ? "s" : ""}`);
  if (mixed > 0 && !parts.length) {
    parts.push(`${mixed} transfer${mixed > 1 ? "s" : ""}`);
  }
  if (!parts.length) {
    return total === 1 ? "1 transfer" : `${total} transfers`;
  }
  return parts.join(" · ");
}

function walkLabel(meters) {
  if (meters == null || meters <= 0) return "No walk";
  if (meters < 1000) return `${Math.round(meters)} m walk`;
  return `${(meters / 1000).toFixed(1)} km walk`;
}

/**
 * When Least fare is on: complete fares first, then by total, then human_score.
 * @param {Array<object>} list
 */
function prioritizeCompleteFares(list) {
  const scored = list.map((p, i) => ({ p, i }));
  scored.sort((a, b) => {
    const fa = a.p.fare;
    const fb = b.p.fare;
    const aOk = !!(fa && !fa.incomplete && fa.total != null);
    const bOk = !!(fb && !fb.incomplete && fb.total != null);
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (aOk && bOk && fa.total !== fb.total) return fa.total - fb.total;
    const hs = (a.p.human_score ?? 1e9) - (b.p.human_score ?? 1e9);
    if (hs !== 0) return hs;
    return a.i - b.i;
  });
  return scored.map(({ p }, idx) => ({
    ...p,
    is_recommended: idx === 0,
  }));
}

function renderPlans(list, ms, opts = {}) {
  // New results replace trip detail page if open
  if (sidebarPage === "trip") closeTripDetailPage();
  if (!list.length) {
    els.planResults.innerHTML = `<p class="hint">${escapeHtml(t("No routes found."))}<br>${escapeHtml(t("Try different locations or a later departure."))}</p>`;
    els.planResults.hidden = false;
    return;
  }
  const leastFareOn =
    opts.leastFareOn || routePreferences.includes("cheapest");
  const cards = list
    .map((p, idx) => planCardHtml(p, idx, { leastFareOn }))
    .join("");
  els.planResults.innerHTML =
    `<h3 class="results-section-title">${escapeHtml(t("Plan Results"))}</h3>` + cards;
  els.planResults.hidden = false;
  els.planResults.querySelectorAll(".plan-card").forEach((card) => {
    const idx = Number(card.dataset.idx);
    card.style.setProperty("--i", String(idx));
    card.addEventListener("click", (e) => {
      if (e.target.closest(".plan-detail-btn") || e.target.closest(".plan-pin-btn")) {
        return;
      }
      selectPlan(idx);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectPlan(idx);
      }
    });
  });
  els.planResults.querySelectorAll(".plan-detail-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTripDetailPage(Number(btn.dataset.detailIdx));
    });
  });
  els.planResults.querySelectorAll("[data-plan-pin]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.planPin);
      const plan = plans[idx];
      if (!plan) return;
      const pinned = togglePinPlan(plan);
      setPlanPinButton(btn, pinned);
      showToast(pinned ? "Trip plan pinned" : "Trip plan unpinned", 1600);
    });
  });
}

/**
 * One plan card — shared by Plan Results and Pinned Trips.
 * @param {object} p
 * @param {number} idx
 * @param {{
 *   leastFareOn?: boolean,
 *   pinned?: boolean,
 *   planKey?: string,
 *   pinState?: boolean,
 *   originPt?: { label?: string } | null,
 *   destPt?: { label?: string } | null,
 * }} [opts]
 */
function planCardHtml(p, idx, opts = {}) {
  const { leastFareOn = false, pinned = false, planKey = "", pinState } = opts;
  const legsArr = p.legs || [];
  const timeline = planRouteLineHtml(legsArr);
  const walkM = p.walk_meters;
  // Always re-estimate with the current ticket type (never stale adult fares)
  const fare = estimatePlanFare(p, getFareType());
  p.fare = fare;
  // Least fare + first card: never show incomplete / partial fare as a number
  const fareText =
    leastFareOn && idx === 0 && fare.incomplete
      ? "N/A"
      : formatPlanFare(fare);
  const fareTitle = (fare.parts || [])
    .map((part) => {
      const paid = formatFarePartAmount(part);
      if (
        part.adult_amount != null &&
        part.amount != null &&
        part.adult_amount !== part.amount
      ) {
        return `${part.label}: ${paid} (adult $${Number(part.adult_amount).toFixed(1)})`;
      }
      return `${part.label}: ${paid}`;
    })
    .join("\n");
  const badges = [];
  if (!pinned && (p.is_recommended || idx === 0)) {
    badges.push(`<span class="plan-badge">Recommended</span>`);
  }
  // Cross-station free links only (not same-station platform changes)
  if ((p.free_mtr_interchange_walks || 0) > 0) {
    badges.push(
      `<span class="plan-badge plan-badge-indoor" title="Cross-station free walkway (Central↔Hong Kong, TST↔East TST, …)">Free MTR link</span>`,
    );
  }
  if (p.mtr_only) {
    badges.push(`<span class="plan-badge plan-badge-mtr">${t("MTR")}</span>`);
  }
  const viaLabels = p.via_labels?.length
    ? p.via_labels
    : p.via_label
      ? [p.via_label]
      : [];
  for (const place of viaLabels) {
    badges.push(
      `<span class="plan-badge plan-badge-via">${escapeHtml(
        t("Meet at {place}", { place }),
      )}</span>`,
    );
  }
  const aelPromo = aelPromoForPlan(
    p,
    opts.originPt ?? origin,
    opts.destPt ?? destination,
  );
  if (aelPromo?.kind === "airport") {
    badges.push(
      `<span class="plan-badge plan-badge-ael" title="Same-day free return on Airport Express">AEL free return</span>`,
    );
  } else if (aelPromo?.kind === "awe") {
    badges.push(
      `<span class="plan-badge plan-badge-ael" title="AsiaWorld-Expo same-day return offer">AWE same-day</span>`,
    );
  }
  const departClock = formatServiceClock(p.start_time);
  const isPinned = pinState ?? isPlanPinned(p);
  return `<article class="plan-card${!pinned && idx === 0 ? " active" : ""}" data-idx="${idx}"${pinned ? ` data-pinned-plan="${escapeHtml(planKey)}"` : ""} role="button" tabindex="0" aria-label="Plan ${idx + 1}">
    <div class="plan-head">
      <span class="duration" title="Leave ${escapeHtml(departClock)} (UTC+8)">${escapeHtml(departClock)} · ${escapeHtml(formatDuration(p.duration_seconds))}</span>
      <span class="plan-fare" title="${escapeHtml(fareTitle || formatFareTypeLabel())}">${escapeHtml(fareText)}</span>
    </div>
    <div class="plan-meta-row">
      <span class="plan-transfers">${escapeHtml(transferLabel(p))} · ${escapeHtml(walkLabel(walkM))}</span>
      <span class="plan-badges">${badges.join("")}</span>
    </div>
    ${timeline}
    ${aelPromo ? aelPromo.html : ""}
    ${
      fare.parts?.length &&
      !(leastFareOn && idx === 0 && fare.incomplete)
        ? `<ul class="fare-parts">${fare.parts
            .map((part) => {
              const paid = formatFarePartAmount(part);
              const adultNote =
                part.adult_amount != null &&
                part.amount != null &&
                part.adult_amount !== part.amount
                  ? ` <span class="fare-adult-note">(adult $${Number(part.adult_amount).toFixed(1)})</span>`
                  : "";
              return `<li>${escapeHtml(part.label)}: <strong>${escapeHtml(paid)}</strong>${adultNote}</li>`;
            })
            .join("")}${
            fare.incomplete
              ? `<li class="fare-note">+ some legs N/A (missing fare data)</li>`
              : ""
          }</ul>`
        : leastFareOn && idx === 0 && fare.incomplete
          ? `<p class="fare-note">Fare incomplete — not used for least-fare ranking</p>`
          : ""
    }
    <div class="plan-actions">
      <button type="button" class="plan-detail-btn" ${pinned ? `data-pin-plan-detail="${escapeHtml(planKey)}"` : `data-detail-idx="${idx}"`}>
        <span class="material-symbols-outlined" aria-hidden="true">list_alt</span>
        ${escapeHtml(t("Show detail"))}
      </button>
      <button type="button" class="plan-pin-btn${isPinned ? " is-pinned" : ""}" ${pinned ? `data-pin-plan-unpin="${escapeHtml(planKey)}"` : `data-plan-pin="${idx}"`} title="${escapeHtml(isPinned ? t("Unpin plan") : t("Pin plan"))}">
        <span class="material-symbols-outlined" aria-hidden="true">${isPinned ? "keep_off" : "push_pin"}</span>
        <span class="plan-pin-label">${escapeHtml(isPinned ? t("Unpin") : t("Pin"))}</span>
      </button>
    </div>
  </article>`;
}

/** Update a plan pin button after a toggle (icon + label + state). */
function setPlanPinButton(btn, pinned) {
  btn.classList.toggle("is-pinned", pinned);
  btn.title = pinned ? t("Unpin plan") : t("Pin plan");
  const icon = btn.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = pinned ? "keep_off" : "push_pin";
  const label = btn.querySelector(".plan-pin-label");
  if (label) label.textContent = pinned ? t("Unpin") : t("Pin");
}


/**
 * Sheet title follows the current page/mode; while the ETA search pill is
 * open the Nearby browse title reads “Search” instead.
 */
function syncDetailTitle() {
  if (!els.detailTitle) return;
  const searchOpen = Boolean(
    els.appNavSearchWrap?.classList.contains("is-open") ||
      els.appBottomNav?.classList.contains("is-search-open"),
  );
  if (sidebarPage === "trip") {
    els.detailTitle.textContent = t("Trip detail");
  } else if (sidebarPage === "eta-route") {
    els.detailTitle.textContent = t("Route detail");
  } else if (sidebarPage === "pinned") {
    els.detailTitle.textContent = t("Pinned");
  } else if (sidebarPage === "settings") {
    els.detailTitle.textContent = t("Settings");
  } else if (sidebarPage === "about") {
    els.detailTitle.textContent = t("About");
  } else {
    const mode = getUiMode();
    els.detailTitle.textContent =
      mode === "eta" ? (searchOpen ? t("Search") : t("Nearby")) : t("Trip Plan");
  }
}

/**
 * Sidebar navigation: search ↔ trip / route / pinned / settings / about.
 * @param {"search"|"trip"|"eta-route"|"pinned"|"settings"|"about"} page
 */
function setSidebarPage(page) {
  if (page === "trip") sidebarPage = "trip";
  else if (page === "eta-route") sidebarPage = "eta-route";
  else if (page === "pinned") sidebarPage = "pinned";
  else if (page === "settings") sidebarPage = "settings";
  else if (page === "about") sidebarPage = "about";
  else sidebarPage = "search";

  // Pinned cards' live observer only runs while that page is open
  if (page !== "pinned") teardownPinnedCardLiveObserver();

  if (els.sidebarPageSearch) {
    els.sidebarPageSearch.hidden = sidebarPage !== "search";
  }
  if (els.sidebarPageTrip) {
    els.sidebarPageTrip.hidden = sidebarPage !== "trip";
  }
  if (els.sidebarPageEtaRoute) {
    els.sidebarPageEtaRoute.hidden = sidebarPage !== "eta-route";
  }
  if (els.sidebarPagePinned) {
    els.sidebarPagePinned.hidden = sidebarPage !== "pinned";
  }
  if (els.sidebarPageSettings) {
    els.sidebarPageSettings.hidden = sidebarPage !== "settings";
  }
  if (els.sidebarPageAbout) {
    els.sidebarPageAbout.hidden = sidebarPage !== "about";
  }
  syncDetailTitle();
  // Don't force full sheet — user may need map route shape visible
  if (
    sidebarPage === "trip" ||
    sidebarPage === "eta-route" ||
    sidebarPage === "pinned" ||
    sidebarPage === "settings" ||
    sidebarPage === "about"
  ) {
    setDetailOpen(true);
  }
  // Map route number overlay (Wheels-style) only on route detail
  if (sidebarPage !== "eta-route") {
    clearMapRouteBadge();
  }
  // Map brand logo shares the badge's bottom-left slot — hide on route detail
  if (els.mapBrandLogo) els.mapBrandLogo.hidden = sidebarPage === "eta-route";
  if (
    (sidebarPage === "trip" ||
      sidebarPage === "eta-route" ||
      sidebarPage === "pinned" ||
      sidebarPage === "settings" ||
      sidebarPage === "about") &&
    els.panel
  ) {
    const body = els.panel.querySelector(".detail-sidebar-body");
    if (body) body.scrollTop = 0;
  }
  // Route detail: Back + Pin replace main app nav in the bottom stack.
  // Trip detail / Settings / About: single dock Back, same chrome.
  // Pinned is a primary tab — keeps the app nav, no back button.
  const detailChrome = els.etaRouteDetailChrome;
  const onRouteDetail = sidebarPage === "eta-route";
  if (detailChrome) {
    detailChrome.hidden = !onRouteDetail;
  }
  if (onRouteDetail) syncEtaRouteBackChrome();
  const subpageChrome = els.subpageDetailChrome;
  const onSubPage =
    sidebarPage === "trip" ||
    sidebarPage === "settings" ||
    sidebarPage === "about";
  if (subpageChrome) {
    subpageChrome.hidden = !onSubPage;
  }
  if (els.subpageBackLabel) {
    els.subpageBackLabel.textContent =
      sidebarPage === "trip" ? "Back to plans" : "Back";
  }
  // Pin shows only on the trip detail page (settings/about have no plan)
  if (els.btnSubpagePin) {
    els.btnSubpagePin.hidden = sidebarPage !== "trip";
  }
  updateSubpagePinButton();
  if (els.appBottomNav) {
    // CSS also hides via :has(); keep in sync for older engines
    els.appBottomNav.style.display =
      onRouteDetail || onSubPage ? "none" : "";
  }
  if (typeof syncAppNavActive === "function") syncAppNavActive();
  // Dock height changes (filters ↔ Back/Pin) — remeasure fixed dock offset
  try {
    if (
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: 640px)").matches
    ) {
      requestAnimationFrame(() => {
        measureNavDockH();
        const snaps = sheetSnapHeights();
        const cur = els.app?.dataset?.sheet || "open";
        const px =
          cur === "closed"
            ? snaps.closed
            : cur === "full"
              ? snaps.full
              : snaps.open;
        document.documentElement.style.setProperty("--sheet-h", `${px}px`);
      });
    }
  } catch {
    /* ignore */
  }
  // Title-bar fade state follows the new page's scroll offset
  syncTopFade();
}

/**
 * Build trip-detail header HTML (OD, duration, live arrive, fare).
 * @param {object} plan
 * @param {{ arriveMs?: number | null, usedLive?: boolean }} [live]
 */
function tripDetailHeadHtml(plan, live = {}) {
  const from =
    plan.fromLabel ||
    origin?.label ||
    origin?.name ||
    (origin ? fmtCoord(origin.lat, origin.lon) : "Origin");
  const to =
    plan.toLabel ||
    destination?.label ||
    destination?.name ||
    (destination ? fmtCoord(destination.lat, destination.lon) : "Destination");
  const viaLabels = plan.via_labels?.length
    ? plan.via_labels
    : plan.via_label
      ? [plan.via_label]
      : vias.map((v) => v.point?.label).filter(Boolean);
  const fare = plan.fare || estimatePlanFare(plan, getFareType());
  const fareText = formatPlanFare(fare);
  const aelPromo = aelPromoForPlan(plan, origin, destination);

  const leaveClock = formatServiceClock(plan.start_time);
  let arriveHtml = "";
  if (live.arriveMs != null && Number.isFinite(live.arriveMs)) {
    const clock = formatHkClock(live.arriveMs);
    const tag = live.usedLive ? "Live est." : "Est.";
    arriveHtml = `<span class="trip-arrive" title="Estimated arrival (Hong Kong time)"><span class="trip-arrive-label">${tag} arrive</span> <strong>${escapeHtml(clock)}</strong></span>`;
  } else {
    // Scheduled arrival from plan start_time + duration (service clock face)
    const start = plan.start_time ? Date.parse(plan.start_time) : NaN;
    if (Number.isFinite(start) && plan.duration_seconds != null) {
      // start_time is service-day face with Z — display clock + duration offset in HH:MM
      const [hh, mm] = (formatServiceClock(plan.start_time) || "00:00")
        .split(":")
        .map(Number);
      const totalMin = hh * 60 + mm + Math.round(plan.duration_seconds / 60);
      const ah = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
      const am = String(totalMin % 60).padStart(2, "0");
      arriveHtml = `<span class="trip-arrive" title="Scheduled arrival (service timetable)"><span class="trip-arrive-label">Arrive</span> <strong>${ah}:${am}</strong></span>`;
    }
  }

  return `
      <div class="trip-detail-od">
        <span class="trip-od-from">${escapeHtml(from)}</span>
        <span class="material-symbols-outlined trip-od-arrow" aria-hidden="true">arrow_downward</span>
        ${viaLabels
          .map(
            (place) => `<span class="trip-od-via">${escapeHtml(t("Meet at {place}", { place }))}</span>
        <span class="material-symbols-outlined trip-od-arrow" aria-hidden="true">arrow_downward</span>`,
          )
          .join("")}
        <span class="trip-od-to">${escapeHtml(to)}</span>
      </div>
      <div class="trip-detail-meta">
        <span class="duration" title="Leave ${escapeHtml(leaveClock)} (UTC+8)">${escapeHtml(leaveClock)} · ${escapeHtml(formatDuration(plan.duration_seconds))}</span>
        ${arriveHtml}
        <span class="plan-fare">${escapeHtml(fareText)}</span>
        <span class="plan-transfers">${escapeHtml(transferLabel(plan))} · ${escapeHtml(walkLabel(plan.walk_meters))}</span>
      </div>
      <p class="trip-eta-status" data-eta-status>Live ETAs · updating…</p>
      ${aelPromo ? aelPromo.html : ""}
      ${
        fare.parts?.length
          ? `<ul class="fare-parts">${fare.parts
              .map((part) => {
                const paid = formatFarePartAmount(part);
                return `<li>${escapeHtml(part.label)}: <strong>${escapeHtml(paid)}</strong></li>`;
              })
              .join("")}${
              fare.incomplete
                ? `<li class="fare-note">+ some legs N/A (missing fare data)</li>`
                : ""
            }</ul>`
          : ""
      }
      <h3 class="results-section-title">Full Trip Route</h3>`;
}

/**
 * Paint BOARD/PASS BY/ALIGHT clocks + live ETA panels from open-data.
 * @param {object} plan
 * @param {Map<number, import("./eta.js").LegEtaResult>} etaMap
 */
function applyTripDetailEtaDom(plan, etaMap) {
  const root = els.tripDetailTimeline;
  if (!root) return;

  const { byLeg } = buildPlanStopTimes(plan, etaMap);

  // Role lines: "BOARD - 18:16"
  root.querySelectorAll(".rt-stop-time[data-eta-leg]").forEach((el) => {
    const legIdx = Number(el.getAttribute("data-eta-leg"));
    const stopIdx = Number(el.getAttribute("data-eta-stop"));
    const role = el.getAttribute("data-eta-role") || "";
    const points = byLeg.get(legIdx);
    const pt = points?.find((p) => p.stopIndex === stopIdx) || points?.[stopIdx];
    const clockEl = el.querySelector(".rt-stop-clock");
    const roleLabel =
      role === "board" ? "BOARD" : role === "alight" ? "ALIGHT" : "PASS BY";
    if (pt?.clock) {
      if (clockEl) clockEl.textContent = pt.clock;
      else el.textContent = `${roleLabel} - ${pt.clock}`;
      el.classList.add("has-time");
      el.title = `${roleLabel} ${pt.clock} (Hong Kong)`;
    } else {
      if (clockEl) clockEl.textContent = "--:--";
      el.classList.remove("has-time");
    }
  });

  // Board stop title: "Tung Chung - Platform 1/2" for rail only (not bus/GMB)
  root.querySelectorAll("[data-eta-board-name-leg]").forEach((el) => {
    const legIdx = Number(el.getAttribute("data-eta-board-name-leg"));
    const base =
      el.getAttribute("data-eta-board-base") ||
      stationBaseName(el.textContent || "") ||
      el.textContent ||
      "";
    const eta = etaMap?.get(legIdx);
    const plats = eta?.servingPlatforms || [];
    const showPlat = etaOperatorShowsPlatform(eta?.operator);
    if (plats.length && showPlat) {
      el.textContent = stationNameWithPlatforms(base, plats);
      el.title =
        plats.length > 1
          ? `Platforms ${plats.join(" & ")} serve this direction`
          : `Platform ${plats[0]}`;
    }
  });

  // Board ETA panel — Wheels big-slot style (live first, then timetable fill)
  root.querySelectorAll("[data-eta-card-leg]").forEach((card) => {
    const legIdx = Number(card.getAttribute("data-eta-card-leg"));
    const eta = etaMap?.get(legIdx);
    const slotsEl = card.querySelector("[data-eta-card-slots]");
    const boardEl = card.querySelector("[data-eta-card-board]");
    const updatedEl = card.querySelector("[data-eta-updated]");
    if (!slotsEl) return;

    const opt = plan?.legs?.[legIdx]?.route_options?.[0] || {};
    const operator = eta?.operator || etaOperator(opt);
    const raw = Array.isArray(eta?.etas) ? eta.etas : [];
    let liveSlots = raw.filter((s) => !s?.scheduled);
    let schedSlots = raw.filter((s) => s?.scheduled);

    // Ensure timetable pool has up to 2 (plan headway expand)
    if (schedSlots.length < 2) {
      const planSched = scheduledSlotsFromPlanLeg(opt, plan, legIdx, 2);
      if (planSched.length) {
        schedSlots = mergeLiveWithTimetable(schedSlots, planSched, 2);
      }
    }
    if (!schedSlots.length && liveSlots.length && liveSlots.length < 2) {
      const hw = defaultHeadwayMins(opt, operator);
      const last = liveSlots[liveSlots.length - 1];
      schedSlots = expandTimetableSlots(
        {
          waitMins: (last.waitMins ?? 0) + hw,
          dest: last.dest || "",
          scheduled: true,
        },
        { count: 2, headwayMins: hw, dest: last.dest || "" },
      );
    }

    const slots = mergeLiveWithTimetable(liveSlots, schedSlots, 2);
    const { html } = wheelsEtaSlotsHtml(
      {
        ...(eta || {}),
        etas: slots,
        operator,
        outsideService: !!eta?.outsideService,
      },
      {
        kind:
          operator === "mtr" ? "mtr" : operator === "lrt" ? "lrt" : "",
      },
    );
    slotsEl.innerHTML = html;

    // Board line inside the panel: station name + platform for rail (MTR / LRT)
    if (boardEl) {
      const stopNameEl = card
        .closest(".rt-step")
        ?.querySelector("[data-eta-board-name-leg]");
      const base =
        stopNameEl?.getAttribute("data-eta-board-base") ||
        stopNameEl?.textContent ||
        "";
      const plats = eta?.servingPlatforms || [];
      if (base && plats.length && etaOperatorShowsPlatform(operator)) {
        boardEl.textContent = stationNameWithPlatforms(base, plats);
        boardEl.title =
          plats.length > 1
            ? `Platforms ${plats.join(" & ")} serve this direction`
            : `Platform ${plats[0]}`;
      } else {
        boardEl.textContent = base;
      }
      boardEl.hidden = !boardEl.textContent.trim();
    }
    // Last-update chip (ticks via the global [data-eta-updated] timer)
    if (updatedEl) {
      const t = eta?.fetchedAt || null;
      updatedEl.dataset.fetchedAt = Number.isFinite(t) ? String(t) : "";
      updatedEl.textContent = formatUpdatedAgo(t, Date.now());
    }
  });
}

function stopTripEtaPolling() {
  if (tripEtaPollTimer != null) {
    clearInterval(tripEtaPollTimer);
    tripEtaPollTimer = null;
  }
}

/**
 * Fetch board ETAs + update arrive estimate. Safe to call repeatedly.
 * @param {number} [gen]
 */
async function refreshTripDetailEtas(gen) {
  const plan = tripDetailPlan();
  if (!plan || sidebarPage !== "trip") return;
  const myGen = gen ?? tripEtaGen;
  const statusEl = els.tripDetailHead?.querySelector?.("[data-eta-status]");

  try {
    if (document.visibilityState === "hidden") return;
    const etaMap = await fetchPlanBoardEtas(plan);
    if (myGen !== tripEtaGen || tripDetailPlan() !== plan) return;
    tripDetailEtas = etaMap;
    applyTripDetailEtaDom(plan, etaMap);

    const { arriveMs, usedLive } = buildPlanStopTimes(plan, etaMap);
    if (els.tripDetailHead) {
      // Update only arrive chip + status to avoid wiping fare promo mid-click
      let arriveEl = els.tripDetailHead.querySelector(".trip-arrive");
      const clock = formatHkClock(arriveMs);
      const tag = usedLive ? t("Live est. arrive") : t("Est. arrive");
      const html = `<span class="trip-arrive-label">${escapeHtml(tag)}</span> <strong>${escapeHtml(clock)}</strong>`;
      if (arriveEl) {
        arriveEl.innerHTML = html;
        arriveEl.title = t("Estimated arrival (Hong Kong time)");
      } else {
        const meta = els.tripDetailHead.querySelector(".trip-detail-meta");
        if (meta) {
          const span = document.createElement("span");
          span.className = "trip-arrive";
          span.title = t("Estimated arrival (Hong Kong time)");
          span.innerHTML = html;
          const dur = meta.querySelector(".duration");
          if (dur?.nextSibling) meta.insertBefore(span, dur.nextSibling);
          else meta.appendChild(span);
        }
      }
    }
    if (statusEl) {
      const vals = [...etaMap.values()];
      const liveN = vals.filter((e) => hasLiveEtaSlots(e)).length;
      const schedN = vals.filter((e) => e?.scheduled && !hasLiveEtaSlots(e)).length;
      const total = etaMap.size;
      const t = formatHkClock(Date.now());
      if (total === 0) {
        statusEl.textContent = t("No transit legs for ETA");
      } else if (liveN > 0 && schedN > 0) {
        statusEl.textContent = t("Live {liveN} · Scheduled {schedN} · {total} routes · {t}", { liveN, schedN, total, t });
      } else if (liveN > 0) {
        statusEl.textContent = t("Live ETAs · {liveN}/{total} routes · {t} · refreshes every 1 min", { liveN, total, t });
      } else if (schedN > 0) {
        statusEl.textContent = t("Timetable · {schedN}/{total} routes · {t}", { schedN, total, t });
      } else {
        statusEl.textContent = t("ETA unavailable · checked {t}", { t });
      }
    }
  } catch (err) {
    console.warn("[eta] trip detail", err);
    if (statusEl && myGen === tripEtaGen) {
      statusEl.textContent = t("Live ETAs failed — will retry");
    }
  }
}

function startTripEtaPolling() {
  stopTripEtaPolling();
  const gen = ++tripEtaGen;
  // Immediate fetch, then every 1 minute while detail is open + visible
  void refreshTripDetailEtas(gen);
  tripEtaPollTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (sidebarPage !== "trip" || tripDetailIdx == null) return;
    void refreshTripDetailEtas(tripEtaGen);
  }, 60_000);
}

/**
 * Open full stop-by-stop itinerary as a sidebar page.
 * @param {number | object} idxOrPlan plan index in `plans`, or the plan object itself (pinned trips)
 * @param {object} [planOverride]
 */
async function openTripDetailPage(idxOrPlan, planOverride) {
  const raw =
    planOverride ||
    (typeof idxOrPlan === "number" ? plans[idxOrPlan] : idxOrPlan);
  if (!raw) return;
  const plan = await localizedPlanCopy(raw);
  tripDetailIdx = plan;
  tripDetailEtas = null;
  if (typeof idxOrPlan === "number" && !planOverride) {
    tripDetailMarkersArePreview = false;
    selectPlan(idxOrPlan);
    if (getUiMode() === "route") showFormEndpointMarkers();
  } else {
    tripDetailMarkersArePreview = true;
    selectPlan(plan, plan);
    showPreviewEndpointMarkers(endpointsFromPlan(plan));
  }

  if (els.tripDetailHead) {
    els.tripDetailHead.innerHTML = tripDetailHeadHtml(plan);
  }
  if (els.tripDetailTimeline) {
    els.tripDetailTimeline.innerHTML = planRouteLineHtml(plan.legs || [], {
      fullStops: true,
      liveEta: true,
      hideDestWalk: true,
    });
  }
  // “Show route details” per leg → Route Detail pre-selected at the leg's
  // board stop (bound here, after the timeline HTML is (re)built)
  els.tripDetailTimeline
    ?.querySelectorAll("[data-eta-route-details]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const legIdx = Number(btn.getAttribute("data-eta-route-details"));
        void openRouteDetailsFromTripLeg(legIdx);
      });
    });
  setSidebarPage("trip");
  startTripEtaPolling();
}

/**
 * Bound for a plan leg's first route option (KMB trip_id like
 * KMB-E31-I-1-287 → "I"); empty when the planner didn't encode one.
 * @param {object} opt
 * @returns {string}
 */
function planLegBoundDir(opt) {
  const m = /-(I|O)-\d+(?:-|$)/i.exec(String(opt?.trip_id || ""));
  return m ? m[1].toUpperCase() : "";
}

/**
 * Plan leg → ETA route entry for the trip-detail “Show route details” button.
 * Synchronous on purpose: direction tables (KMB/CTB bounds…) load async in
 * the open handler; the board stop is carried as pinned-stop fields so the
 * detail page pre-selects it (stopId/stopName, never stopIndex — plan stop
 * indexes don't match operator stop lists).
 * @param {object} plan
 * @param {number} legIdx
 * @returns {EtaRouteEntry | null} null when the leg has no route-details page
 */
function etaRouteEntryFromPlanLeg(plan, legIdx) {
  const opt = plan?.legs?.[legIdx]?.route_options?.[0];
  if (!opt) return null;
  const op = etaOperator(opt);
  let kind = "bus";
  let co = "";
  if (op === "mtr") {
    kind = "mtr";
  } else if (op === "lrt") {
    kind = "lrt";
  } else if (op === "mtr_bus") {
    kind = "mtr_bus";
    co = "lrtfeeder";
  } else if (op === "kmb" || op === "ctb" || op === "nlb" || op === "gmb") {
    kind = "bus";
    co = op;
  } else {
    return null; // ferry / unknown — no route detail page
  }
  // MTR legs: line code (TCL/TWL/…) so catalog + stop sequence resolve
  let id = "";
  if (kind === "mtr") {
    id = detectMtrLineCode(opt) || "";
  }
  if (!id) {
    id = String(
      opt.route_short_name || opt.route_name || opt.route_id || "",
    )
      .trim()
      .toUpperCase();
  }
  if (!id) return null;
  // Board stop id formats per operator so resolveCircularBoardIndex matches
  const boardStop = opt.stops?.[0] || opt.from || null;
  let stopId = String(boardStop?.stop_id || boardStop?.id || "");
  if (stopId) {
    if (kind === "mtr") {
      // MTR-PLATFORM-TUC-1 / MTR-TUC → MTR-TUC (named stops use MTR-<CODE>)
      const m = /MTR-(?:PLATFORM-)?([A-Z]{3})(?:-|$)/i.exec(stopId);
      if (m) stopId = `MTR-${m[1]}`;
    } else if (co !== "ctb") {
      // KMB/NLB/GMB/LRT plan ids are operator-prefixed; CTB ids are raw sids
      stopId = stripOperatorStopId(stopId);
    }
  }
  return {
    id,
    label:
      String(opt.route_long_name || opt.route_name || id || "").trim() || id,
    kind,
    co,
    stopId,
    stopName: String(boardStop?.stop_name || boardStop?.name || "").trim(),
    bound: planLegBoundDir(opt),
  };
}

/**
 * “Show route details” from a trip-detail ETA panel → Route Detail page with
 * the leg's board stop pre-selected (same restore path as pinned stops).
 * @param {number} legIdx
 */
async function openRouteDetailsFromTripLeg(legIdx) {
  const plan = tripDetailPlan();
  const route = etaRouteEntryFromPlanLeg(plan, legIdx);
  if (!route) {
    showToast(t("No route details for this leg"), 1800);
    return;
  }
  const op = etaOperator(plan?.legs?.[legIdx]?.route_options?.[0]);
  // Adopt catalog co so LWB routes resolve under their own operator
  if (!etaRouteCatalog.length) buildEtaRouteCatalog();
  const coCandidates = [route.co, ...(op === "kmb" ? ["lwb"] : [])].filter(
    Boolean,
  );
  const cat =
    etaRouteCatalog.find(
      (r) =>
        r.id === route.id &&
        r.kind === route.kind &&
        coCandidates.includes(String(r.co || "").toLowerCase()),
    ) || null;
  if (cat) route.co = cat.co || route.co;

  try {
    const co = String(route.co || "").toLowerCase();
    if (co === "ctb") await ensureCtbRouteBound(route.id);
    if (co === "nlb") await ensureNlbRouteBounds();
    if (co === "gmb") await ensureGmbRouteDirections(route.id);
    if (route.kind === "bus") await ensureKmbRouteBounds();
    if (route.kind === "mtr_bus" || co === "lrtfeeder" || co === "mtrbus") {
      await ensureMtrBusData();
    }
    if (route.kind === "lrt") await ensureLrtRouteData();
    if (route.kind === "mtr") await ensureMtrStationLinesMap();
  } catch (e) {
    console.warn("[eta] trip leg dirs", e);
  }

  const dirs = etaRouteDirections(route, { full: true });
  if (!dirs.length) {
    showToast(t("No route details for this leg"), 1800);
    return;
  }
  // Prefer the planner's bound (trip_id), else the stored card dir, else first
  let di = getCardDir(route);
  if (route.bound) {
    const byBound = dirs.findIndex(
      (d) =>
        String(d.bound || "").toUpperCase() ===
        String(route.bound).toUpperCase(),
    );
    if (byBound >= 0) di = byBound;
  }
  di = Math.min(Math.max(0, di), Math.max(0, dirs.length - 1));
  setCardDir(route, di);
  const dir = dirs[di] || dirs[0];

  // Seed live meta with the trip's board stop — showEtaRouteDetailsPanel
  // pre-selects it via resolveCircularBoardIndex (stopId → stopName chain)
  const key = etaRouteKey(route);
  const prev = etaLiveByKey.get(key) || {};
  etaLiveByKey.set(key, {
    ...prev,
    stopId: route.stopId || prev.stopId,
    stopLabel: route.stopName || prev.stopLabel,
    bound: route.bound || dir.bound || prev.bound,
  });
  etaDetailStopIndex = 0;

  etaSelectedForDetails = route;
  etaSelectedStops = [];
  ++etaShapeGen;
  clearRouteGeometry();
  setDetailOpen(true);
  syncEtaActive();
  if (els.etaRouteActions) els.etaRouteActions.hidden = true;
  syncPinnedRouteToolbar();
  const oldPanel = document.getElementById("eta-route-details-panel");
  if (oldPanel) oldPanel.remove();
  etaRouteReturnTrip = plan;
  void showEtaRouteDetailsPanel({ fromTrip: true });
}

function syncEtaRouteBackChrome() {
  const btn = els.btnEtaRouteBack;
  if (!btn) return;
  const label = etaRouteReturnTrip ? t("Back to trip") : t("Back to search");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function closeTripDetailPage() {
  const refreshCards = typeof tripDetailIdx === "number" && plans.length > 0;
  const wasPreview = tripDetailMarkersArePreview;
  stopTripEtaPolling();
  tripDetailIdx = null;
  tripDetailEtas = null;
  tripEtaGen += 1;
  tripDetailMarkersArePreview = false;
  etaRouteReturnTrip = null;
  setSidebarPage("search");
  if (wasPreview) {
    clearTripEndpointMarkers();
    if (getUiMode() === "route") showFormEndpointMarkers();
  }
  // Pin state may have changed on the trip detail page — refresh live cards
  if (refreshCards) renderPlans(plans, 0);
}

/** Abort in-flight geometry densify when user picks another plan. */
let selectPlanAbort = null;
let selectPlanGen = 0;
/** Last painted route GeoJSON (for contribute-path “From plan”). */
let lastRouteGeo = null;

/** Plan open on the trip detail page (number = index in `plans`, object = pinned). */
function tripDetailPlan() {
  if (tripDetailIdx == null) return null;
  return typeof tripDetailIdx === "number"
    ? plans[tripDetailIdx]
    : tripDetailIdx;
}

/** Keep the dock Pin button in sync with the plan on the trip detail page. */
function updateSubpagePinButton() {
  const btn = els.btnSubpagePin;
  if (!btn) return;
  const plan = tripDetailPlan();
  const pinned = !!plan && isPlanPinned(plan);
  btn.classList.toggle("is-pinned", pinned);
  const icon = btn.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = pinned ? "keep_off" : "push_pin";
  const label =
    els.subpagePinLabel || btn.querySelector(".eta-detail-chrome-label");
  if (label) label.textContent = pinned ? t("Unpin") : t("Pin");
  const title = pinned ? t("Unpin this trip") : t("Pin this trip");
  btn.title = title;
  btn.setAttribute("aria-label", title);
}

async function selectPlan(idx, planOverride) {
  const plan = planOverride || plans[idx];
  if (!plan) return;
  els.planResults.querySelectorAll(".plan-card").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
  });
  ensureRouteLayers();

  // Wait for densified geometry before painting — no stop-chord skeleton flash
  const gen = ++selectPlanGen;
  if (selectPlanAbort) selectPlanAbort.abort();
  selectPlanAbort = new AbortController();
  const signal = selectPlanAbort.signal;

  setMapRouteLoading(true, "Drawing route…");
  // Drop previous route so only the finished path appears
  clearRouteGeometry();

  try {
    try {
      await loadMtrGeo();
    } catch {
      /* offline / optional */
    }

    // Frame the corridor while blurred (sync chords for bounds only — not painted)
    const skeleton = geometryFromPlanSync(plan);
    fitRouteBounds(skeleton);

    const geo = await geometryFromPlan(plan, { signal });
    if (gen !== selectPlanGen || signal.aborted) return;

    // Paint densified line + markers together, then lift the veil
    lastRouteGeo = geo;
    map.getSource("route-line")?.setData(geo);
    setRouteStops(plan, geo);
    fitRouteBounds(geo);

    // Brief beat so the line is on-screen before unblur
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (gen !== selectPlanGen) return;
    setMapRouteLoading(false);
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.warn("[selectPlan] geometry", err);
    // Fallback: show stop-chord path if densify fails
    if (gen === selectPlanGen) {
      try {
        const fallback = geometryFromPlanSync(plan);
        lastRouteGeo = fallback;
        map.getSource("route-line")?.setData(fallback);
        setRouteStops(plan, fallback);
        fitRouteBounds(fallback);
      } catch {
        /* ignore */
      }
      setMapRouteLoading(false);
    }
  }
}

/** Sync fallback: walk paths + straight stop chords (no OSRM densify). */
function geometryFromPlanSync(plan) {
  const features = [];
  const legs = plan.legs || [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.type === "walk") {
      // Match async walkFeatureForLeg policy (no await here):
      // access/egress → straight; transfer / walk-only → path if any.
      const prev = adjacentTransitLeg(legs, i, -1);
      const next = adjacentTransitLeg(legs, i, 1);
      const prevOpt = prev?.leg?.route_options?.[0] || null;
      const nextOpt = next?.leg?.route_options?.[0] || null;
      const a =
        transitEndpointCoord(prevOpt, "alight") ||
        stopCoord(leg.from) ||
        (leg.path?.[0] ? [leg.path[0].lon, leg.path[0].lat] : null);
      const b =
        transitEndpointCoord(nextOpt, "board") ||
        stopCoord(leg.to) ||
        (leg.path?.length
          ? [
              leg.path[leg.path.length - 1].lon,
              leg.path[leg.path.length - 1].lat,
            ]
          : null);
      const useDetail = walkUsesDetailedPath(leg, i, legs);
      let coords = null;
      if (useDetail && Array.isArray(leg.path) && leg.path.length >= 2) {
        coords = leg.path.map((p) => [p.lon, p.lat]);
        if (a) coords[0] = a;
        if (b) coords[coords.length - 1] = b;
      } else if (a && b) {
        coords = [a, b];
      }
      if (coords?.length >= 2) {
        features.push({
          type: "Feature",
          properties: {
            kind: "walk",
            walk_style: "street",
            walk_type: leg.walk_type || "",
          },
          geometry: { type: "LineString", coordinates: coords },
        });
      }
    } else if (leg.type === "transit" && leg.route_options?.[0]) {
      const opt = leg.route_options[0];
      const stops = isRailOption(opt)
        ? railStopsForGeometry(opt)
        : opt.stops?.length
          ? opt.stops
          : [opt.from, opt.to].filter(Boolean);
      const coords = stops
        .map((s) => {
          const lon = s.location?.lon ?? s.lon;
          const lat = s.location?.lat ?? s.lat;
          return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
        })
        .filter(Boolean);
      if (coords.length >= 2) {
        features.push({
          type: "Feature",
          properties: {
            kind: "transit",
            leg_index: i,
            color: routeColorCss(opt) || "#c0aefc",
            name: opt.route_short_name || opt.route_name,
          },
          geometry: { type: "LineString", coordinates: coords },
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
}

function fitRouteBounds(geo) {
  const bounds = new LngLatBounds();
  let any = false;
  for (const f of geo.features || []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString") {
      for (const c of g.coordinates) {
        bounds.extend(c);
        any = true;
      }
    }
  }
  if (origin) {
    bounds.extend([origin.lon, origin.lat]);
    any = true;
  }
  if (destination) {
    bounds.extend([destination.lon, destination.lat]);
    any = true;
  }
  if (any) {
    // A live locate lock would re-centre on the user at the next position
    // fix and undo this fit — drop it first (see disengageGeolocateFollow).
    disengageGeolocateFollow();
    map.fitBounds(bounds, {
      padding: netFitPadding(mapVisiblePadding({ top: 24, right: 24, bottom: 24, left: 24 })),
      maxZoom: 15,
      duration: 600,
    });
  }
}

// ── WASM router bootstrap ────────────────────────────────────────────────────
async function bootstrapRouter() {
  if (els.routerStatus) els.routerStatus.textContent = "Loading WASM router…";
  try {
    // Prefer edge (proxied in dev for COEP); falls back to local .gz inside initRouter
    const preferred = `${EDGE}/hk.wheelsrouter`;
    await initRouter(preferred);
    const stats = getRouterStats();
    // Quiet success — no “Ready · N stops” chip (status element stays visually hidden)
    if (els.routerStatus) {
      els.routerStatus.textContent = stats
        ? `Ready · ${stats.stops.toLocaleString()} stops · ${stats.routes.toLocaleString()} routes`
        : "Router ready";
    }
    console.info("[router] ready", stats);
    updatePlanButton();
  } catch (err) {
    console.error("[router]", err);
    if (els.routerStatus) {
      els.routerStatus.textContent = t("Router failed: {msg}", { msg: err.message || err });
    }
    // Surface failures only
    const chip = document.getElementById("map-status");
    if (chip) {
      chip.classList.remove("is-visually-hidden");
      chip.classList.add("is-error");
    }
    showToast(t("Router graph failed to load"), 5000);
  }
}

const routerReadyPromise = bootstrapRouter();

// Multi-type MTR fare tables (adult / student / child / QR / contactless)
/** @type {Promise<unknown>} */
const faresReadyPromise = initFares()
  .then(() => {
    buildEtaRouteCatalog();
    // Re-price any results that were planned before tables finished loading
    if (plans?.length) repricePlansForFareType();
  })
  .catch((err) => {
    console.warn("[fares]", err);
    buildEtaRouteCatalog(); // MTR/LRT hardcodes still available
    showToast(t("Fare tables unavailable — times still work"), 4000);
  });

// ── Metadata manifest ────────────────────────────────────────────────────────
async function loadManifest() {
  els.metaStatus.textContent = t("Checking edge metadata…");

  try {
    const res = await fetch(METADATA_URL, { cache: "no-cache" });
    if (res.ok) {
      const meta = await res.json();
      applyManifest(meta, "metadata.json");
      maybePromptDataUpdate(meta);
      return meta;
    }
    console.warn("[metadata] HTTP", res.status, "— falling back to HEAD probes");
  } catch (err) {
    console.warn("[metadata] fetch failed", err);
  }

  const [gtfs, pmtiles] = await Promise.all([
    headAsset(`${EDGE}/hk.gtfs.zip`),
    headAsset(`${EDGE}/hongkong.pmtiles`),
  ]);

  const fallback = {
    updated_at: null,
    gtfs: {
      filename: "hk.gtfs.zip",
      size_bytes: gtfs,
      url: `${DATA_BASE}/hk.gtfs.zip`,
    },
    pmtiles: {
      filename: "hongkong.pmtiles",
      size_bytes: pmtiles,
      url: `${DATA_BASE}/hongkong.pmtiles`,
    },
  };
  applyManifest(fallback, "HEAD probe (metadata.json not published yet)");
  return fallback;
}

async function headAsset(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-cache" });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

function applyManifest(meta, sourceLabel) {
  const updated = meta.updated_at
    ? `Updated ${formatTime(meta.updated_at)}`
    : "Update time unknown";
  els.metaStatus.textContent = `${updated} · via ${sourceLabel}`;

  const rows = [];
  if (meta.gtfs) {
    rows.push(["GTFS", meta.gtfs.filename, formatBytes(meta.gtfs.size_bytes)]);
    els.gtfsSize.textContent = formatBytes(meta.gtfs.size_bytes);
    els.btnGtfs.disabled = false;
    els.btnGtfs.dataset.url = meta.gtfs.url || `${DATA_BASE}/hk.gtfs.zip`;
    els.btnGtfs.dataset.filename = meta.gtfs.filename;
  }
  if (meta.pmtiles) {
    rows.push([
      "PMTiles",
      meta.pmtiles.filename,
      formatBytes(meta.pmtiles.size_bytes),
    ]);
    els.pmtilesSize.textContent = formatBytes(meta.pmtiles.size_bytes);
    els.btnPmtiles.disabled = false;
    els.btnPmtiles.dataset.url =
      meta.pmtiles.url || `${DATA_BASE}/hongkong.pmtiles`;
    els.btnPmtiles.dataset.filename = meta.pmtiles.filename;
  }
  if (meta.wheelsrouter || meta.graph) {
    const g = meta.wheelsrouter || meta.graph;
    rows.push(["Router", g.filename, formatBytes(g.size_bytes)]);
  }

  els.metaDetails.innerHTML = rows
    .map(
      ([k, name, size]) =>
        `<div><dt>${k}</dt><dd><code>${name}</code> · ${size}</dd></div>`,
    )
    .join("");
  els.metaDetails.hidden = rows.length === 0;
}

// ── UI wiring ────────────────────────────────────────────────────────────────
els.btnGtfs.addEventListener("click", () => {
  const { url, filename } = els.btnGtfs.dataset;
  if (url) triggerDownload(url, filename);
});

els.btnPmtiles.addEventListener("click", () => {
  const { url, filename } = els.btnPmtiles.dataset;
  if (url) triggerDownload(url, filename);
});

/** @returns {"eta"|"route"} */
function getUiMode() {
  const m = els.app?.dataset?.uiMode;
  return m === "route" ? "route" : "eta";
}

function resizeMapSoon() {
  requestAnimationFrame(() => {
    map.resize();
    requestAnimationFrame(() => map.resize());
  });
}

function setToolbarOpen(open) {
  if (!els.app) return;
  // Toolbar is always open (close control removed)
  els.app.dataset.toolbar = open ? "open" : "open";
  if (els.mainToolbar) {
    els.mainToolbar.setAttribute("aria-hidden", "false");
  }
  resizeMapSoon();
  setTimeout(() => resizeMapSoon(), 400);
}

/** Toolbar / sidebar width boost vs natural chrome content. */
const DOCK_WIDTH_SCALE = 1.05;
/**
 * Locked ideal dock width (px) shared by ETA + Trip Plan.
 * Survives viewport resize (only clamped to max). Cleared only on first layout.
 */
let dockLockedWidthPx = 0;

function dockPadPx() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--dock-pad")
    .trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

function dockViewportMaxWidth() {
  const pad = dockPadPx();
  return Math.max(200, Math.floor(window.innerWidth - 2 * pad));
}

/**
 * Clear any legacy fixed dock width — panel width is CSS fluid only.
 */
function clearDockWidthLock() {
  const dock = els.mainToolbar;
  dockLockedWidthPx = 0;
  if (!dock) return;
  dock.style.removeProperty("--dock-chrome-w");
  dock.style.removeProperty("width");
  dock.style.removeProperty("min-width");
  dock.style.removeProperty("max-width");
}

/** @deprecated no fixed lock; CSS handles panel width */
function applyDockWidth(_idealPx) {
  clearDockWidthLock();
}

/** @deprecated */
function measureDockChromeNatural() {
  return 0;
}

/**
 * Layout height for sheet snaps / full drawer.
 * Prefer window.innerHeight — it matches the fixed-position containing block
 * on iOS. visualViewport can be a few px shorter in standalone and must not
 * be used to shrink the app shell (that left a gap under the map while the
 * dock stayed at the true bottom).
 * @returns {number}
 */
function viewportHeightPx() {
  const ih = Math.round(window.innerHeight || 700);
  try {
    const vv = window.visualViewport?.height;
    if (vv && vv > 100) {
      const r = Math.round(vv);
      // Only trust VV when it agrees with layout height (keyboard closed).
      if (Math.abs(ih - r) <= 2) return r;
    }
  } catch {
    /* ignore */
  }
  return ih > 100 ? ih : 700;
}

/**
 * Measure fixed bottom dock height and publish --nav-dock-h.
 * Nav padding already includes safe-area — do not add it again.
 * @returns {number}
 */
function measureNavDockH() {
  const stack = document.getElementById("panel-bottom-stack");
  if (!stack) return 0;
  // Force layout so display:none filters on closed are reflected
  const h = Math.ceil(stack.getBoundingClientRect().height);
  if (h > 0) {
    document.documentElement.style.setProperty("--nav-dock-h", `${h}px`);
  }
  const nav = els.appBottomNav || document.getElementById("app-bottom-nav");
  if (nav) {
    const nh = Math.ceil(nav.getBoundingClientRect().height);
    if (nh >= 40 && nh <= 140) {
      document.documentElement.style.setProperty("--toolbar-h", `${nh}px`);
    }
  }
  // Publish real visual height for full-sheet calc (PWA-safe)
  try {
    document.documentElement.style.setProperty(
      "--vv-h",
      `${viewportHeightPx()}px`,
    );
    document.documentElement.classList.add("vv-ready");
  } catch {
    /* ignore */
  }
  return h;
}

/** iOS often applies safe-area a tick after first paint in standalone */
function schedulePwaDockRemeasure() {
  if (!isPwaStandalone && !isMobileUi) return;
  const run = () => {
    try {
      measureNavDockH();
      if (
        typeof matchMedia !== "undefined" &&
        matchMedia("(max-width: 640px)").matches
      ) {
        const cur = els.app?.dataset?.sheet || "open";
        // Refresh --sheet-h without fighting an in-progress drag
        if (!document.getElementById("main-toolbar")?.classList.contains(
          "is-sheet-dragging",
        )) {
          setSheetState(cur);
        }
      }
      try {
        map?.resize?.();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  };
  requestAnimationFrame(run);
  setTimeout(run, 50);
  setTimeout(run, 200);
  setTimeout(run, 600);
  // Late safe-area / status-bar settle on cold home-screen launch
  setTimeout(run, 1200);
}

/**
 * Panel width is not locked. Optionally sync nav height token.
 * @param {{ remount?: boolean }} [_opts]
 */
function syncDockChromeWidth(_opts = {}) {
  clearDockWidthLock();
  measureNavDockH();
}

// Viewport resize: remeasure dock + content sheet, resize map
let dockResizeTimer = null;
function onViewportChromeResize() {
  clearTimeout(dockResizeTimer);
  dockResizeTimer = setTimeout(() => {
    clearDockWidthLock();
    try {
      if (
        typeof matchMedia !== "undefined" &&
        matchMedia("(max-width: 640px)").matches
      ) {
        measureNavDockH();
        const cur = els.app?.dataset?.sheet || "open";
        setSheetState(cur);
      }
    } catch {
      /* ignore */
    }
    resizeMapSoon();
  }, 80);
}
window.addEventListener("resize", onViewportChromeResize);
try {
  window.visualViewport?.addEventListener("resize", onViewportChromeResize);
} catch {
  /* ignore */
}

/**
 * Content-sheet snap heights (px) — above fixed dock, not including nav.
 * @returns {{ closed: number, open: number, full: number, dock: number }}
 */
function sheetSnapHeights() {
  // Prefer visualViewport — on iOS PWA 100dvh can overshoot and leave a gap/band
  const vh = viewportHeightPx();
  const readCssLen = (name, fallbackPx) => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    if (!raw) return fallbackPx;
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;height:${raw}`;
    document.body.appendChild(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return h > 0 ? h : fallbackPx;
  };

  const dock = measureNavDockH() || readCssLen("--nav-dock-h", 80);
  let closed = 52;
  let chromeH = 52;
  try {
    // Content-only closed height = grabber + title (nav is fixed below)
    chromeH = els.sheetChrome?.getBoundingClientRect().height || 52;
    closed = Math.max(44, Math.round(chromeH));
  } catch {
    closed = readCssLen("--sheet-chrome-h", 52);
  }

  // Half: total drawer ≈ open CSS token; content = total − dock
  const openTotal = readCssLen(
    "--sheet-open-h",
    Math.min(vh * 0.58, vh - 80),
  );
  const open = Math.max(120, Math.round(openTotal - dock));
  // Full content fills viewport above dock
  const full = Math.max(open + 40, Math.round(vh - dock));

  return {
    closed: Math.round(closed),
    open: Math.round(open),
    full,
    dock: Math.round(dock),
    chrome: Math.round(chromeH),
  };
}

/**
 * Apply mobile sheet snap: closed | open (half) | full.
 * Heights are content-sheet only; dock stays fixed at viewport bottom.
 * @param {"closed"|"open"|"full"|boolean} state
 *   boolean kept for back-compat: true→open, false→closed
 */
function setSheetState(state) {
  if (!els.app) return;
  clearDockWidthLock();
  const isDesktop =
    typeof matchMedia !== "undefined" &&
    matchMedia("(min-width: 641px)").matches;

  /** @type {"closed"|"open"|"full"} */
  let next;
  if (typeof state === "boolean") {
    next = state ? "open" : "closed";
  } else if (state === "full" || state === "open" || state === "closed") {
    next = state;
  } else {
    next = "open";
  }
  if (isDesktop) next = "open";

  // Data attrs first so CSS can hide filters before we measure dock
  els.app.dataset.sheet = next;
  els.app.dataset.detail = next === "closed" ? "closed" : "open";

  // Clear drag overrides so CSS / published --sheet-h win
  const toolbar = document.getElementById("main-toolbar");
  if (toolbar) {
    toolbar.classList.remove("is-sheet-dragging");
    toolbar.style.removeProperty("height");
    toolbar.style.removeProperty("max-height");
  }
  document.documentElement.style.removeProperty("--sheet-drag-h");

  // Measure dock after closed hides filters; publish content height
  try {
    // Double-rAF so display:none on pills has layout effect
    const publish = () => {
      const snaps = sheetSnapHeights();
      const px =
        next === "closed"
          ? snaps.closed
          : next === "full"
            ? snaps.full
            : snaps.open;
      document.documentElement.style.setProperty("--sheet-h", `${px}px`);
      // Real chrome height — scrollers pad their content by this so the
      // list starts below the title bar and scrolls under it (blank zone)
      document.documentElement.style.setProperty(
        "--sheet-chrome-h-px",
        `${snaps.chrome}px`,
      );
    };
    publish();
    requestAnimationFrame(() => {
      publish();
      resizeMapSoon();
    });
  } catch {
    /* ignore */
  }

  if (els.panel) {
    els.panel.setAttribute("aria-hidden", "false");
    els.panel.classList.toggle("collapsed", next === "closed");
  }
  if (els.btnDetailOpen) {
    els.btnDetailOpen.setAttribute(
      "aria-expanded",
      String(next !== "closed"),
    );
    els.btnDetailOpen.classList.toggle("is-active", next !== "closed");
  }
  if (els.sheetGrabber) {
    const label =
      next === "closed"
        ? "Expand panel"
        : next === "full"
          ? "Collapse panel"
          : "Expand or collapse panel";
    els.sheetGrabber.setAttribute("aria-label", label);
  }
  resizeMapSoon();
  setTimeout(() => {
    try {
      measureNavDockH();
    } catch {
      /* ignore */
    }
    resizeMapSoon();
  }, 320);
}

/**
 * Open / close the panel sheet (back-compat boolean API).
 * Mobile: closed ↔ open (half). Use setSheetState("full") for fullscreen.
 * Desktop: panel always open.
 * @param {boolean} open
 */
function setDetailOpen(open) {
  setSheetState(!!open);
}

/** Toggle mobile sheet: closed → open → full → open → … */
function toggleSheetSnap() {
  if (
    typeof matchMedia !== "undefined" &&
    matchMedia("(min-width: 641px)").matches
  ) {
    return;
  }
  const cur = els.app?.dataset?.sheet || "open";
  if (cur === "closed") setSheetState("open");
  else if (cur === "open") setSheetState("full");
  else setSheetState("open"); // full → half (not all the way closed)
}

function openSheet(sheetEl) {
  if (!sheetEl) return;
  sheetEl.hidden = false;
  const closeBtn = sheetEl.querySelector("[data-sheet-close]");
  closeBtn?.focus?.();
}

function closeSheet(sheetEl) {
  if (!sheetEl) return;
  sheetEl.hidden = true;
}

function wireSheet(sheetEl) {
  if (!sheetEl) return;
  sheetEl.querySelectorAll("[data-sheet-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeSheet(sheetEl));
  });
}

/**
 * ETA = route search (bus / MTR / LRT); Trip Plan = origin→destination router.
 * @param {"eta"|"route"} mode
 */
function setUiMode(mode) {
  const prev = getUiMode();
  const next = mode === "route" ? "route" : "eta";
  if (els.app) els.app.dataset.uiMode = next;
  els.modeButtons().forEach((btn) => {
    const active = btn.dataset.uiMode === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  // Clear pinned tab highlight when switching product modes
  els.navTabs().forEach((btn) => {
    if (btn.dataset.nav === "pinned") {
      btn.classList.remove("is-active");
      btn.setAttribute("aria-selected", "false");
    }
  });

  // Leave nested detail pages so search page (ETA list / plan form) is visible
  if (sidebarPage === "trip") {
    closeTripDetailPage();
  } else if (
    sidebarPage === "eta-route" ||
    sidebarPage === "pinned" ||
    sidebarPage !== "search"
  ) {
    setSidebarPage("search");
  }

  // Show ETA route browser vs trip-plan form in the detail sidebar
  if (els.etaSidebarPanel) {
    els.etaSidebarPanel.hidden = next !== "eta";
  }
  if (els.tripPlanSidebarPanel) {
    els.tripPlanSidebarPanel.hidden = next === "eta";
  }
  if (next !== "route") {
    clearTripEndpointMarkers();
  } else if (prev !== "route") {
    showFormEndpointMarkers();
  }
  syncDetailTitle();

  // plan-results is a sibling of the mode panels — hide in ETA so it doesn't
  // stack under the route list and collapse/break the flex sidebar.
  if (els.planResults) {
    if (next === "eta") {
      els.planResults.hidden = true;
    } else if (plans?.length) {
      // Restore plan cards when returning to Trip Plan (content kept in DOM)
      els.planResults.hidden = false;
    }
  }

  if (next === "eta") {
    setDetailOpen(true);
    // Clear ETA route selection chrome so list fills cleanly
    if (els.etaRouteActions) els.etaRouteActions.hidden = true;
    void ensureMtrStationLinesMap();
    // Prefer user location for Nearby when we don't have a browse point yet
    if (!etaUserGeo) {
      void bootstrapNearbyUserLocation({ fly: false, triggerControl: true });
    }
    void refreshEtaRouteSuggest();
  } else {
    setDetailOpen(true);
  }
  // Keep sidebar width stable across ETA ↔ Trip Plan (no remeasure / no shrink)
  requestAnimationFrame(() => resizeMapSoon());
  // Dock height changes with the Plan Trip CTA — remeasure + sync CTA state
  requestAnimationFrame(() => measureNavDockH());
  updatePlanButton();
  syncAppNavActive();
}

/** Highlight the correct left nav tab for the current surface. */
function syncAppNavActive() {
  const page = sidebarPage;
  const mode = getUiMode();
  els.navTabs().forEach((btn) => {
    const nav = btn.dataset.nav;
    let active = false;
    if (nav === "pinned") active = page === "pinned";
    else if (nav === "nearby") active = mode === "eta" && page !== "pinned";
    else if (nav === "plan") active = mode === "route" && page !== "pinned";
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}

// ── ETA mode: bus / MTR / LRT route search ──────────────────────────────────

const MTR_ETA_LINES = [
  { id: "AEL", label: "Airport Express", aliases: ["機場快線", "機場快綫", "机场快线", "ael"] },
  { id: "TCL", label: "Tung Chung Line", aliases: ["東涌綫", "東涌線", "东涌线", "tung chung"] },
  { id: "TWL", label: "Tsuen Wan Line", aliases: ["荃灣綫", "荃灣線", "荃湾线", "tsuen wan"] },
  { id: "ISL", label: "Island Line", aliases: ["港島綫", "港島線", "港岛线", "island"] },
  { id: "KTL", label: "Kwun Tong Line", aliases: ["觀塘綫", "觀塘線", "观塘线", "kwun tong"] },
  { id: "TKL", label: "Tseung Kwan O Line", aliases: ["將軍澳綫", "將軍澳線", "将军澳线", "tseung kwan o", "tko"] },
  { id: "EAL", label: "East Rail Line", aliases: ["東鐵綫", "東鐵線", "东铁线", "east rail"] },
  { id: "TML", label: "Tuen Ma Line", aliases: ["屯馬綫", "屯馬線", "屯马线", "tuen ma"] },
  { id: "SIL", label: "South Island Line", aliases: ["南港島綫", "南港島線", "南港岛线", "south island"] },
  { id: "DRL", label: "Disneyland Resort Line", aliases: ["迪士尼綫", "迪士尼線", "迪士尼线", "disneyland"] },
];

const LRT_ETA_ROUTES = [
  "505",
  "507",
  "610",
  "614",
  "614P",
  "615",
  "615P",
  "705",
  "706",
  "751",
  "751P",
  "761P",
];

function haversineMEta(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Load station→lines map from public/mtr/stations.geojson (once). */
async function ensureMtrStationLinesMap() {
  if (mtrStationLinesMap) return mtrStationLinesMap;
  mtrStationLinesMap = new Map();
  try {
    const base =
      (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
    const url = new URL(`${base}mtr/stations.geojson`, window.location.href);
    const res = await fetch(url.href);
    if (!res.ok) return mtrStationLinesMap;
    const gj = await res.json();
    for (const f of gj.features || []) {
      const p = f.properties || {};
      const name = String(p.name_en || "").toLowerCase();
      const lines = Array.isArray(p.lines) ? p.lines.map(String) : [];
      if (name && lines.length) mtrStationLinesMap.set(name, lines);
    }
  } catch (e) {
    console.warn("[eta] station lines", e);
  }
  return mtrStationLinesMap;
}

function buildEtaRouteCatalog() {
  /** @type {Map<string, EtaRouteEntry>} */
  const map = new Map();
  const add = (e) => {
    const key = etaRouteDedupeKey(e);
    const prev = map.get(key);
    if (prev && isJointBusRoute(e)) {
      const ops = new Set(jointOpsOf(prev));
      ops.add(String(e.co || "").toLowerCase());
      prev.jointOps = [...ops];
      return;
    }
    if (!map.has(key)) {
      if (isJointBusRoute(e)) e.jointOps = jointOpsOf(e);
      map.set(key, e);
    }
  };

  for (const line of MTR_ETA_LINES) {
    add({
      id: line.id,
      label: line.label,
      kind: "mtr",
      aliases: line.aliases || [],
    });
  }
  for (const id of LRT_ETA_ROUTES) {
    add({ id, label: `Light Rail ${id}`, kind: "lrt" });
  }

  // Official MTR Bus open-data routes (preferred over fare pack alone)
  for (const id of mtrBusRouteIds()) {
    // Prefer primary variant (REFERENCE_ID === ROUTE_ID) for label
    const metas = getMtrBusRoutes().filter((r) => r.id === id);
    const meta =
      metas.find((r) => String(r.refId || "").toUpperCase() === id) ||
      metas[0];
    const dirs = mtrBusRouteDirections(id);
    const destHint =
      dirs[0]?.dest ||
      (meta?.nameEn
        ? String(meta.nameEn).replace(/^(.+?)\s+to\s+/i, "")
        : "");
    add({
      id,
      label: destHint
        ? `MTR Bus ${id} · ${destHint}`
        : meta?.nameEn
          ? `MTR Bus ${id} · ${meta.nameEn}`
          : `MTR Bus ${id}`,
      kind: "mtr_bus",
      co: "lrtfeeder",
      aliases: [
        ...(meta?.nameZh ? [meta.nameZh] : []),
        ...(meta?.nameEn ? [meta.nameEn] : []),
        ...dirs.map((d) => d.dest).filter(Boolean),
      ],
    });
  }
  const pack = getFarePack();
  const mtrBus =
    pack?.mtrBus?.byType?.octopus_adult ||
    (pack?.mtrBus && !pack.mtrBus.byType ? pack.mtrBus : null);
  if (mtrBus && typeof mtrBus === "object") {
    for (const id of Object.keys(mtrBus)) {
      if (id === "byType" || id === "byId" || id === "byName") continue;
      add({
        id: String(id).toUpperCase(),
        label: `MTR Bus ${id}`,
        kind: "mtr_bus",
        co: "lrtfeeder",
      });
    }
  }

  // RBS (NR/DB residents' bus, TD headway GTFS) — no live ETA
  if (rbsRouteData) {
    for (const [rid, rr] of Object.entries(rbsRouteData.routes)) {
      const dirs = rbsRouteDirs(rid);
      const destHint = dirs[0]?.dest || "";
      add({
        id: String(rid).toUpperCase(),
        label: destHint ? `RBS ${rid} · ${destHint}` : `RBS ${rid}`,
        kind: "bus",
        co: "rbs",
        aliases: [
          ...(rr.nameZh ? [String(rr.nameZh)] : []),
          ...(rr.nameEn ? [String(rr.nameEn)] : []),
          ...dirs.map((d) => d.destZh).filter(Boolean),
        ],
      });
    }
  }
  const byCo = pack?.bus?.byCoRoute || {};
  for (const key of Object.keys(byCo)) {
    const [co, route] = key.split("|");
    if (!route) continue;
    const coU = String(co || "").toLowerCase();
    const labelCo =
      coU === "kmb"
        ? "KMB/LWB"
        : coU === "ctb"
          ? "CTB"
          : coU === "nlb"
            ? "NLB"
            : coU === "gmb"
              ? "GMB"
              : coU === "lrtfeeder"
                ? "MTR Bus"
                : coU.toUpperCase();
    const kind = coU === "lrtfeeder" ? "mtr_bus" : "bus";
    add({
      id: String(route).toUpperCase(),
      label: `${labelCo} ${route}`,
      kind,
      co: coU,
    });
  }

  etaRouteCatalog = [...map.values()].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  console.info("[eta] route catalog", etaRouteCatalog.length);
}

/** Empty pill set = All methods. */
function etaFilterIsAll() {
  return !etaTrafficModes || etaTrafficModes.size === 0;
}

/** @param {"bus"|"mtr"|"lrt"|"gmb"} mode */
function etaFilterHas(mode) {
  return etaFilterIsAll() || etaTrafficModes.has(mode);
}

/** Sync legacy string for any residual callers. */
function syncEtaTrafficModeLegacy() {
  if (etaFilterIsAll()) etaTrafficMode = "all";
  else if (etaTrafficModes.size === 1) {
    etaTrafficMode = /** @type {"bus"|"mtr"|"lrt"|"gmb"} */ ([
      ...etaTrafficModes,
    ][0]);
  } else {
    etaTrafficMode = "all"; // multi → filter via set only
  }
}

/** @param {EtaRouteEntry} r */
function etaKindMatchesFilter(r) {
  if (etaFilterIsAll()) return true;
  if (r.kind === "mtr") return etaTrafficModes.has("mtr");
  if (r.kind === "lrt") return etaTrafficModes.has("lrt");
  if (r.kind === "mtr_bus") return etaTrafficModes.has("bus");
  if (r.kind === "bus" && r.co === "gmb") return etaTrafficModes.has("gmb");
  if (r.kind === "bus") return etaTrafficModes.has("bus");
  return false;
}

/**
 * Load KMB full route list once → dests per bound for direction dots.
 * @returns {Promise<Map<string, any[]>>}
 */
async function ensureKmbRouteBounds() {
  if (kmbRouteBoundsMap) return kmbRouteBoundsMap;
  if (kmbRouteBoundsPromise) return kmbRouteBoundsPromise;
  kmbRouteBoundsPromise = (async () => {
    /** @type {Map<string, any[]>} */
    const map = new Map();
    try {
      const res = await fetch("/eta/kmb/route/", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      for (const row of j.data || []) {
        const r = String(row.route || "")
          .trim()
          .toUpperCase();
        if (!r) continue;
        if (!map.has(r)) map.set(r, []);
        map.get(r).push({
          bound: String(row.bound || "O").toUpperCase(),
          dest_en: String(row.dest_en || "").trim(),
          dest_tc: String(row.dest_tc || "").trim(),
          orig_en: String(row.orig_en || "").trim(),
          orig_tc: String(row.orig_tc || "").trim(),
          service_type: String(row.service_type || "1"),
        });
      }
      for (const [k, arr] of map) {
        arr.sort((a, b) => Number(a.service_type) - Number(b.service_type));
        // Keep distinct orig→dest (S64C AM loop vs PM HACTL), not one row per bound.
        const seen = new Set();
        const uniq = [];
        for (const x of arr) {
          const orig = etaDestKey(x.orig_en || x.orig_tc);
          const dest = etaDestKey(x.dest_en || x.dest_tc);
          const key = `${x.bound}|${orig}|${dest}`;
          if (seen.has(key)) continue;
          seen.add(key);
          uniq.push(x);
        }
        const ordered = [];
        for (const x of uniq) if (x.bound === "O") ordered.push(x);
        for (const x of uniq) if (x.bound === "I") ordered.push(x);
        for (const x of uniq) if (x.bound !== "O" && x.bound !== "I") ordered.push(x);
        map.set(k, ordered);
      }
      console.info("[eta] KMB route bounds", map.size);
    } catch (e) {
      console.warn("[eta] KMB route list", e);
    }
    kmbRouteBoundsMap = map;
    return map;
  })();
  return kmbRouteBoundsPromise;
}

/** @returns {Promise<Array<{ stop: string, name_en: string, name_tc: string, lat: number, lon: number }>>} */
async function ensureKmbStops() {
  // Never serve a cached EMPTY directory: one failed fetch must not degrade
  // every KMB stop name to its raw id for the rest of the session.
  if (kmbStopsCache?.length) return kmbStopsCache;
  if (kmbStopsPromise) return kmbStopsPromise;
  kmbStopsPromise = (async () => {
    try {
      const res = await fetch("/eta/kmb/stop", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      kmbStopsCache = (j.data || [])
        .map((s) => ({
          stop: String(s.stop || ""),
          name_en: String(s.name_en || ""),
          name_tc: String(s.name_tc || ""),
          lat: Number(s.lat),
          lon: Number(s.long ?? s.lon),
        }))
        .filter((s) => s.stop && Number.isFinite(s.lat) && Number.isFinite(s.lon));
      if (!kmbStopsCache.length) throw new Error("empty KMB stop directory");
      console.info("[eta] KMB stops", kmbStopsCache.length);
    } catch (e) {
      // Operator directory unavailable — fall back to the local GTFS stop
      // directory (offline-ready) so names keep resolving instead of ids.
      console.warn("[eta] KMB stops API failed, using GTFS directory", e);
      try {
        const { loadGtfsStopDirectory } = await import("./routeShapes.js");
        const dir = await loadGtfsStopDirectory();
        kmbStopsCache = dir.list
          .filter((s) => String(s.id).startsWith("KMB-"))
          .map((s) => ({
            stop: String(s.id).slice("KMB-".length),
            name_en: s.name,
            name_tc: s.nameZh || "",
            lat: s.lat,
            lon: s.lon,
          }));
        if (!kmbStopsCache.length) {
          throw new Error("no KMB stops in GTFS directory");
        }
        console.info("[eta] KMB stops (GTFS fallback)", kmbStopsCache.length);
      } catch (e2) {
        console.warn("[eta] KMB stop directory unavailable", e2);
        // Leave the cache empty so the next caller retries instead of
        // permanently degrading stop names to raw ids.
        kmbStopsCache = null;
      }
    }
    kmbStopsPromise = null;
    return kmbStopsCache;
  })();
  return kmbStopsPromise;
}

/**
 * Destination labels for a catalog route (up to 2 directions).
 * Operator-strict: never use KMB OD for CTB/NLB/GMB with the same route number.
 * @param {EtaRouteEntry} r
 * @returns {Array<{ dest: string, destZh?: string, bound?: string, orig?: string, routeId?: string }>}
 */
/**
 * Full OD directions from operator bounds (no nearby filter).
 * @param {EtaRouteEntry} r
 * @returns {Array<{ dest: string, destZh?: string, bound?: string, orig?: string, stopId?: string }>}
 */
function etaRouteDirectionsFromOd(r) {
  if (!r) return [{ dest: "—" }];
  if (r.kind === "mtr") {
    return mtrLineDirections(r.id);
  }
  if (r.kind === "lrt") {
    const dirs = lrtRouteDirections(r.id);
    if (dirs.length) return dirs;
    return [{ dest: r.label, bound: "O" }];
  }

  const co = String(r.co || "").toLowerCase();
  const rid = String(r.id || "").toUpperCase();

  // Green minibus — etagmb open data (cached after ensureGmbRouteDirections)
  if (co === "gmb") {
    const dirs = gmbRouteDirectionsSync(rid);
    if (dirs.length) return dirs;
  }

  // Official MTR Bus stop sequences (not KMB)
  if (r.kind === "mtr_bus" || co === "lrtfeeder" || co === "mtrbus") {
    const dirs = mtrBusRouteDirections(rid);
    if (dirs.length) return dirs;
  }

  // RBS (residents' bus) — TD headway GTFS directions
  if (co === "rbs") {
    const dirs = rbsRouteDirs(rid);
    if (dirs.length) return dirs;
  }

  const isKmbFamily =
    co === "kmb" ||
    co === "lwb" ||
    (r.kind === "bus" && !co);

  // KMB / LWB only — must not apply to CTB/NLB/GMB/MTR Bus
  if (isKmbFamily && co !== "gmb" && co !== "ctb" && co !== "nlb") {
    const bounds = kmbRouteBoundsMap?.get(rid);
    if (bounds?.length) {
      return bounds.map((b) => {
        const dest = b.dest_en || b.dest_tc || "—";
        const orig = b.orig_en || b.orig_tc || "";
        const circular =
          /circular|循環|循环|↺/i.test(`${dest} ${b.dest_tc || ""}`) ||
          (orig && dest && etaStationsMatch(orig, dest));
        return {
          dest,
          destZh: b.dest_tc || "",
          orig,
          origZh: b.orig_tc || "",
          bound: b.bound,
          // Peak / circular variants (S64X st=3) need the correct service type
          serviceType: b.service_type || "1",
          circular,
          variant: circular ? "loop" : "oneway",
        };
      });
    }
  }

  if (co === "ctb") {
    const bounds = ctbRouteBoundsMap.get(rid);
    if (bounds?.length) return bounds;
  }

  if (co === "nlb") {
    const bounds = nlbRouteBoundsMap?.get(rid);
    if (bounds?.length) return bounds;
  }

  // Synthesize reverse when we only have one OD with orig (circulars stay 1)
  return [];
}

/**
 * Normalize destination for comparing whether two bounds are real opposites.
 * @param {string} [s]
 */
function etaDestKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[—–-]+/g, "")
    .trim();
}

/**
 * True when two station labels refer to the same place
 * (e.g. "Tung Chung" vs "東涌 Tung Chung").
 * Tight matching — avoid "Central Market" ≈ "Central" false positives on buses.
 * @param {string} [a]
 * @param {string} [b]
 */
function etaStationsMatch(a, b) {
  const ka = etaDestKey(a);
  const kb = etaDestKey(b);
  if (!ka || !kb || ka === "—" || kb === "—") return false;
  if (ka === kb) return true;

  const eng = (x) =>
    x
      .replace(/[^\u0000-\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const ea = eng(ka);
  const eb = eng(kb);
  // Exact English after stripping CJK, or one is the other only when longer ≥ 8
  // chars (avoids short substrings like "central" in many bus stop names)
  if (ea && eb) {
    if (ea === eb) return true;
    const longer = ea.length >= eb.length ? ea : eb;
    const shorter = ea.length >= eb.length ? eb : ea;
    if (
      shorter.length >= 8 &&
      (longer === shorter || longer.startsWith(shorter + " ") || longer.endsWith(" " + shorter))
    ) {
      return true;
    }
  }

  const zh = (x) => String(x || "").replace(/[\u0000-\u007f]+/g, "").trim();
  const za = zh(a);
  const zb = zh(b);
  // Chinese: exact only (Hang Hau 坑口 vs similar names)
  if (za && zb && za === zb) return true;

  // Mixed "東涌 tung chung" contains exact other key as whole phrase
  if (ka.includes(kb) && kb.length >= 6) return true;
  if (kb.includes(ka) && ka.length >= 6) return true;
  return false;
}

/**
 * Strip distance suffix from nearby stop labels: "Tung Chung · 120 m"
 * @param {string} [label]
 */
function etaBoardLabelClean(label) {
  return String(label || "")
    // Nearby browse hints are prefixed: “~123 m · 金鐘 Admiralty”
    .replace(/^~\s*[\d.]+\s*km\s*·\s*/i, "")
    .replace(/^~\s*\d+\s*m\s*·\s*/i, "")
    .replace(/\s*·\s*\d+\s*m\s*$/i, "")
    .replace(/\s*·\s*[\d.]+\s*km\s*$/i, "")
    .trim();
}

/**
 * Drop directions that end where the passenger already is
 * (e.g. "→ Tung Chung" while boarding at Tung Chung).
 * Also drops dest === orig (degenerate).
 * **MTR / LRT only** — bus OD names often collide with stop names.
 *
 * @param {Array<{ dest?: string, destZh?: string, orig?: string }>} dirs
 * @param {string} [boardLabel]
 * @param {{ kind?: string }} [route]
 */
function etaFilterSameStationDirs(dirs, boardLabel, route = null) {
  if (!dirs?.length) return [];
  const kind = String(route?.kind || "").toLowerCase();
  // Buses / GMB / MTR Bus: never rewrite OD from board name matching
  if (kind && kind !== "mtr" && kind !== "lrt") {
    return dirs.slice();
  }
  const board = etaBoardLabelClean(boardLabel);
  /** @type {typeof dirs} */
  const out = [];
  for (const d of dirs) {
    const dest = d.destZh || d.dest || "";
    const orig = d.orig || "";
    // Never "A → A"
    if (etaStationsMatch(dest, orig)) continue;
    // Never end at the board stop (rail termini)
    if (board && etaStationsMatch(dest, board)) continue;
    out.push(d);
  }
  // If everything was filtered (odd data), keep original so UI still works
  return out.length ? out : dirs.slice();
}

/**
 * True when the route has 2+ usable directions (including EAL/TKL branch thirds).
 * Do not invent a reverse from orig/dest alone.
 * @param {Array<{ dest?: string, destZh?: string, bound?: string, branch?: string }>} dirs
 */
function etaHasRealOpposite(dirs) {
  if (!dirs || dirs.length < 2) return false;
  const dests = new Set();
  for (const d of dirs) {
    const k = etaDestKey(d?.destZh || d?.dest);
    if (k && k !== "—") dests.add(k);
  }
  if (dests.size >= 2) return true;
  // Fallback: classic two-bound check
  const a = dirs[0];
  const b = dirs[1];
  const da = etaDestKey(a?.destZh || a?.dest);
  const db = etaDestKey(b?.destZh || b?.dest);
  if (!da || !db || da === "—" || db === "—" || da === db) return false;
  const ba = String(a?.bound || "").toUpperCase();
  const bb = String(b?.bound || "").toUpperCase();
  if (ba && bb && ba === bb && !a?.branch && !b?.branch) return false;
  return true;
}

/** Circular / loop departure (S64C AM Yat Tung ↺ Cargo). */
function etaIsCircularDir(d) {
  if (!d) return false;
  if (d.circular || d.variant === "loop") return true;
  const blob = `${d.dest || ""} ${d.destZh || ""} ${d.orig || ""}`;
  if (/↺|circular|循環|循环/i.test(blob)) return true;
  return !!(d.orig && d.dest && etaStationsMatch(d.orig, d.dest));
}

/**
 * AM/PM (or special) departures that are not a simple reverse of the same trip.
 * S64C: loop vs HACTL inbound share a corridor but are not Opposite.
 */
function etaHasDepartureSwitch(dirs) {
  if (!dirs || dirs.length < 2) return false;
  if (dirs.some(etaIsCircularDir)) return true;
  const bounds = new Set(
    dirs.map((d) => String(d.bound || "").toUpperCase()).filter(Boolean),
  );
  if (bounds.size === 1) return true;
  if (dirs.length === 2) {
    const a = dirs[0];
    const b = dirs[1];
    const swapped =
      etaStationsMatch(a?.orig, b?.dest) && etaStationsMatch(a?.dest, b?.orig);
    if (!swapped) return true;
  }
  return false;
}

function etaNextDepartureIndex(di, dirs) {
  if (!dirs?.length) return 0;
  return (Math.min(Math.max(0, di), dirs.length - 1) + 1) % dirs.length;
}

function etaDeparturePeriod(dir) {
  const first = Number(dir?.first);
  if (Number.isFinite(first)) return first < 12 * 60 ? "AM" : "PM";
  if (etaIsCircularDir(dir)) return "AM";
  return "PM";
}

function etaDepartureLabel(dir) {
  const orig = localizeDirLabel(dir, "orig") || dir?.orig || "";
  const dest = localizeDirLabel(dir, "dest") || dir?.destZh || dir?.dest || "";
  const destClean = String(dest)
    .replace(/\s*\((circular|循環|循环)\)\s*/gi, "")
    .trim();
  if (etaIsCircularDir(dir) && orig && destClean) {
    return `${orig} ↺ ${destClean}`;
  }
  if (orig && destClean) return `${orig} → ${destClean}`;
  return destClean || orig || "—";
}

function etaPreferredDepartureIndex(dirs, now = new Date()) {
  if (!dirs?.length) return 0;
  if (!etaHasDepartureSwitch(dirs)) return 0;
  const hk = getHongKongParts(now);
  const mins = (hk.hour || 0) * 60 + (hk.minute || 0);
  const inServiceToday = (d) => Number(d?.last) !== -1;
  for (let i = 0; i < dirs.length; i++) {
    if (!inServiceToday(dirs[i])) continue;
    const first = Number(dirs[i].first);
    const last = Number(dirs[i].last);
    if (
      Number.isFinite(first) &&
      Number.isFinite(last) &&
      last >= 0 &&
      mins >= first &&
      mins <= last
    ) {
      return i;
    }
  }
  let next = -1;
  let nextStart = Infinity;
  for (let i = 0; i < dirs.length; i++) {
    if (!inServiceToday(dirs[i])) continue;
    const first = Number(dirs[i].first);
    if (Number.isFinite(first) && first > mins && first < nextStart) {
      nextStart = first;
      next = i;
    }
  }
  if (next >= 0) return next;
  const loop = dirs.findIndex((d) => etaIsCircularDir(d) && inServiceToday(d));
  const pm = dirs.findIndex((d, i) => i !== loop && inServiceToday(d));
  if (mins < 12 * 60 && loop >= 0) return loop;
  if (pm >= 0) return pm;
  return Math.max(0, loop);
}

/** Bound + dest — AM/PM variants can share O/I. */
function etaDestBoundKey(d) {
  const b = String(d?.bound || "").toUpperCase();
  const dest = etaDestKey(d?.destZh || d?.dest);
  return dest && dest !== "—" ? `${b}|${dest}` : b || "x";
}

function etaMatchDepartureSlotIndex(slots, want) {
  if (!slots?.length || !want) return -1;
  const destK = etaDestKey(want.destZh || want.dest);
  if (destK && destK !== "—") {
    const byDest = slots.findIndex(
      (s) => etaDestKey(s.destZh || s.dest) === destK,
    );
    if (byDest >= 0) return byDest;
  }
  const b = String(want.bound || "").toUpperCase();
  if (b) {
    const byBound = slots.findIndex(
      (s) => String(s.bound || "").toUpperCase() === b,
    );
    if (byBound >= 0) return byBound;
  }
  return -1;
}

/**
 * Opposite = reverse bound only (O↔I), never cycle branches.
 * E.g. “To Tsuen Wan” → “To Central”. Branches use Switch branch.
 * @param {number} di
 * @param {Array<{ bound?: string, branch?: string }>} dirs
 */
function etaOppositeDirIndex(di, dirs) {
  if (!dirs?.length) return 0;
  const from = Math.min(Math.max(0, di), dirs.length - 1);
  const cur = dirs[from];
  const curB = String(cur?.bound || "").toUpperCase();
  const curBr = String(cur?.branch || "").toUpperCase();
  const wantB =
    curB === "O" || curB === "UP" || curB === "1"
      ? "I"
      : curB === "I" || curB === "DOWN" || curB === "2"
        ? "O"
        : "";
  if (!wantB) {
    // No O/I labels — fall back to next distinct dest
    return (from + 1) % dirs.length;
  }
  // Prefer reverse with same branch (EAL LOW O ↔ LOW I)
  let hit = dirs.findIndex(
    (d, i) =>
      i !== from &&
      String(d.bound || "").toUpperCase() === wantB &&
      String(d.branch || "").toUpperCase() === curBr,
  );
  if (hit >= 0) return hit;
  hit = dirs.findIndex(
    (d, i) => i !== from && String(d.bound || "").toUpperCase() === wantB,
  );
  return hit >= 0 ? hit : from;
}

/** @deprecated use etaOppositeDirIndex — kept for call sites that cycle all dirs */
function etaNextDirIndex(di, dirs) {
  return etaOppositeDirIndex(di, dirs);
}

/**
 * Indices of sibling branch directions sharing the same bound.
 * @param {Array<{ bound?: string, branch?: string, dest?: string }>} dirs
 * @param {number} di
 */
function etaBranchSiblingIndices(dirs, di) {
  if (!dirs?.length) return [];
  const from = Math.min(Math.max(0, di), dirs.length - 1);
  const b = String(dirs[from]?.bound || "").toUpperCase();
  if (!b) return [];
  return dirs
    .map((d, i) => ({ d, i }))
    .filter(
      (x) =>
        String(x.d.bound || "").toUpperCase() === b &&
        String(x.d.branch || "") !== "",
    )
    .map((x) => x.i);
}

/**
 * Next branch index (same bound, other terminus path). EAL LOW↔LMC, TKL POA↔LHP.
 * @param {number} di
 * @param {Array} dirs
 */
function etaNextBranchIndex(di, dirs) {
  const sibs = etaBranchSiblingIndices(dirs, di);
  if (sibs.length < 2) return di;
  const pos = sibs.indexOf(di);
  if (pos < 0) return sibs[0];
  return sibs[(pos + 1) % sibs.length];
}

/**
 * Labels for the Branch control, showing BOTH the active branch and the
 * one it will switch to. When both branches share one destination (TKL
 * inbound → North Point, EAL inbound → Admiralty) the dest is identical
 * for both and uninformative — use the terminus each service starts from
 * instead, so the two options stay distinguishable.
 * @param {{ dest?: string, destZh?: string, orig?: string, origZh?: string } | null | undefined} cur
 * @param {{ dest?: string, destZh?: string, orig?: string, origZh?: string } | null | undefined} nextBr
 */
function etaBranchPairLabels(cur, nextBr) {
  if (!cur || !nextBr) return { cur: t("Branch"), other: "" };
  const sameDest =
    etaDestKey(nextBr.destZh || nextBr.dest) ===
    etaDestKey(cur.destZh || cur.dest);
  const pick = (d) =>
    localizeDirLabel(d, sameDest ? "orig" : "dest") ||
    localizeDirLabel(d, "dest") ||
    "";
  return { cur: pick(cur), other: pick(nextBr) };
}

/**
 * Dual-label branch pill: current (bright) ⇄ other (dimmed).
 * @param {{ cur: string, other: string }} pair
 */
function etaBranchLabelsHtml(pair) {
  if (!pair?.other) return `<span class="wheels-branch-dest is-current">${escapeHtml(pair?.cur || "Branch")}</span>`;
  return `<span class="wheels-branch-dest is-current">${escapeHtml(pair.cur)}</span><span class="wheels-branch-sep" aria-hidden="true">⇄</span><span class="wheels-branch-dest is-other">${escapeHtml(pair.other)}</span>`;
}

/**
 * Panel destination label for a direction. Branched rail lines whose
 * siblings diverge show ALL branch termini (“羅湖 / 落馬洲”, “寶琳 / 康城”)
 * because either train serves the platform; shared-dest directions
 * (inbound North Point / Admiralty) dedupe to the single dest.
 * @param {Array<{ bound?: string, branch?: string, dest?: string, destZh?: string }> | null | undefined} dirs
 * @param {number} di
 */
function etaPanelDestLabel(dirs, di) {
  const cur = dirs?.[di];
  const base = localizeDirLabel(cur, "dest");
  const sibs = etaBranchSiblingIndices(dirs, di);
  if (sibs.length < 2) return base;
  const labels = [];
  for (const i of sibs) {
    const l = localizeDirLabel(dirs[i], "dest");
    if (l && !labels.some((x) => etaDestKey(x) === etaDestKey(l))) {
      labels.push(l);
    }
  }
  return labels.length >= 2 ? labels.join(" / ") : labels[0] || base;
}

/**
 * Display destination for a direction on list / pinned cards. Branched rail
 * lines (EAL/TKL) pair both branch termini (“羅湖 / 落馬洲”, “寶琳 / 康城”)
 * because either train serves the platform; shared-dest directions dedupe.
 * @param {Array<{ bound?: string, branch?: string, dest?: string, destZh?: string }> | null | undefined} dirs
 * @param {{ bound?: string, branch?: string, dest?: string, destZh?: string } | null | undefined} dir
 */
function etaDirectionDisplayLabel(dirs, dir) {
  if (etaHasDepartureSwitch(dirs) && dir) return etaDepartureLabel(dir);
  const base = localizeDirLabel(dir, "dest");
  if (!dirs?.length || !dir) return base;
  const di = dirs.findIndex(
    (d) =>
      String(d.bound || "").toUpperCase() ===
        String(dir.bound || "").toUpperCase() &&
      String(d.branch || "") === String(dir.branch || ""),
  );
  return di < 0 ? base : etaPanelDestLabel(dirs, di);
}

/**
 * Prefer the reverse bound that starts at the given terminus station code.
 * @param {string} lineId
 * @param {Array<{ bound?: string, branch?: string }>} dirs
 * @param {number} fromDi
 * @param {string} terminusCode
 */
function etaOppositeDirIndexForTerminus(lineId, dirs, fromDi, terminusCode) {
  const code = String(terminusCode || "").toUpperCase();
  if (!code || !dirs?.length) return etaOppositeDirIndex(fromDi, dirs);
  for (let i = 0; i < dirs.length; i++) {
    if (i === fromDi) continue;
    const d = dirs[i];
    const codes = mtrLineCodesInOrder(
      lineId,
      d.bound || "O",
      d.branch || null,
    );
    if (codes[0] === code) return i;
  }
  return etaOppositeDirIndex(fromDi, dirs);
}

/**
 * Resolve board index on a direction’s ordered station list.
 * @param {string} lineId
 * @param {{ bound?: string, branch?: string }} dir
 * @param {string} boardLabel
 * @param {{ stationCode?: string, code?: string, name?: string } | null} [boardStop]
 * @returns {{ isFirst: boolean, isLast: boolean, index: number, codes: string[] }}
 */
function etaMtrBoardPosition(lineId, dir, boardLabel, boardStop = null) {
  const codes = mtrLineCodesInOrder(
    lineId,
    dir?.bound || "O",
    dir?.branch || null,
  );
  if (!codes.length) {
    return { isFirst: false, isLast: false, index: -1, codes };
  }
  let idx = -1;
  const code = String(
    boardStop?.stationCode || boardStop?.code || "",
  ).toUpperCase();
  if (code) idx = codes.indexOf(code);
  if (idx < 0 && boardLabel) {
    for (let i = 0; i < codes.length; i++) {
      const lab = mtrStationLabel(codes[i]);
      if (
        etaStationsMatch(boardLabel, lab.en) ||
        etaStationsMatch(boardLabel, lab.zh) ||
        etaStationsMatch(boardLabel, `${lab.zh} ${lab.en}`)
      ) {
        idx = i;
        break;
      }
    }
  }
  return {
    isFirst: idx === 0,
    isLast: idx === codes.length - 1,
    index: idx,
    codes,
  };
}

/**
 * Keep only directions that have a real operator stop sequence (≥2 stops).
 * Filters out phantom reverse bounds (common for one-way / circular).
 * @param {EtaRouteEntry} route
 * @param {Array<{ dest?: string, destZh?: string, bound?: string, orig?: string }>} dirs
 */
async function filterDirsWithRealStops(route, dirs) {
  if (!route || !dirs?.length) return dirs || [];
  if (dirs.length === 1) return dirs;
  const co = String(route.co || "").toLowerCase();
  const rid = String(route.id || "").toUpperCase();
  /** @type {typeof dirs} */
  const out = [];

  for (const d of dirs) {
    const bound = String(d.bound || "O").toUpperCase();
    const direction = bound === "I" ? "inbound" : "outbound";
    try {
      if (co === "ctb") {
        const n = await countCtbRouteStopRows(rid, direction);
        if (n >= 2) out.push(d);
        continue;
      }
      if (route.kind === "mtr_bus" || co === "lrtfeeder" || co === "mtrbus") {
        await ensureMtrBusData();
        const seq = mtrBusStopSequence(rid, bound);
        if (seq.length >= 2) out.push(d);
        continue;
      }
      if (route.kind === "mtr") {
        const codes = mtrLineCodesInOrder(rid, bound, d.branch || null);
        if (codes.length >= 2) out.push(d);
        continue;
      }
      if (route.kind === "lrt") {
        await ensureLrtRouteData();
        const seq = lrtStopSequence(rid, bound);
        if (seq.length >= 2) out.push(d);
        continue;
      }
      if (co === "gmb") {
        await ensureGmbRouteDirections(rid);
        const seq = await loadGmbStopSequence(rid, bound);
        if (seq.length >= 2) out.push(d);
        else if (d.dest || d.destZh) out.push(d);
        continue;
      }
      if (
        co === "kmb" ||
        co === "lwb" ||
        (route.kind === "bus" && !co)
      ) {
        const seq = await ensureKmbRouteStopSeq(rid, direction, d.serviceType);
        if (seq.length >= 2) {
          out.push(d);
          continue;
        }
        // AM/PM variants may publish the stop list on the other KMB bound.
        const other = direction === "inbound" ? "outbound" : "inbound";
        const seq2 = await ensureKmbRouteStopSeq(rid, other, d.serviceType);
        if (seq2.length >= 2) out.push(d);
        continue;
      }
      if (co === "nlb") {
        // NLB variants are separate routeIds — keep if labeled
        if (d.dest || d.destZh) out.push(d);
        continue;
      }
      // Unknown: keep as-is
      out.push(d);
    } catch {
      /* drop this bound on error */
    }
  }

  const uniq = etaUniqueDirections(out);
  // If verification wiped everything, fall back to first OD dir only
  if (!uniq.length && dirs.length) return [dirs[0]];
  return uniq;
}

/**
 * Drop duplicate / fake directions so Opposite is not shown for one-way routes.
 * @param {Array<{ dest?: string, destZh?: string, bound?: string, orig?: string, stopId?: string }>} dirs
 */
/**
 * Stable key for a direction / nearby slot (bound + optional branch).
 * EAL/TKL have multiple O and I rows that share dest (e.g. both I → Admiralty).
 * @param {{ bound?: string, branch?: string, dest?: string, destZh?: string }} d
 */
function etaDirSlotKey(d) {
  const b = String(d?.bound || "").toUpperCase();
  const branch = String(d?.branch || "").toUpperCase();
  if (branch) return `${b}|${branch}`;
  const dest = etaDestKey(d?.destZh || d?.dest);
  const orig = etaDestKey(d?.orig || d?.origZh);
  const st = String(d?.serviceType || d?.service_type || "");
  if (orig && dest && orig !== dest) return `od:${orig}>${dest}|${b || "x"}|${st}`;
  if (dest && dest !== "—") return `d:${dest}|${b || "x"}|${st}`;
  return `${b || "x"}|${st}`;
}

function etaUniqueDirections(dirs) {
  if (!dirs?.length) return [];
  /** @type {typeof dirs} */
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    // Prefer bound|branch so EAL/TKL keep both inbounds (same dest city end)
    const key = etaDirSlotKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * @param {EtaRouteEntry} r
 * @param {{ full?: boolean }} [opts] full=true → always use operator OD (route detail)
 */
function etaRouteDirections(r, opts = {}) {
  if (!r) return [{ dest: "—" }];
  const key = etaRouteKey(r);
  const full = !!opts.full;

  // Nearby browse: use multi-dir slots only when they are real opposites.
  // A single slot (e.g. after first Opposite live fetch for MTR) must not
  // hide Opposite — fall through to full OD when the line is two-way.
  if (!full) {
    const nearbySlots = etaNearbyDirsByKey.get(key);
    if (nearbySlots?.length) {
      const mapped = etaUniqueDirections(
        nearbySlots.map((s) => ({
          dest: s.dest || "—",
          destZh: s.destZh || "",
          bound: s.bound,
          orig: s.stopLabel || "",
          stopId: s.stopId,
        })),
      );
      if (
        mapped.length >= 2 &&
        (etaHasRealOpposite(mapped) || etaHasDepartureSwitch(mapped))
      ) {
        return mapped;
      }
    }
  }

  const od = etaUniqueDirections(etaRouteDirectionsFromOd(r));
  // Never invent a reverse O↔I from a single OD row — one-way / circular
  // routes were incorrectly showing Opposite. Keep AM/PM departure variants
  // (S64C loop vs HACTL inbound) even when they share a bound.
  if (od.length >= 2 && (etaHasRealOpposite(od) || etaHasDepartureSwitch(od))) {
    return od;
  }
  if (od.length >= 1) return od.slice(0, 1);

  // One-way / no OD: single nearby slot is fine
  if (!full) {
    const nearbySlots = etaNearbyDirsByKey.get(key);
    if (nearbySlots?.length) {
      return etaUniqueDirections(
        nearbySlots.map((s) => ({
          dest: s.dest || "—",
          destZh: s.destZh || "",
          bound: s.bound,
          orig: s.stopLabel || "",
          stopId: s.stopId,
        })),
      ).slice(0, 1);
    }
  }

  const live = etaLiveByKey.get(key);
  if (live?.dest) {
    return [
      {
        dest: live.dest,
        destZh: live.destZh || "",
        bound: live.bound || "O",
      },
    ];
  }
  const lab = String(r.label || "").replace(
    /^(KMB\/LWB|CTB|NLB|GMB|MTR Bus)\s+/i,
    "",
  );
  return [{ dest: lab || r.id, bound: "O" }];
}

/**
 * Count CTB route-stop rows for a direction (no per-stop detail fetch).
 * @param {string} routeId
 * @param {"inbound"|"outbound"} direction
 */
async function countCtbRouteStopRows(routeId, direction) {
  const rid = String(routeId || "").toUpperCase();
  const dir = direction === "inbound" ? "inbound" : "outbound";
  try {
    const rs = await fetch(
      `/eta/ctb/route-stop/CTB/${encodeURIComponent(rid)}/${dir}`,
      { headers: { Accept: "application/json" } },
    );
    if (!rs.ok) return 0;
    const j = await rs.json();
    return Array.isArray(j.data) ? j.data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch CTB OD — only include bounds that have a real stop list
 * (do not invent reverse for one-way / circular routes).
 * @param {string} routeId
 */
async function ensureCtbRouteBound(routeId) {
  const id = String(routeId || "").toUpperCase();
  if (!id) return [];
  if (ctbRouteBoundsMap.has(id)) return ctbRouteBoundsMap.get(id) || [];
  if (ctbRouteBoundPromises.has(id)) return ctbRouteBoundPromises.get(id);

  const p = (async () => {
    try {
      const res = await fetch(
        `/eta/ctb/route/CTB/${encodeURIComponent(id)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      const d = j.data || {};
      const outEn = String(d.dest_en || d.dest_tc || "—").trim();
      const outZh = String(d.dest_tc || "").trim();
      const inEn = String(d.orig_en || d.orig_tc || "—").trim();
      const inZh = String(d.orig_tc || "").trim();

      const [nOut, nIn] = await Promise.all([
        countCtbRouteStopRows(id, "outbound"),
        countCtbRouteStopRows(id, "inbound"),
      ]);

      /** @type {Array<{ dest: string, destZh?: string, bound: string, orig?: string }>} */
      const dirs = [];
      if (nOut >= 2) {
        dirs.push({
          dest: outEn,
          destZh: outZh,
          bound: "O",
          orig: inEn,
        });
      }
      // Only add reverse when Citybus publishes an inbound stop list
      if (nIn >= 2) {
        dirs.push({
          dest: inEn,
          destZh: inZh,
          bound: "I",
          orig: outEn,
        });
      }
      // Fallback: at least show the published OD once if both lists empty
      if (!dirs.length) {
        dirs.push({
          dest: outEn,
          destZh: outZh,
          bound: "O",
          orig: inEn,
        });
      }
      ctbRouteBoundsMap.set(id, dirs);
      return dirs;
    } catch (e) {
      console.warn("[eta] CTB route", id, e);
      ctbRouteBoundsMap.set(id, []);
      return [];
    } finally {
      ctbRouteBoundPromises.delete(id);
    }
  })();
  ctbRouteBoundPromises.set(id, p);
  return p;
}

/**
 * NLB list once → directions per routeNo (each variant = one routeId).
 */
async function ensureNlbRouteBounds() {
  if (nlbRouteBoundsMap) return nlbRouteBoundsMap;
  if (nlbRouteBoundsPromise) return nlbRouteBoundsPromise;
  nlbRouteBoundsPromise = (async () => {
    /** @type {Map<string, Array<{ dest: string, destZh?: string, bound: string, orig?: string, routeId?: string }>>} */
    const map = new Map();
    try {
      const res = await fetch("/eta/nlb/route.php?action=list", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      const routes = j.routes || j.data || [];
      for (const row of routes) {
        const no = String(row.routeNo || row.route || "")
          .trim()
          .toUpperCase();
        if (!no) continue;
        const nameE = String(row.routeName_e || "");
        const nameC = String(row.routeName_c || "");
        const partsE = nameE.split(/\s*>\s*/);
        const partsC = nameC.split(/\s*>\s*/);
        const orig = (partsE[0] || "").trim();
        const dest = (partsE[1] || partsE[0] || nameE || "—").trim();
        const destZh = (partsC[1] || partsC[0] || "").trim();
        const entry = {
          dest: dest || "—",
          destZh,
          bound: map.has(no) && map.get(no).length ? "I" : "O",
          orig,
          routeId: String(row.routeId || row.route_id || ""),
        };
        if (!map.has(no)) map.set(no, []);
        map.get(no).push(entry);
      }
      console.info("[eta] NLB route bounds", map.size);
    } catch (e) {
      console.warn("[eta] NLB route list", e);
    }
    nlbRouteBoundsMap = map;
    return map;
  })();
  return nlbRouteBoundsPromise;
}

/**
 * Prefetch OD labels for visible non-KMB hits so cards don't show wrong company dest.
 * @param {EtaRouteEntry[]} hits
 */
async function prefetchEtaDirections(hits) {
  if (!hits?.length) return;
  const tasks = [];
  let needNlb = false;
  let needLrt = false;
  let needGmb = false;
  for (const r of hits.slice(0, 40)) {
    const co = String(r.co || "").toLowerCase();
    if (co === "ctb") tasks.push(ensureCtbRouteBound(r.id));
    if (co === "nlb") needNlb = true;
    if (r.kind === "lrt") needLrt = true;
    if (co === "gmb") {
      needGmb = true;
      tasks.push(ensureGmbRouteDirections(r.id));
    }
  }
  if (needNlb) tasks.push(ensureNlbRouteBounds());
  if (needLrt) tasks.push(ensureLrtRouteData());
  if (needGmb) tasks.push(ensureGmbRouteCodes());
  if (tasks.length) await Promise.all(tasks);
}

/**
 * Company CSS class (legacy hooks). Prefer companyLineColor() for actual hex —
 * matches Trip plan / GTFS agency colours.
 * @param {EtaRouteEntry} r
 */
function etaCompanyColorClass(r) {
  if (r.kind === "mtr") return "co-mtr";
  if (r.kind === "lrt") return "co-lrt";
  if (r.kind === "mtr_bus") return "co-mtrbus";
  const co = String(r.co || "").toLowerCase();
  if (co === "gmb") return "co-gmb";
  if (co === "ctb") return "co-ctb";
  if (co === "nlb") return "co-nlb";
  if (co === "lwb") return "co-lwb";
  if (co === "rbs") return "co-rbs";
  if (co === "kmb" || !co) return "co-kmb";
  return "co-kmb";
}

/**
 * Agency brand colours from HK GTFS (same palette Trip plan uses via route_color).
 * MTR/LRT use resolveRouteColor brand map.
 */
const ETA_AGENCY_GTFS_COLORS = {
  kmb: "#EE171F",
  lwb: "#EE171F",
  ctb: "#0053B9",
  nlb: "#8AB666",
  gmb: "#34C759",
  lrtfeeder: "#AE2A42",
  mtrbus: "#AE2A42",
  rbs: "#0F766E", // Residents' Bus Services (NR/DB) teal — no live ETA
};

/**
 * Compact GTFS-derived index for non-KMB nearby (CTB/NLB/GMB/MTR Bus).
 * Shape: { v, stops: [lat, lon, name, stopId, [[co, route], ...]] }
 * @type {{ v: number, stops: any[] } | null}
 */
let etaNearbyIndex = null;
/** @type {Promise<{ v: number, stops: any[] }> | null} */
let etaNearbyIndexPromise = null;

async function ensureEtaNearbyIndex() {
  if (etaNearbyIndex) return etaNearbyIndex;
  if (etaNearbyIndexPromise) return etaNearbyIndexPromise;
  etaNearbyIndexPromise = (async () => {
    try {
      const j = await fetchDataJson("/data/eta-nearby-stops.json");
      etaNearbyIndex = {
        v: Number(j.v) || 1,
        stops: Array.isArray(j.stops) ? j.stops : [],
      };
      console.info("[eta] nearby index stops", etaNearbyIndex.stops.length);
      // Fold in RBS stops (NR/DB residents' bus, TD headway GTFS) so Nearby
      // browse finds them geographically; existing stop ids get extra pairs.
      try {
        const rj = await fetchDataJson("/data/rbs-stops.json");
        if (rj) {
          const rows = Array.isArray(rj.stops) ? rj.stops : [];
          if (rows.length) {
            const byId = new Map(
              etaNearbyIndex.stops.map((s) => [String(s[3]), s]),
            );
            for (const row of rows) {
              const sid = String(row[3]);
              const pairs = Array.isArray(row[4]) ? row[4] : [];
              if (!pairs.length) continue;
              const ex = byId.get(sid);
              if (ex && Array.isArray(ex[4])) {
                for (const p of pairs) {
                  if (!ex[4].some((q) => q[0] === p[0] && q[1] === p[1]))
                    ex[4].push(p);
                }
              } else {
                byId.set(sid, row);
                etaNearbyIndex.stops.push(row);
              }
            }
            console.info("[eta] nearby index + RBS stops", rows.length);
          }
        }
      } catch (e) {
        console.warn("[eta] RBS nearby", e);
      }
    } catch (e) {
      console.warn("[eta] nearby index", e);
      etaNearbyIndex = { v: 1, stops: [] };
    }
    return etaNearbyIndex;
  })();
  return etaNearbyIndexPromise;
}

/** Look up a bilingual stop label in a loaded GTFS directory. */
function gtfsDirStopLabel(dir, rawId, co, fallback) {
  const fb = String(fallback || "").trim();
  if (!dir?.byId) return { name: fb, nameEn: fb, nameTc: "" };
  const coUp = String(co || "").toUpperCase();
  const raw = String(rawId || "").trim();
  const ids = [];
  if (raw) {
    ids.push(raw);
    if (coUp) ids.push(`${coUp}-${raw}`);
  }
  for (const id of ids) {
    const i = dir.byId.get(id);
    if (i == null) continue;
    const s = dir.list[i];
    const nameEn = s.name || fb;
    const nameTc = s.nameZh || "";
    return {
      nameEn,
      nameTc,
      name: stopDisplayName({ nameEn, nameTc, name: nameEn }) || fb,
    };
  }
  return { name: fb, nameEn: fb, nameTc: "" };
}

/**
 * Compact RBS route data (TD headway GTFS): route id → per-direction
 * { dest/orig, headwayMins, first/last, stops }. No live ETA exists for
 * RBS — this powers catalog labels, stop lists and headway “Timetable” slots.
 * @type {{ v: number, routes: Record<string, any> } | null}
 */
let rbsRouteData = null;
/** @type {Promise<any> | null} */
let rbsRouteDataPromise = null;

async function ensureRbsRouteData() {
  if (rbsRouteData) return rbsRouteData;
  if (rbsRouteDataPromise) return rbsRouteDataPromise;
  rbsRouteDataPromise = (async () => {
    try {
      const j = await fetchDataJson("/data/rbs-routes.json");
      rbsRouteData = {
        v: Number(j.v) || 1,
        routes: j.routes && typeof j.routes === "object" ? j.routes : {},
      };
      console.info("[eta] RBS routes", Object.keys(rbsRouteData.routes).length);
    } catch (e) {
      console.warn("[eta] RBS routes", e);
      rbsRouteData = { v: 1, routes: {} };
    }
    return rbsRouteData;
  })();
  return rbsRouteDataPromise;
}

/** RBS direction rows (dest/orig/bound + headway service window). */
function rbsRouteDirs(rid) {
  const rr = rbsRouteData?.routes?.[String(rid || "").toUpperCase()];
  if (!rr?.dirs) return [];
  return Object.entries(rr.dirs).map(([bound, d]) => ({
    bound: bound === "I" ? "I" : "O",
    dest: String(d.dest || ""),
    destZh: String(d.destZh || ""),
    orig: String(d.orig || ""),
    origZh: String(d.origZh || ""),
    headwayMins: Number(d.headwayMins) || undefined,
    first: d.first != null ? Number(d.first) : undefined,
    last: d.last != null ? Number(d.last) : undefined,
    overnight: !!d.overnight,
  }));
}

/** Stop sequence for one RBS route direction (from the TD headway GTFS). */
function rbsRouteStops(rid, bound) {
  const rr = rbsRouteData?.routes?.[String(rid || "").toUpperCase()];
  const d = rr?.dirs?.[bound === "I" ? "I" : "O"];
  const list = Array.isArray(d?.stops) ? d.stops : [];
  return list
    .map((s, i) => ({
      seq: Number(s.seq) || i + 1,
      name: s.name || s.nameTc || s.nameEn || "",
      nameEn: String(s.nameEn || ""),
      nameTc: String(s.nameTc || ""),
      stopId: String(s.id || ""),
      lon: Number(s.lon),
      lat: Number(s.lat),
    }))
    .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));
}

/**
 * Label helper for multi-op catalog/nearby cards.
 * @param {string} co
 * @param {string} route
 */
function etaCoRouteLabel(co, route) {
  const c = String(co || "").toLowerCase();
  const r = String(route || "").toUpperCase();
  if (c === "ctb") return `CTB ${r}`;
  if (c === "nlb") return `NLB ${r}`;
  if (c === "gmb") return `GMB ${r}`;
  if (c === "lwb") return `LWB ${r}`;
  if (c === "lrtfeeder" || c === "mtrbus") return `MTR Bus ${r}`;
  if (c === "rbs") return `RBS ${r}`;
  if (c === "kmb") return `KMB ${r}`;
  return `Bus ${r}`;
}

/**
 * Nearby CTB / NLB / GMB / MTR Bus from GTFS stop index (geo), optional CTB live ETA.
 * @param {{ lat: number, lon: number }} geo
 * @param {number} [limit]
 */
async function fetchNearbyMultiOpHits(geo, limit = 24) {
  const idx = await ensureEtaNearbyIndex();
  const stops = idx?.stops || [];
  if (!stops.length) return { hits: [], hint: "" };
  let gtfsDir = null;
  try {
    const { loadGtfsStopDirectory } = await import("./routeShapes.js");
    gtfsDir = await loadGtfsStopDirectory();
    etaGtfsDir = gtfsDir;
  } catch {
    /* offline pack without stops.json */
  }

  /** @type {Array<{ s: any, d: number }>} */
  const ranked = [];
  for (const s of stops) {
    const lat = Number(s[0]);
    const lon = Number(s[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const d = haversineMEta(geo.lat, geo.lon, lat, lon);
    if (d <= 500) ranked.push({ s, d });
  }
  ranked.sort((a, b) => a.d - b.d);
  const topStops = ranked.slice(0, 14);
  if (!topStops.length) {
    return { hits: [], hint: "No CTB/NLB/GMB stops within 500 m" };
  }

  /**
   * routeKey → { entry, stops: Array<{stopId,name,d}>, byBound: Map }
   * @type {Map<string, { entry: EtaRouteEntry, nearStops: Array<{stopId:string,name:string,d:number}>, byBound: Map<string, EtaNearbyDirSlot> }>}
   */
  const byKey = new Map();

  for (const { s, d } of topStops) {
    const lat = Number(s[0]);
    const lon = Number(s[1]);
    const nameEn = String(s[2] || "");
    const stopId = String(s[3] || "");
    const routes = Array.isArray(s[4]) ? s[4] : [];
    for (const pair of routes) {
      const co = String(pair?.[0] || "").toLowerCase();
      const route = String(pair?.[1] || "").toUpperCase();
      if (!co || !route) continue;
      const lab = gtfsDirStopLabel(gtfsDir, stopId, co, nameEn);
      const name = lab.name || nameEn;
      const kind = co === "lrtfeeder" || co === "mtrbus" ? "mtr_bus" : "bus";
      const entry = {
        id: route,
        label: etaCoRouteLabel(co, route),
        kind,
        co,
        nearbyHint: `${name} · ${Math.round(d)} m`,
      };
      if (!etaKindMatchesFilter(entry)) continue;
      const k = etaRouteKey(entry);
      let pack = byKey.get(k);
      if (!pack) {
        pack = { entry, nearStops: [], byBound: new Map() };
        byKey.set(k, pack);
      }
      // Keep a few nearby stops per route (for opposite direction)
      if (
        pack.nearStops.length < 6 &&
        !pack.nearStops.some((x) => x.stopId === stopId)
      ) {
        pack.nearStops.push({
        stopId,
        name,
        nameEn: lab.nameEn,
        nameTc: lab.nameTc,
        d,
        lat,
        lon,
      });
      }
      pack.nearStops.sort((a, b) => a.d - b.d);
    }
  }

  // Live CTB ETAs across nearby stops → per-bound slots
  const ctbPacks = [...byKey.entries()]
    .filter(([, p]) => p.entry.co === "ctb")
    .sort(
      (a, b) =>
        (a[1].nearStops[0]?.d ?? 9999) - (b[1].nearStops[0]?.d ?? 9999),
    )
    .slice(0, 14);

  await Promise.all(
    ctbPacks.map(async ([k, pack]) => {
      const entry = pack.entry;
      for (const near of pack.nearStops.slice(0, 5)) {
        const sid = near.stopId;
        const candidates = [sid];
        if (/^\d+$/.test(sid)) {
          candidates.push(sid.padStart(6, "0"));
          candidates.push(String(Number(sid)));
        }
        let usedStop = null;
        /** @type {any[]} */
        let rows = [];
        for (const stop of [...new Set(candidates)]) {
          try {
            const res = await fetch(
              `/eta/ctb/eta/CTB/${encodeURIComponent(stop)}/${encodeURIComponent(entry.id)}`,
              { headers: { Accept: "application/json" } },
            );
            if (!res.ok) continue;
            const j = await res.json();
            const list = Array.isArray(j.data) ? j.data : [];
            if (list.length) {
              rows = list;
              usedStop = stop;
              break;
            }
          } catch {
            /* next */
          }
        }
        if (!rows.length) continue;

        // Best ETA per bound at this stop
        /** @type {Map<string, { mins: number|null, dest: string, destZh: string }>} */
        const bestBound = new Map();
        for (const row of rows) {
          const bound = String(row.dir || "O").toUpperCase();
          const mins = waitMinutesFromIso(row.eta);
          const prev = bestBound.get(bound);
          if (
            !prev ||
            (mins != null && (prev.mins == null || mins < prev.mins))
          ) {
            bestBound.set(bound, {
              mins,
              dest: String(row.dest_en || "").trim(),
              destZh: String(row.dest_tc || "").trim(),
            });
          }
        }
        for (const [bound, info] of bestBound) {
          /** @type {EtaNearbyDirSlot} */
          const slot = {
            bound,
            dest: info.dest,
            destZh: info.destZh,
            minutes: info.mins,
            stopLabel: etaStopNameLabel(near) || near.name,
            stopNameEn: near.nameEn || "",
            stopNameTc: near.nameTc || "",
            stopId: usedStop || near.stopId,
            distM: near.d,
            stopLat: Number(near.lat),
            stopLon: Number(near.lon),
            awayScore: 0,
          };
          const prev = pack.byBound.get(bound);
          if (
            !prev ||
            near.d < prev.distM - 5 ||
            (Math.abs(near.d - prev.distM) <= 5 &&
              info.mins != null &&
              (prev.minutes == null || info.mins < prev.minutes))
          ) {
            pack.byBound.set(bound, slot);
          }
        }
      }

      if (pack.byBound.size) {
        await ensureCtbRouteBound(entry.id);
        const od = ctbRouteBoundsMap.get(String(entry.id).toUpperCase()) || [];
        const geo = etaUserGeo
          ? { lat: etaUserGeo.lat, lon: etaUserGeo.lon }
          : null;
        for (const slot of pack.byBound.values()) {
          if (!slot.dest && od.length) {
            const m = od.find(
              (x) => String(x.bound).toUpperCase() === slot.bound,
            );
            if (m) {
              slot.dest = m.dest;
              slot.destZh = m.destZh || "";
            }
          }
          if (geo) {
            slot.awayScore = await scoreCtbDirectionAway(
              entry.id,
              slot.bound,
              geo,
              slot.stopId,
              slot.stopLat,
              slot.stopLon,
            );
          } else {
            slot.awayScore = 0;
          }
        }
        const slots = [...pack.byBound.values()];
        await commitNearbyDirSlots(k, entry, slots);
      } else if (pack.nearStops[0]) {
        const n = pack.nearStops[0];
        entry.nearbyHint = `${n.name} · ${Math.round(n.d)} m`;
      }
    }),
  );

  // Non-CTB: still expose nearest stop as a single slot for consistency
  for (const [k, pack] of byKey) {
    if (pack.entry.co === "ctb") continue;
    if (etaNearbyDirsByKey.has(k)) continue;
    const n = pack.nearStops[0];
    if (!n) continue;
    pack.entry.nearbyHint = `${n.name} · ${Math.round(n.d)} m`;
    // Catalog OD as direction labels when available
    const co = pack.entry.co;
    let dirs = [];
    if (co === "nlb") {
      await ensureNlbRouteBounds();
      dirs = nlbRouteBoundsMap?.get(String(pack.entry.id).toUpperCase()) || [];
    }
    if (dirs.length) {
      const slots = dirs.slice(0, 2).map((d, i) => ({
        bound: d.bound || (i === 0 ? "O" : "I"),
        dest: d.dest || "",
        destZh: d.destZh || "",
        minutes: null,
        stopLabel: etaStopNameLabel(n) || n.name,
        stopNameEn: n.nameEn || "",
        stopNameTc: n.nameTc || "",
        stopId: n.stopId,
        distM: n.d,
        // Without geo termini, keep catalog order (O first)
        awayScore: i === 0 ? 1 : 0,
      }));
      await commitNearbyDirSlots(k, pack.entry, slots);
    }
  }

  const hits = [...byKey.values()]
    .map((p) => p.entry)
    .sort((a, b) => {
      const ma = etaLiveByKey.get(etaRouteKey(a))?.minutes;
      const mb = etaLiveByKey.get(etaRouteKey(b))?.minutes;
      const da =
        etaNearbyDirsByKey.get(etaRouteKey(a))?.[0]?.distM ??
        9999;
      const db =
        etaNearbyDirsByKey.get(etaRouteKey(b))?.[0]?.distM ??
        9999;
      if (ma != null && mb != null && ma !== mb) return ma - mb;
      if (ma != null && mb == null) return -1;
      if (ma == null && mb != null) return 1;
      if (da !== db) return da - db;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    })
    .slice(0, limit);

  const stopNames = topStops
    .slice(0, 2)
    .map((x) => String(x.s[2] || ""))
    .filter(Boolean)
    .join(" · ");
  return {
    hits,
    hint: hits.length
      ? `Near ${stopNames || "you"} · multi-op`
      : "No other operators nearby",
  };
}

/**
 * Nearby KMB stop ETAs → EtaRouteEntry hits with live minutes.
 * Builds per-bound slots (possibly different stops) and prefers the direction
 * that goes farther away from the user.
 * @param {{ lat: number, lon: number }} geo
 * @param {number} [limit]
 */
async function fetchNearbyKmbEtaHits(geo, limit = 16) {
  const stops = await ensureKmbStops();
  if (!stops.length) return { hits: [], hint: "No stop data" };
  await ensureKmbRouteBounds();

  // More stops so opposite-direction bays can be found
  const ranked = stops
    .map((s) => ({
      s,
      d: haversineMEta(geo.lat, geo.lon, s.lat, s.lon),
    }))
    .filter((x) => x.d <= 500)
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);

  if (!ranked.length) {
    return { hits: [], hint: "No bus stops within 500 m" };
  }

  /**
   * routeKey → { entry, byBound: Map bound → EtaNearbyDirSlot }
   * @type {Map<string, { entry: EtaRouteEntry, byBound: Map<string, EtaNearbyDirSlot> }>}
   */
  const byRoute = new Map();

  await Promise.all(
    ranked.map(async ({ s, d }) => {
      try {
        const res = await fetch(
          `/eta/kmb/stop-eta/${encodeURIComponent(s.stop)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const j = await res.json();
        const rows = Array.isArray(j.data) ? j.data : [];
        // Best ETA per route|bound|dest at this stop (S64C AM vs PM share a bound)
        /** @type {Map<string, { row: any, mins: number | null }>} */
        const best = new Map();
        for (const row of rows) {
          const route = String(row.route || "").toUpperCase();
          if (!route) continue;
          const dir = String(row.dir || "O").toUpperCase();
          const destK = etaDestKey(row.dest_en || row.dest_tc);
          const key = `${route}|${dir}|${destK}`;
          const mins = waitMinutesFromIso(row.eta);
          const prev = best.get(key);
          if (
            !prev ||
            (mins != null && (prev.mins == null || mins < prev.mins))
          ) {
            best.set(key, { row, mins });
          }
        }
        for (const { row, mins } of best.values()) {
          const route = String(row.route || "").toUpperCase();
          const co = String(row.co || "KMB").toLowerCase();
          const coU = co === "lwb" ? "lwb" : "kmb";
          const bound = String(row.dir || "O").toUpperCase();
          const entry = {
            id: route,
            label: `${coU === "lwb" ? "LWB" : "KMB"} ${route}`,
            kind: "bus",
            co: coU,
            nearbyHint: `${etaStopNameLabel(s)} · ${Math.round(d)} m`,
          };
          if (!etaKindMatchesFilter(entry)) continue;
          const rk = etaRouteKey(entry);
          /** @type {EtaNearbyDirSlot} */
          const slot = {
            bound,
            dest: String(row.dest_en || "").trim(),
            destZh: String(row.dest_tc || "").trim(),
            minutes: mins,
            stopLabel: etaStopNameLabel(s),
            stopNameEn: s.name_en || s.nameEn || "",
            stopNameTc: s.name_tc || s.nameTc || s.name_zh || "",
            stopId: String(s.stop || ""),
            distM: d,
            stopLat: s.lat,
            stopLon: s.lon,
          };
          let pack = byRoute.get(rk);
          if (!pack) {
            pack = { entry, byBound: new Map() };
            byRoute.set(rk, pack);
          }
          const slotKey = etaDestBoundKey(slot);
          const prev = pack.byBound.get(slotKey);
          // Prefer closer stop for this dest+bound; tie-break sooner ETA
          if (
            !prev ||
            d < prev.distM - 5 ||
            (Math.abs(d - prev.distM) <= 5 &&
              mins != null &&
              (prev.minutes == null || mins < prev.minutes))
          ) {
            pack.byBound.set(slotKey, slot);
          }
        }
      } catch {
        /* ignore stop */
      }
    }),
  );

  // Time-based AM/PM variants (S64C) even when the live feed has dropped
  // the off-window trip: if a nearby stop is on the in-service routing, show it.
  if (kmbRouteBoundsMap) {
    const inject = [];
    for (const [rid] of kmbRouteBoundsMap) {
      if (!/^S\d/i.test(rid) && !/circular|循環|↺/i.test(rid)) continue;
      const entry = {
        id: rid,
        label: `KMB ${rid}`,
        kind: "bus",
        co: "kmb",
      };
      if (!etaKindMatchesFilter(entry)) continue;
      const rk = etaRouteKey(entry);
      if (byRoute.has(rk)) continue;
      const dirs = etaRouteDirectionsFromOd(entry);
      if (!etaHasDepartureSwitch(dirs)) continue;
      inject.push({ rk, entry, dirs });
    }
    await Promise.all(
      inject.slice(0, 24).map(async ({ rk, entry, dirs }) => {
        await Promise.all(dirs.map((d) => hydrateDirSchedule(entry, d)));
        const pref = dirs[etaPreferredDepartureIndex(dirs)] || dirs[0];
        let hit = null;
        for (const d of [pref, ...dirs]) {
          const dirOrder =
            String(d.bound || "O").toUpperCase() === "I"
              ? ["inbound", "outbound"]
              : ["outbound", "inbound"];
          let seq = [];
          for (const direction of dirOrder) {
            seq = await fetchKmbRouteStopList(
              entry.id,
              direction,
              d.serviceType,
            );
            if (seq.length >= 2) break;
          }
          if (seq.length < 2) continue;
          const ids = new Set(seq.map((s) => String(s.stopId)));
          hit = ranked.find((x) => ids.has(String(x.s.stop)));
          if (hit) break;
        }
        if (!hit) return;
        const slot = {
          bound: pref.bound || "O",
          dest: pref.dest || "",
          destZh: pref.destZh || "",
          minutes: null,
          stopLabel: etaStopNameLabel(hit.s),
          stopNameEn: hit.s.name_en || "",
          stopNameTc: hit.s.name_tc || "",
          stopId: String(hit.s.stop || ""),
          distM: hit.d,
          stopLat: hit.s.lat,
          stopLon: hit.s.lon,
          circular: pref.circular,
          variant: pref.variant,
          serviceType: pref.serviceType,
        };
        byRoute.set(rk, {
          entry: {
            ...entry,
            nearbyHint: `${slot.stopLabel} · ${Math.round(hit.d)} m`,
          },
          byBound: new Map([[etaDestBoundKey(slot), slot]]),
        });
      }),
    );
  }

  // Score directions: prefer terminus farther from user (going away)
  /** @type {EtaRouteEntry[]} */
  const hits = [];
  await Promise.all(
    [...byRoute.entries()].map(async ([rk, pack]) => {
      const slots = [...pack.byBound.values()];
      if (!slots.length) return;

      await Promise.all(
        slots.map(async (slot) => {
          slot.awayScore = await scoreKmbDirectionAway(
            pack.entry.id,
            slot.bound,
            geo,
            slot.stopId,
          );
        }),
      );

      // Store O/I order + set card dir to going-away bound (not reordered list)
      await commitNearbyDirSlots(rk, pack.entry, slots);
      hits.push(pack.entry);
    }),
  );

  hits.sort((a, b) => {
    const ma = etaLiveByKey.get(etaRouteKey(a))?.minutes;
    const mb = etaLiveByKey.get(etaRouteKey(b))?.minutes;
    if (ma == null && mb == null)
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    if (ma == null) return 1;
    if (mb == null) return -1;
    return ma - mb;
  });

  const sliced = hits.slice(0, limit);
  const stopNames = ranked
    .slice(0, 2)
    .map((x) => etaStopNameLabel(x.s))
    .join(" · ");
  return {
    hits: sliced,
    hint: sliced.length
      ? `Near ${stopNames} · prefer going away`
      : `Stops nearby · no live ETA`,
  };
}

/**
 * Nearest MTR station served by a line, optionally biased toward the
 * station name already used in a nearby hint.
 * @param {string} line
 * @param {{ lat: number, lon: number }} geo
 * @param {Map<string, { dist: number, station: string }>} [lineNear]
 * @returns {{ best: (typeof MTR_STATIONS)[number] | null, dist: number }}
 */
function nearestMtrStationForLine(line, geo, lineNear) {
  let best = null;
  let bestD = Infinity;
  const hinted = lineNear?.get(line);
  for (const st of MTR_STATIONS) {
    if (!Number.isFinite(st.lat) || !st.code) continue;
    const lines =
      mtrStationLinesMap?.get(String(st.name_en || "").toLowerCase()) || [];
    if (!lines.map((x) => String(x).toUpperCase()).includes(line)) continue;
    const d = haversineMEta(geo.lat, geo.lon, st.lat, st.lon);
    // Prefer the same station name used in nearby hint when close enough
    let score = d;
    if (
      hinted?.station &&
      String(st.name_en || "").toLowerCase() ===
        String(hinted.station).toLowerCase()
    ) {
      score = d * 0.5;
    }
    if (score < bestD) {
      bestD = score;
      best = st;
    }
  }
  return { best, dist: bestD };
}

/**
 * Attach live Next Train ETA for nearby MTR line cards.
 * @param {EtaRouteEntry[]} hits
 * @param {{ lat: number, lon: number }} geo
 * @param {Map<string, { dist: number, station: string }>} lineNear
 */
async function attachNearbyMtrLiveEtas(hits, geo, lineNear) {
  const mtrHits = hits.filter((r) => r.kind === "mtr").slice(0, 10);
  if (!mtrHits.length || !geo) return;
  await ensureMtrStationLinesMap();

  await Promise.all(
    mtrHits.map(async (r) => {
      const line = String(r.id || "").toUpperCase();
      // Prefer station already chosen for this line in browse
      const { best } = nearestMtrStationForLine(line, geo, lineNear);
      if (!best?.code) return;
      const dirs = etaRouteDirections(r, { full: true });
      const di = resolveCardDirIndex(r, dirs);
      const codes = mtrLineCodesInOrder(
        line,
        dirs[di]?.bound || "O",
        dirs[di]?.branch || null,
      );
      const boardCode = String(best.code || "").toUpperCase();
      const bi = codes.indexOf(boardCode);
      const alightCode =
        bi >= 0 && codes.length >= 2
          ? bi >= codes.length - 1
            ? codes[0]
            : codes[codes.length - 1]
          : codes[codes.length - 1] || "";
      const alightLab = alightCode ? mtrStationLabel(alightCode) : null;
      const opt = {
        kind: "mtr",
        etaKind: "mtr",
        route_short_name: line,
        route_name: r.label || line,
        route_id: `MTR-${line}`,
        mode: "subway",
        agency: { id: "MTRR", name: "MTR Rail" },
        from: {
          stop_id: `MTR-${best.code}`,
          id: `MTR-${best.code}`,
          stop_name: best.name_en,
          name: best.name_en,
          station_code: best.code,
          stationCode: best.code,
          code: best.code,
          lat: best.lat,
          lon: best.lon,
          location: { lat: best.lat, lon: best.lon },
        },
        to: alightCode
          ? {
              stop_id: `MTR-${alightCode}`,
              id: `MTR-${alightCode}`,
              stop_name: alightLab?.en || alightCode,
              name: alightLab?.en || alightCode,
              station_code: alightCode,
              stationCode: alightCode,
              code: alightCode,
            }
          : undefined,
      };
      try {
        const result = await fetchBoardEta(opt);
        if (result?.waitMins == null && !result?.etas?.length) return;
        if (result.error && !result.etas?.length) return;
        const first = result.etas?.[0];
        const mins = result.waitMins ?? first?.waitMins ?? null;
        if (mins == null) return;
        const stopLabel = mtrBoardStopLabel(best);
        etaLiveByKey.set(etaRouteKey(r), {
          minutes: mins,
          stopLabel,
          dest: first?.dest || "",
          bound: "line",
          stopId: best.code,
          scheduled: !!first?.scheduled || !!result.scheduled,
          clock: first?.clock || "",
        });
        r.nearbyHint = `${stopLabel} · ${Math.round(
          haversineMEta(geo.lat, geo.lon, best.lat, best.lon),
        )} m`;
      } catch (e) {
        console.warn("[eta] nearby MTR live", line, e);
      }
    }),
  );
}

/**
 * Attach nearest-station board labels to MTR search hits (no live fetch).
 * Search cards need a board stop for terminus-aware direction logic (hide
 * Opposite at EAL/TKL first stations) — same behavior as nearby browse.
 * @param {EtaRouteEntry[]} hits
 * @param {{ lat: number, lon: number }} geo
 */
async function attachMtrSearchBoardLabels(hits, geo) {
  const mtrHits = hits.filter((r) => r.kind === "mtr").slice(0, 10);
  if (!mtrHits.length || !geo) return;
  await ensureMtrStationLinesMap();
  for (const r of mtrHits) {
    const line = String(r.id || "").toUpperCase();
    const { best, dist } = nearestMtrStationForLine(line, geo);
    if (!best?.code) continue;
    const stopLabel = mtrBoardStopLabel(best);
    // Board-only live entry (no minutes): enables first-station hiding and
    // shows the nearest station as the board line; ETAs stay timetable-based.
    etaLiveByKey.set(etaRouteKey(r), {
      stopLabel,
      stopId: best.code,
      bound: "line",
    });
    r.nearbyHint = `${stopLabel} · ${Math.round(dist)} m`;
  }
}

/**
 * Attach live LRT ETA for nearby Light Rail route cards.
 * @param {EtaRouteEntry[]} hits
 * @param {{ lat: number, lon: number }} geo
 */
async function attachNearbyLrtLiveEtas(hits, geo) {
  const lrtHits = hits.filter((r) => r.kind === "lrt").slice(0, 12);
  if (!lrtHits.length || !geo) return;

  // Nearest LRT stop overall (shared board for routes serving it)
  let nearest = null;
  let nearestD = Infinity;
  for (const st of LRT_STOPS) {
    if (!Number.isFinite(st.lat) || !st.stop_id) continue;
    const d = haversineMEta(geo.lat, geo.lon, st.lat, st.lon);
    if (d < nearestD && d <= 4500) {
      nearestD = d;
      nearest = st;
    }
  }
  if (!nearest) return;

  // One station schedule contains all routes — fetch once, split by route_no
  try {
    const baseOpt = {
      kind: "lrt",
      etaKind: "lrt",
      route_short_name: "LRT",
      route_name: "Light Rail",
      route_id: "LRT",
      mode: "tram",
      agency: { id: "LR", name: "Light Rail" },
      from: {
        stop_id: String(nearest.stop_id),
        id: String(nearest.stop_id),
        stop_name: nearest.name_en,
        name: nearest.name_en,
        lat: nearest.lat,
        lon: nearest.lon,
        location: { lat: nearest.lat, lon: nearest.lon },
      },
    };
    // Fetch without route filter by using a dummy then re-fetch per route is heavy;
    // fetchBoardEta filters by route_short_name — so fetch per route (station API is cheap/cached).
    await Promise.all(
      lrtHits.map(async (r) => {
        const opt = {
          ...baseOpt,
          route_short_name: r.id,
          route_name: r.label || r.id,
          route_id: `LRT-${r.id}`,
        };
        try {
          const result = await fetchBoardEta(opt);
          if (result?.waitMins == null && !result?.etas?.length) return;
          if (result.error && !result.etas?.length) return;
          const first = result.etas?.[0];
          const mins = result.waitMins ?? first?.waitMins ?? null;
          if (mins == null) return;
          const stopLabel = nearest.name_zh
            ? `${nearest.name_zh} ${nearest.name_en}`
            : nearest.name_en;
          etaLiveByKey.set(etaRouteKey(r), {
            minutes: mins,
            stopLabel,
            dest: first?.dest || "",
            bound: "lrt",
            stopId: String(nearest.stop_id),
            scheduled: false,
            clock: first?.clock || "",
          });
          r.nearbyHint = `${stopLabel} · ${Math.round(nearestD)} m`;
        } catch {
          /* ignore route */
        }
      }),
    );
  } catch (e) {
    console.warn("[eta] nearby LRT live", e);
  }
}

/**
 * Nearby MTR Bus from open-data stops + live getSchedule.
 * @param {{ lat: number, lon: number }} geo
 * @param {number} [limit]
 */
async function fetchNearbyMtrBusEtaHits(geo, limit = 12) {
  await ensureMtrBusData();
  const near = nearbyMtrBusStops(geo, 500).slice(0, 40);
  if (!near.length) return { hits: [], hint: "" };

  /**
   * @type {Map<string, { entry: EtaRouteEntry, byBound: Map<string, EtaNearbyDirSlot> }>}
   */
  const byRoute = new Map();

  for (const { stop: s, distM } of near) {
    const route = String(s.routeId || "").toUpperCase();
    if (!route) continue;
    const entry = {
      id: route,
      label: `MTR Bus ${route}`,
      kind: "mtr_bus",
      co: "lrtfeeder",
      nearbyHint: `${etaStopNameLabel({ nameEn: s.nameEn, nameTc: s.nameZh, name: s.nameEn }) || s.nameEn} · ${Math.round(distM)} m`,
    };
    if (!etaKindMatchesFilter(entry)) continue;
    const rk = etaRouteKey(entry);
    let pack = byRoute.get(rk);
    if (!pack) {
      pack = { entry, byBound: new Map() };
      byRoute.set(rk, pack);
    }
    const bound = String(s.direction || "O").toUpperCase();
    /** @type {EtaNearbyDirSlot} */
    const slot = {
      bound,
      dest: "",
      destZh: "",
      minutes: null,
      stopLabel: etaStopNameLabel({ nameEn: s.nameEn, nameTc: s.nameZh, name: s.nameEn }) || s.nameEn || s.stopId,
      stopNameEn: s.nameEn || "",
      stopNameTc: s.nameZh || "",
      stopId: s.stopId,
      distM,
      stopLat: s.lat,
      stopLon: s.lon,
    };
    const prev = pack.byBound.get(bound);
    if (!prev || distM < prev.distM - 5) {
      pack.byBound.set(bound, slot);
    }
  }

  // Live ETA per route (one POST covers all stops on the route)
  const packs = [...byRoute.entries()].slice(0, limit);
  await Promise.all(
    packs.map(async ([rk, pack]) => {
      const route = pack.entry.id;
      try {
        const res = await fetch(`/eta/mtr/bus/getSchedule`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ language: "en", routeName: route }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const busStops = Array.isArray(data?.busStop) ? data.busStop : [];
        for (const slot of pack.byBound.values()) {
          const hit = busStops.find(
            (bs) =>
              String(bs.busStopId || "").toUpperCase() ===
              String(slot.stopId || "").toUpperCase(),
          );
          const buses = Array.isArray(hit?.bus) ? hit.bus : [];
          let bestMins = null;
          for (const b of buses) {
            let sec = Number(b.arrivalTimeInSecond);
            if (!Number.isFinite(sec) || sec < 0 || sec >= 100_000) {
              sec = Number(b.departureTimeInSecond);
            }
            if (!Number.isFinite(sec) || sec < 0 || sec >= 100_000) continue;
            const mins = Math.max(0, Math.round(sec / 60));
            if (bestMins == null || mins < bestMins) bestMins = mins;
          }
          if (bestMins != null) slot.minutes = bestMins;
          // Fill dest from OD if empty
          if (!slot.dest) {
            const dirs = mtrBusRouteDirections(route);
            const d = dirs.find(
              (x) => String(x.bound).toUpperCase() === slot.bound,
            );
            if (d) {
              slot.dest = d.dest || "";
              slot.destZh = d.destZh || "";
            }
          }
        }
      } catch (e) {
        console.warn("[eta] mtr bus nearby", route, e);
      }
      // Away score: prefer direction whose terminus is farther
      for (const slot of pack.byBound.values()) {
        if (
          Number.isFinite(slot.stopLat) &&
          Number.isFinite(slot.stopLon) &&
          geo
        ) {
          // crude: farther stop seq end = going away
          const seq = mtrBusStopSequence(route, slot.bound);
          const last = seq[seq.length - 1];
          if (last && Number.isFinite(last.lat)) {
            slot.awayScore = haversineMEta(
              geo.lat,
              geo.lon,
              last.lat,
              last.lon,
            );
          } else {
            slot.awayScore = 0;
          }
        }
      }
      const slots = [...pack.byBound.values()];
      if (slots.length) await commitNearbyDirSlots(rk, pack.entry, slots);
    }),
  );

  const hits = packs
    .map(([, p]) => p.entry)
    .filter((e) => etaLiveByKey.has(etaRouteKey(e)) || true)
    .sort((a, b) => {
      const ma = etaLiveByKey.get(etaRouteKey(a))?.minutes;
      const mb = etaLiveByKey.get(etaRouteKey(b))?.minutes;
      if (ma != null && mb != null && ma !== mb) return ma - mb;
      if (ma != null && mb == null) return -1;
      if (ma == null && mb != null) return 1;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    })
    .slice(0, limit);

  return {
    hits,
    hint: hits.length ? "Nearby MTR Bus · live" : "",
  };
}

/**
 * Soft geo for ETA browse (cached, low urgency).
 * @returns {Promise<{ lat: number, lon: number } | null>}
 */
function ensureEtaUserGeo() {
  if (etaUserGeo && Date.now() - etaUserGeo.at < 120_000) {
    return Promise.resolve({ lat: etaUserGeo.lat, lon: etaUserGeo.lon });
  }
  if (etaGeoPromise) return etaGeoPromise;
  etaGeoPromise = getCurrentPosition({
    enableHighAccuracy: false,
    timeout: 6000,
    maximumAge: 120_000,
  })
    .then((pos) => {
      etaUserGeo = { lat: pos.lat, lon: pos.lon, at: Date.now() };
      return { lat: pos.lat, lon: pos.lon };
    })
    .catch(() => null)
    .finally(() => {
      etaGeoPromise = null;
    });
  return etaGeoPromise;
}

/**
 * On load / Nearby: prefer device location (same intent as map “Current location”).
 * @param {{ fly?: boolean, triggerControl?: boolean }} [opts]
 */
async function bootstrapNearbyUserLocation(opts = {}) {
  const fly = opts.fly !== false;
  try {
    // Prefer MapLibre geolocate (shows accuracy ring) when available
    if (opts.triggerControl !== false && geolocateControl) {
      const once = () => {
        try {
          const ll = map.getCenter?.();
          // geolocate fires moveto user; also read from event if needed
        } catch {
          /* ignore */
        }
      };
      geolocateControl.once?.("geolocate", (ev) => {
        const c = ev?.coords;
        if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
          etaUserGeo = {
            lat: c.latitude,
            lon: c.longitude,
            at: Date.now(),
          };
          if (getUiMode() === "eta") void refreshEtaRouteSuggest();
        }
        once();
      });
      try {
        geolocateControl.trigger();
        return;
      } catch (e) {
        console.warn("[nearby] geolocate trigger", e);
      }
    }
    const geo = await ensureEtaUserGeo();
    if (geo) {
      setNearbyBrowseLocation(geo.lat, geo.lon, { fly });
    }
  } catch (e) {
    console.warn("[nearby] user location", e);
  }
}

// When user uses the locate control, also drive Nearby browse center
geolocateControl.on?.("geolocate", (ev) => {
  const c = ev?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
  // Manual browse point (map click) or route fit on screen: GPS must not
  // reset the override point or yank the camera back — only the locate
  // button re-engages following.
  if (!nearbyGeoFollow) return;
  etaUserGeo = { lat: c.latitude, lon: c.longitude, at: Date.now() };

  // Control’s first frame may ignore current sheet height — re-centre with
  // visual padding so the blue dot sits in the open map, not under the panel.
  syncGeolocateFitPadding();
  try {
    map.easeTo({
      center: [c.longitude, c.latitude],
      zoom: Math.min(Math.max(map.getZoom(), 14.2), 15.8),
      duration: 480,
      padding: mapVisiblePadding(),
    });
  } catch {
    /* ignore */
  }

  if (getUiMode() === "eta") {
    try {
      if (!nearbyBrowseMarker) {
        const el = document.createElement("div");
        el.className = "nearby-browse-pin is-user";
        el.title = "Your location";
        nearbyBrowseMarker = new Marker({ element: el, anchor: "center" })
          .setLngLat([c.longitude, c.latitude])
          .addTo(map);
      } else {
        nearbyBrowseMarker.setLngLat([c.longitude, c.latitude]);
        nearbyBrowseMarker.getElement().classList.add("is-user");
        nearbyBrowseMarker.getElement().title = "Your location";
      }
    } catch {
      /* ignore */
    }
    // Throttle GPS-driven nearby refreshes: skip when the fix moved < 250 m
    // or the last refresh is < 45 s old — list stays fresh without churn.
    const gLast = etaNearbyRefreshGeo;
    const gDist = gLast
      ? haversineMEta(gLast.lat, gLast.lon, c.latitude, c.longitude)
      : Infinity;
    const gAge = gLast ? Date.now() - gLast.at : Infinity;
    if (gDist >= 250 || gAge >= 45_000) {
      etaNearbyRefreshGeo = {
        lat: c.latitude,
        lon: c.longitude,
        at: Date.now(),
      };
      void refreshEtaRouteSuggest();
    }
  }
});

// Also re-pad when user re-taps locate (track mode focus) without a new geolocate event
try {
  const _geoTrigger = geolocateControl.trigger?.bind(geolocateControl);
  if (_geoTrigger) {
    geolocateControl.trigger = () => {
      // Re-engage GPS driving of the map centre / Nearby point
      nearbyGeoFollow = true;
      syncGeolocateFitPadding();
      return _geoTrigger();
    };
  }
} catch {
  /* ignore */
}

/**
 * Empty query browse list.
 * With location: multi-operator nearby (KMB live + CTB/NLB/GMB/MTR Bus index) + MTR/LRT.
 * Without location: multi-operator catalog from route 1.
 * @param {number} [limit]
 * @param {{ skipLiveAttach?: boolean }} [opts]
 *   skipLiveAttach: do not bulk-fetch MTR/LRT live for every hit — visible
 *   cards refresh via IntersectionObserver after paint.
 * @returns {Promise<{ hits: EtaRouteEntry[], hint: string }>}
 */
async function browseEtaRoutes(limit = 28, opts = {}) {
  const skipLiveAttach = opts.skipLiveAttach !== false;
  if (!etaRouteCatalog.length) buildEtaRouteCatalog();
  await ensureMtrStationLinesMap();
  const geo = await ensureEtaUserGeo();
  const filtered = etaRouteCatalog.filter(etaKindMatchesFilter);

  /** @type {EtaRouteEntry[]} */
  const out = [];
  const seen = new Set();
  const push = (r, hint) => {
    if (!r || !etaKindMatchesFilter(r)) return;
    const k = etaRouteKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...r, nearbyHint: hint || r.nearbyHint });
  };

  // Catalog sorted by route id (multi-operator) — fallback only
  const catalogSorted = [...filtered].sort((a, b) => {
    const idCmp = a.id.localeCompare(b.id, undefined, { numeric: true });
    if (a.kind === b.kind && a.co === b.co) return idCmp;
    const order = { mtr: 0, lrt: 1, mtr_bus: 2, bus: 3 };
    const oa = order[a.kind] ?? 9;
    const ob = order[b.kind] ?? 9;
    if (oa !== ob) return oa - ob;
    if ((a.co || "") !== (b.co || ""))
      return String(a.co || "").localeCompare(String(b.co || ""));
    return idCmp;
  });

  if (!geo) {
    // Warm multi-op index + MTR Bus catalog in background
    void ensureEtaNearbyIndex();
    void ensureMtrBusData().then(() => {
      // Rebuild catalog once MTR Bus CSVs arrive (dest names + stop lists)
      if (mtrBusRouteIds().length) buildEtaRouteCatalog();
    });
    void ensureRbsRouteData().then(() => {
      if (!etaRouteCatalog.some((x) => x.co === "rbs")) buildEtaRouteCatalog();
    });
    const hits = catalogSorted.slice(0, limit);
    return {
      hits,
      hint: etaFilterHas("mtr") && etaTrafficModes.size === 1
        ? "All MTR lines · allow location for nearby"
        : "All operators · allow location for nearby routes",
    };
  }

  // Warm MTR Bus open data (catalog may already include fare-pack routes)
  await ensureMtrBusData().catch(() => {});
  if (mtrBusRouteIds().length) buildEtaRouteCatalog();
  // Warm RBS route data (NR/DB residents' bus) and refresh the catalog once
  // it arrives so browse includes RBS without a second visit.
  await ensureRbsRouteData().catch(() => {});
  if (!etaRouteCatalog.some((x) => x.co === "rbs")) buildEtaRouteCatalog();

  // ── Nearby MTR lines ──
  /** @type {Map<string, { dist: number, station: string }>} */
  const lineNear = new Map();
  for (const st of MTR_STATIONS) {
    if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
    const d = haversineMEta(geo.lat, geo.lon, st.lat, st.lon);
    if (d > 2500) continue;
    const lines =
      mtrStationLinesMap?.get(String(st.name_en || "").toLowerCase()) || [];
    for (const code of lines) {
      const c = String(code).toUpperCase();
      const prev = lineNear.get(c);
      if (!prev || d < prev.dist) {
        lineNear.set(c, {
          dist: d,
          station: st.name_en,
          // Browse hint label keeps Chinese (attached live labels already do)
          stationFull: st.name_zh ? `${st.name_zh} ${st.name_en}` : st.name_en,
        });
      }
    }
  }

  let nearLrt = false;
  for (const st of LRT_STOPS) {
    if (!Number.isFinite(st.lat)) continue;
    if (haversineMEta(geo.lat, geo.lon, st.lat, st.lon) <= 4000) {
      nearLrt = true;
      break;
    }
  }

  const onlyMtr = etaTrafficModes.size === 1 && etaTrafficModes.has("mtr");
  const onlyLrt = etaTrafficModes.size === 1 && etaTrafficModes.has("lrt");

  if (etaFilterHas("mtr")) {
    const ranked = [...lineNear.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (const [code, info] of ranked) {
      const entry = filtered.find((r) => r.kind === "mtr" && r.id === code);
      if (entry) {
        push(
          entry,
          `~${Math.round(info.dist)} m · ${info.stationFull || info.station}`,
        );
      }
    }
    if (onlyMtr) {
      for (const r of filtered.filter((x) => x.kind === "mtr")) push(r);
      const mtrHits = out.slice(0, limit);
      // Live ETAs only for on-screen cards (unless caller opts into bulk)
      if (!skipLiveAttach) {
        await attachNearbyMtrLiveEtas(mtrHits, geo, lineNear);
      }
      return {
        hits: mtrHits,
        hint: lineNear.size
          ? `Nearby MTR lines${
              mtrHits.some((r) => etaLiveByKey.has(etaRouteKey(r)))
                ? " · live ETA"
                : ""
            }`
          : "MTR lines (none within 2.5 km)",
      };
    }
  }

  if (etaFilterHas("lrt")) {
    if (nearLrt || onlyLrt) {
      for (const r of filtered.filter((x) => x.kind === "lrt")) {
        push(r, nearLrt ? "Near Light Rail" : undefined);
      }
    }
    if (onlyLrt) {
      const lrtHits = out.slice(0, limit);
      if (nearLrt && !skipLiveAttach) {
        await attachNearbyLrtLiveEtas(lrtHits, geo);
      }
      return {
        hits: lrtHits,
        hint: nearLrt
          ? `Light Rail routes (nearby)${
              lrtHits.some((r) => etaLiveByKey.has(etaRouteKey(r)))
                ? " · live ETA"
                : ""
            }`
          : "All LRT routes",
      };
    }
  }

  // Bus / GMB / MTR Bus: multi-op nearby
  if (etaFilterHas("bus") || etaFilterHas("gmb")) {
    const wantKmb = etaFilterHas("bus");
    const wantMtrBus = etaFilterHas("bus");
    const [nearKmb, nearOther, nearMtrBus] = await Promise.all([
      wantKmb
        ? fetchNearbyKmbEtaHits(geo, Math.min(14, limit))
        : Promise.resolve({ hits: [], hint: "" }),
      fetchNearbyMultiOpHits(geo, Math.min(24, limit)),
      wantMtrBus
        ? fetchNearbyMtrBusEtaHits(geo, Math.min(10, limit))
        : Promise.resolve({ hits: [], hint: "" }),
    ]);

    // Merge and rank: live minutes first, then keep operator diversity near top
    /** @type {EtaRouteEntry[]} */
    const merged = [];
    const mergeSeen = new Set();
    const addMerged = (r) => {
      if (!r || !etaKindMatchesFilter(r)) return;
      const k = etaRouteDedupeKey(r);
      if (mergeSeen.has(k)) {
        const prev = merged.find((x) => etaRouteDedupeKey(x) === k);
        if (prev && isJointBusRoute(r)) {
          const ops = new Set(jointOpsOf(prev));
          ops.add(String(r.co || "").toLowerCase());
          prev.jointOps = [...ops];
          const pm = etaLiveByKey.get(etaRouteKey(prev))?.minutes;
          const rm = etaLiveByKey.get(etaRouteKey(r))?.minutes;
          if (rm != null && (pm == null || rm < pm)) {
            prev.co = r.co;
            prev.label = r.label || prev.label;
            prev.nearbyHint = r.nearbyHint || prev.nearbyHint;
          }
        }
        return;
      }
      mergeSeen.add(k);
      if (isJointBusRoute(r)) r.jointOps = jointOpsOf(r);
      merged.push(r);
    };
    for (const r of nearKmb.hits) addMerged(r);
    for (const r of nearMtrBus.hits) addMerged(r);
    for (const r of nearOther.hits) addMerged(r);

    const etaMins = (r) => etaLiveByKey.get(etaRouteKey(r))?.minutes;
    const sortByEtaThenId = (a, b) => {
      const ma = etaMins(a);
      const mb = etaMins(b);
      if (ma != null && mb != null && ma !== mb) return ma - mb;
      if (ma != null && mb == null) return -1;
      if (ma == null && mb != null) return 1;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    };

    // Round-robin by operator so nearby isn't only KMB at the top
    /** @type {Map<string, EtaRouteEntry[]>} */
    const byCo = new Map();
    for (const r of merged) {
      const co = String(r.co || r.kind || "bus");
      if (!byCo.has(co)) byCo.set(co, []);
      byCo.get(co).push(r);
    }
    for (const arr of byCo.values()) arr.sort(sortByEtaThenId);

    /** @type {EtaRouteEntry[]} */
    const diversified = [];
    const used = new Set();
    const cos = [...byCo.keys()].sort();
    for (let i = 0; i < 8; i++) {
      for (const co of cos) {
        const r = byCo.get(co)?.[i];
        if (!r) continue;
        const k = etaRouteKey(r);
        if (used.has(k)) continue;
        used.add(k);
        diversified.push(r);
        if (diversified.length >= limit) break;
      }
      if (diversified.length >= limit) break;
    }
    if (diversified.length < limit) {
      const rest = merged.filter((r) => !used.has(etaRouteKey(r))).sort(sortByEtaThenId);
      for (const r of rest) {
        diversified.push(r);
        if (diversified.length >= limit) break;
      }
    }

    for (const r of diversified) {
      push(r, r.nearbyHint);
      if (out.length >= limit) break;
    }

    // Catalog fill only if few true nearby hits
    if (out.length < Math.min(8, limit)) {
      for (const r of catalogSorted) {
        if (!etaKindMatchesFilter(r)) continue;
        if (r.kind !== "bus" && r.kind !== "mtr_bus") continue;
        push(r);
        if (out.length >= limit) break;
      }
    }
  }

  // Live rail ETAs: bulk only when requested; default is visible-card refresh
  if (!skipLiveAttach && (etaFilterHas("mtr") || etaFilterHas("lrt"))) {
    await Promise.all([
      etaFilterHas("mtr")
        ? attachNearbyMtrLiveEtas(out, geo, lineNear)
        : Promise.resolve(),
      etaFilterHas("lrt") && nearLrt
        ? attachNearbyLrtLiveEtas(out, geo)
        : Promise.resolve(),
    ]);
  }

  const stName = [...lineNear.values()].sort((a, b) => a.dist - b.dist)[0]
    ?.station;
  const cos = new Set(out.map((r) => r.co || r.kind).filter(Boolean));
  const coList = [...cos]
    .map((c) => String(c).toUpperCase())
    .filter((c) => c !== "BUS")
    .slice(0, 6)
    .join(" · ");
  const hasLive = out.some((r) => {
    const live = etaLiveByKey.get(etaRouteKey(r));
    return live && live.minutes != null && !live.scheduled;
  });
  return {
    hits: out.slice(0, limit),
    hint: out.length
      ? `Nearby ${coList || "routes"}${hasLive ? " · live ETA" : ""}${
          stName ? ` · MTR near ${stName}` : ""
        }`
      : stName
        ? `Near ${stName}${nearLrt ? " · LRT" : ""}`
        : nearLrt
          ? "Near Light Rail"
          : "No nearby routes found",
  };
}

/**
 * Route-like query? Prefer ETA routes until none match, then places.
 * Keeps patterns like 12A / 70M as routes (digit(s) + letter).
 * @param {string} s
 */
function prefersRoutesSearch(s) {
  const q = String(s || "").trim();
  if (!q) return false;
  // "12A", "70M", "96X"
  if (/^\d{1,2}[A-Za-z]/.test(q)) return true;
  // "117", "A21", "K51", "E31", "506"
  if (/^[A-Za-z]?\d/.test(q) || /^\d/.test(q)) return true;
  // Multi-letter prefix routes — RBS residents' buses (NR330, DB01R) and
  // HR/KR-style services: "NR3", "DB01" while typing.
  if (/^[A-Za-z]{2,}\d/i.test(q)) return true;
  // Letter-only ids like "TKL", "EAL" — MTR line codes (falls back to
  // places when no route matches, so place-ish words still work)
  if (/^[A-Za-z]{2,4}$/.test(q)) return true;
  // Very short alphanumeric — route number starting
  if (q.length <= 2 && /^[A-Za-z0-9\u4e00-\u9fff]/.test(q)) return true;
  return false;
}

/**
 * Unified Destination/Route search (Phase 5).
 * @param {string} query
 * @returns {Promise<{ kind: "empty"|"routes"|"places", routes?: EtaRouteEntry[], places?: object[], hint?: string }>}
 */
async function runUnifiedSearch(query) {
  const s = String(query || "").trim();
  if (!s) return { kind: "empty" };

  if (prefersRoutesSearch(s)) {
    // RBS (NR/DB) routes live in a separate static data file — ensure it's
    // loaded before matching so “NR330” finds them on the first keystroke.
    await ensureRbsRouteData();
    const routes = searchEtaRoutes(s, 16);
    if (routes.length) return { kind: "routes", routes };
    // No routes — fall through to places
    try {
      const places = await searchPlaces(s, { limit: 12 });
      return {
        kind: "places",
        places: places || [],
        hint: places?.length ? t("Places") : t("No routes or places for “{q}”", { q: s }),
      };
    } catch (e) {
      console.warn("[search] places fallback", e);
      return { kind: "routes", routes: [], hint: `No routes match “${s}”` };
    }
  }

  // Place-like (CJK names, multi-word, letter without route pattern)
  try {
    const places = await searchPlaces(s, { limit: 12 });
    if (places?.length) return { kind: "places", places, hint: t("Places") };
    // Also try routes as secondary
    const routes = searchEtaRoutes(s, 12);
    if (routes.length) return { kind: "routes", routes };
    return {
      kind: "places",
      places: [],
      hint: t("No places match “{q}”", { q: s }),
    };
  } catch (e) {
    console.warn("[search] places", e);
    const routes = searchEtaRoutes(s, 12);
    return {
      kind: routes.length ? "routes" : "places",
      routes,
      places: [],
      hint: routes.length ? "" : t("Search failed"),
    };
  }
}

/**
 * Pick a place from unified search → Trip Plan with dest filled, origin Current location.
 * @param {{ lat?: number, lon?: number, name?: string, label?: string, isMtr?: boolean, isLrt?: boolean }} place
 */
async function applyPlaceAsTripPlanDest(place) {
  if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) {
    showToast(t("Invalid place"), 1600);
    return;
  }
  const name = place.name || place.label || t("Destination");
  setEtaSearchOpen(false);
  if (els.inputEtaRoute) els.inputEtaRoute.value = "";
  setUiMode("route");
  setSidebarPage("search");
  setDetailOpen(true);

  // Origin = current location (default)
  try {
    const pos = await getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 60_000,
    });
    setPoint("origin", pos.lat, pos.lon, t("Current location"));
  } catch (e) {
    console.warn("[search] geolocation for origin", e);
    showToast(t("Allow location for origin, or set From manually"), 2800);
  }

  setPoint("destination", Number(place.lat), Number(place.lon), name, {
    isMtr: !!place.isMtr,
    isLrt: !!place.isLrt,
  });
  updatePlanButton();
  showToast(t("Trip Plan · to {name}", { name }), 1800);
}

/**
 * Render place hits in the ETA list container (unified search).
 * @param {object[]} places
 * @param {string} [hint]
 */
function renderPlaceSuggest(places, hint = "") {
  const list = els.etaRouteListSidebar;
  if (!list) return;
  etaRouteHits = [];
  etaRouteActive = -1;
  if (!places?.length) {
    list.innerHTML = etaRouteListStatusHtml(
      "empty",
      hint || t("No places found"),
    );
    return;
  }
  list.innerHTML = places
    .map((p, i) => {
      const name = p.name || p.label || t("Place");
      const sub = p.label && p.label !== name ? p.label : p.type || t("Place");
      return `<li role="option" data-place-idx="${i}" class="eta-route-card eta-place-card">
        <div class="eta-route-card-body">
          <div class="eta-card-main">
            <div class="eta-card-route co-place" style="color:var(--accent)">
              <span class="material-symbols-outlined" style="font-size:22px;vertical-align:middle">location_on</span>
            </div>
            <div class="eta-card-dest">
              <span>${escapeHtml(name)}</span>
            </div>
            <div class="eta-card-stop">${escapeHtml(sub)}</div>
          </div>
          <div class="eta-card-eta is-na">
            <span class="eta-card-eta-min" style="font-size:0.75rem">Plan</span>
          </div>
        </div>
      </li>`;
    })
    .join("");
  list.querySelectorAll("li[data-place-idx]").forEach((li) => {
    li.addEventListener("click", () => {
      const idx = Number(li.getAttribute("data-place-idx"));
      const p = places[idx];
      if (p) void applyPlaceAsTripPlanDest(p);
    });
  });
}

/**
 * Typed search: Bus/LRT match id contains query; MTR matches id or line name.
 * @param {string} query
 * @param {number} [limit]
 * @returns {EtaRouteEntry[]}
 */
function searchEtaRoutes(query, limit = 16) {
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (q.length < 1) return [];
  if (!etaRouteCatalog.length) buildEtaRouteCatalog();
  // Simplified-Chinese query form (identity until the zhMap loads): lets
  // zh-cn users type 东涌 while the static aliases already carry both variants.
  const qSimp = simplifyZh(q);
  const qForms = qSimp && qSimp !== q ? [q, qSimp] : [q];

  const scored = [];
  for (const r of etaRouteCatalog) {
    if (!etaKindMatchesFilter(r)) continue;
    const id = r.id.toLowerCase();
    const label = r.label.toLowerCase();
    const aliases = (r.aliases || []).map((a) => String(a).toLowerCase());
    let score = 0;

    if (r.kind === "mtr") {
      // MTR: route id AND line name / aliases (both Chinese variants + English)
      if (id === q) score = 1000;
      else if (id.startsWith(q)) score = 900;
      else if (id.includes(q)) score = 700;
      else if (label === q) score = 950;
      else if (label.startsWith(q)) score = 850;
      else if (label.includes(q)) score = 600;
      else if (aliases.some((a) => qForms.includes(a))) score = 920;
      else if (aliases.some((a) => qForms.some((f) => a.startsWith(f)))) score = 820;
      else if (aliases.some((a) => qForms.some((f) => a.includes(f)))) score = 550;
      else continue;
      if (/^[a-z]{2,4}$/.test(q)) score += 40;
    } else {
      // Bus / LRT / MTR Bus: id contains numbers/letters of query
      if (id === q) score = 1000;
      else if (id.startsWith(q)) score = 850 - Math.min(id.length, 40);
      else if (id.includes(q)) score = 500;
      else if (label.includes(q)) score = 250;
      else continue;
      if (r.kind === "lrt" && /^\d/.test(q)) score += 30;
    }
    scored.push({ r, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.r.id.localeCompare(b.r.id, undefined, { numeric: true }),
  );
  return scored.slice(0, limit).map((s) => s.r);
}

/**
 * Wheels-style card body (no wifi icon). Company color on route number.
 * @param {EtaRouteEntry} r
 * @param {{ dest: string, destZh?: string, bound?: string, orig?: string }} dir
 * @param {{ minutes?: number | null, stopLabel?: string, scheduled?: boolean, clock?: string, stopId?: string, outsideService?: boolean, platforms?: string[] }} [eta]
 * @param {{ destLabel?: string }} [opts] destLabel: display-only destination
 *   (e.g. paired branch termini for EAL/TKL); `dest` stays single so
 *   headway / fare lookups keep matching.
 */
function etaRouteCardInnerHtml(r, dir, eta = {}, opts = {}) {
  const dest = dir.destZh || dir.dest || r.label || "—";
  const destLabel = opts.destLabel || localizeDirLabel(dir, "dest") || dest;
  let stop =
    etaCardStopLine(r, dir, eta) ||
    (dir.orig ? localizeDirLabel(dir, "orig") : "");
  // Platform indicator in the stop line for MTR / LRT (e.g. “金鐘 Admiralty - Platform 7”)
  if (stop && eta.platforms?.length && (r.kind === "mtr" || r.kind === "lrt")) {
    stop = stationNameWithPlatforms(stationBaseName(stop), eta.platforms);
  }
  let mins = eta.minutes;
  let scheduled = !!eta.scheduled;
  let clock = eta.clock || "";
  let outsideService = !!eta.outsideService;

  // No live minutes → headway only inside typical service window (never mid-night invent)
  if ((mins == null || Number.isNaN(Number(mins))) && !clock) {
    if (outsideService) {
      mins = null;
      clock = "";
      scheduled = false;
    } else {
      const slots = headwayTimetableSlots({
        dest: dest === "—" ? "" : dest,
        operator: r.co || r.kind,
        mode: r.kind === "mtr" ? "subway" : r.kind === "lrt" ? "tram" : "bus",
        route: r.id,
        count: 1,
        // RBS: real headway + service window from the TD GTFS data
        headwayMins: dir.headwayMins || undefined,
        first: dir.first != null ? dir.first : undefined,
        last: dir.last != null ? dir.last : undefined,
        maxPerHour: dir.maxPerHour != null ? dir.maxPerHour : undefined,
        overnight: dir.overnight || undefined,
      });
      if (slots[0]) {
        mins = slots[0].waitMins;
        clock = slots[0].clock || "";
        scheduled = true;
      } else if (
        !isTypicalServiceWindow({
          operator: r.co || r.kind,
          mode: r.kind === "mtr" ? "subway" : r.kind === "lrt" ? "tram" : "bus",
          route: r.id,
          first: dir.first != null ? dir.first : undefined,
          last: dir.last != null ? dir.last : undefined,
          overnight: dir.overnight || undefined,
        })
      ) {
        outsideService = true;
      }
    }
  }

  // Bus section fare: board at this card's stop → terminus
  let fareHtml = "";
  const isBus =
    r.kind === "bus" ||
    r.kind === "mtr_bus" ||
    ["kmb", "ctb", "nlb", "lwb", "gmb", "lrtfeeder"].includes(
      String(r.co || "").toLowerCase(),
    );
  if (isBus && stop) {
    const fareHkd = estimateBusBoardToTerminusByStop(
      {
        route_short_name: r.id,
        route_name: r.label || r.id,
        mode: "bus",
        agency: {
          id: String(r.co || "kmb").toUpperCase(),
          name: String(r.co || "kmb").toUpperCase(),
        },
        bound: dir.bound || "",
      },
      {
        name: stop,
        name_en: stop,
        nameEn: stop,
        stop_name: stop,
        // Prefer board stop id when nearby slot has it (name still primary for TD)
        stopId: eta.stopId || r.stopId || "",
      },
      getFareType(),
    );
    if (fareHkd != null) {
      fareHtml = `<div class="eta-card-fare">${escapeHtml(formatHkd(fareHkd))}</div>`;
    }
  }

  const waitLabel = formatWaitMins(mins);
  const isTextWait = waitLabel === "N/A" || waitLabel === "Now";
  const minsText = isTextWait
    ? t(waitLabel)
    : String(Math.max(0, Math.round(Number(mins))));
  const unitText = isTextWait ? "" : t("min");
  const etaClass = outsideService
    ? "is-na is-outside-service"
    : scheduled
      ? "is-scheduled"
      : mins != null && !Number.isNaN(Number(mins)) && Number(mins) <= 0
        ? "is-live is-soon is-now"
        : mins != null && Number(mins) <= 3
          ? "is-live is-soon"
          : mins != null
            ? "is-live"
            : "is-na";
  const color = companyLineColor(r);
  // MTR: colored two-line text (localized line name over English full name);
  // bus / LRT keep the plain company-coloured route number.
  const routeIdHtml =
    r.kind === "mtr"
      ? mtrLineBadgeHtml(r.id, color, r.label, "eta-card-route-mtr eta-card-route-text")
      : isJointBusRoute(r)
        ? `<div class="eta-card-route is-joint" title="${escapeHtml(t("KMB / Citybus"))}">${escapeHtml(r.id)}</div>`
        : `<div class="eta-card-route ${safeCssClass(etaCompanyColorClass(r))}" style="color:${safeCssColor(color, "#888888")}">${escapeHtml(r.id)}</div>`;
  return `
    <div class="eta-card-main">
      ${routeIdHtml}
      <div class="eta-card-dest">
        <span class="eta-card-arrow" aria-hidden="true">→</span>
        <span>${escapeHtml(destLabel)}</span>
      </div>
      ${stop ? `<div class="eta-card-stop">${escapeHtml(stop)}</div>` : ""}
      ${fareHtml}
    </div>
    <div class="eta-card-eta ${etaClass}">
      <span class="eta-card-eta-min">${escapeHtml(minsText)}</span>
      ${unitText ? `<span class="eta-card-eta-unit">${escapeHtml(unitText)}</span>` : ""}
      ${clock && scheduled ? `<span class="eta-card-eta-clock">${escapeHtml(clock)}</span>` : ""}
      ${
        outsideService
          ? `<span class="eta-card-eta-badge is-outside" title="${escapeHtml(t("Outside service hours"))}">${escapeHtml(t("Off"))}</span>`
          : scheduled
            ? `<span class="eta-card-eta-badge" title="${escapeHtml(t("SCHEDULED"))}">${escapeHtml(t("Sched"))}</span>`
            : ""
      }
    </div>`;
}

function etaDirectionDotsHtml(activeDir = 0) {
  const activeIndex = Number.isFinite(activeDir) && Number(activeDir) > 0 ? 1 : 0;
  return `<span class="wheels-dir-dots" aria-hidden="true">
    <i class="${activeIndex === 0 ? "is-on" : ""}"></i>
    <i class="${activeIndex === 1 ? "is-on" : ""}"></i>
  </span>`;
}

/**
 * Opposite on list cards — reverse bound only (not branch cycle).
 * Hidden for MTR when board is first station (auto-suggest away already).
 * @param {EtaRouteEntry} r
 * @param {Array} dirs
 * @param {number} activeDir
 * @param {{ hideOpposite?: boolean }} [opts]
 */
function etaCardDotsHtml(r, dirs, activeDir, opts = {}) {
  const di = Math.min(Math.max(0, activeDir), Math.max(0, dirs.length - 1));
  const depSwitch = etaHasDepartureSwitch(dirs);
  const opp = etaOppositeDirIndex(di, dirs);
  const oppositeHtml =
    opts.hideOpposite || depSwitch
      ? ""
      : !etaHasRealOpposite(dirs) || opp === di
        ? ""
        : `<button type="button" class="wheels-dir-switch eta-card-dir-switch" data-route-key="${escapeHtml(etaRouteKey(r))}" data-action="opposite" aria-label="${escapeHtml(t("Switch direction"))}">
          <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
          <span>${escapeHtml(t("Opposite"))}</span>
          ${etaDirectionDotsHtml(di)}
        </button>`;
  const nextDep = depSwitch ? dirs[etaNextDepartureIndex(di, dirs)] : null;
  const departureHtml =
    !opts.hideOpposite && depSwitch && nextDep
      ? `<button type="button" class="wheels-dir-switch eta-card-dir-switch" data-route-key="${escapeHtml(etaRouteKey(r))}" data-action="departure" aria-label="${escapeHtml(t("Switch Departure"))}" title="${escapeHtml(etaDepartureLabel(nextDep))}">
          <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
          <span>${escapeHtml(t("Switch Departure"))}</span>
          ${etaDirectionDotsHtml(di)}
        </button>`
      : "";

  const branchSibs = etaBranchSiblingIndices(dirs, di);
  const canBranch = branchSibs.length >= 2;
  const nextBr = canBranch ? dirs[etaNextBranchIndex(di, dirs)] : null;
  const branchPair = etaBranchPairLabels(dirs[di], nextBr);
  // List cards can't reliably filter branch trains (mainline-only ETA
  // users): drop the branch switch here. Route detail keeps it for users
  // who explicitly want the branch shape / stop list.
  const branchAllowed = !/^(EAL|TKL)$/i.test(String(r?.id || "").trim());
  const branchHtml = canBranch && branchAllowed
    ? `<button type="button" class="wheels-dir-switch eta-card-dir-switch eta-card-branch-switch" data-route-key="${escapeHtml(etaRouteKey(r))}" data-action="branch" aria-label="${escapeHtml(t("Switch branch"))}" title="${escapeHtml(t("Switch branch: {cur} ⇄ {other}", { cur: String(branchPair.cur), other: String(branchPair.other) }))}">
          <span class="material-symbols-outlined" aria-hidden="true">alt_route</span>
          <span>${escapeHtml(t("Branch"))}</span>
          ${etaBranchLabelsHtml(branchPair)}
        </button>`
    : "";

  const controls = [departureHtml, oppositeHtml, branchHtml].filter(Boolean);
  if (!controls.length) return "";
  return `<div class="eta-card-dir-switches">${controls.join("")}</div>`;
}

/**
 * Build one Nearby/search route card `<li>` HTML.
 * @param {EtaRouteEntry} r
 * @param {number} i
 */
function etaRouteCardLiHtml(r, i) {
  const live = etaLiveByKey.get(etaRouteKey(r));
  const boardLabel = etaBoardLabelClean(
    live?.stopLabel || r.nearbyHint || "",
  );
  const isRail = r.kind === "mtr" || r.kind === "lrt";
  // Rail only: drop “→ same station as board”. Buses keep operator OD as-is.
  let dirs = etaRouteDirections(r, { full: true });
  if (isRail) {
    dirs = etaFilterSameStationDirs(dirs, boardLabel, r);
    if (!dirs.length) dirs = etaRouteDirections(r, { full: true });
  }

  let di = resolveCardDirIndex(r, dirs);
  let hideOpposite = false;

  // MTR: auto-suggest direction away from board; hide Opposite at first station.
  // Without a live board (search without geo) the card shows the direction's
  // first station — treat it as the board so first-station cards hide Opposite.
  const posBoard =
    boardLabel ||
    (dirs[di]?.origZh
      ? `${dirs[di].origZh} ${dirs[di].orig}`
      : dirs[di]?.orig || "");
  if (isRail && r.kind === "mtr" && posBoard && dirs.length >= 1) {
    const boardStop = {
      stationCode: live?.stopId || "",
      code: live?.stopId || "",
      name: posBoard,
    };
    // Prefer a direction where board is first (departing terminus) or middle
    let bestDi = di;
    let bestScore = -1;
    for (let j = 0; j < dirs.length; j++) {
      const pos = etaMtrBoardPosition(r.id, dirs[j], posBoard, boardStop);
      if (pos.index < 0) continue;
      // Last station → wrong way (arriving only); first/middle preferred
      let score = pos.isLast ? 0 : pos.isFirst ? 3 : 2;
      // Prefer user’s stored dir when score ties
      if (j === di) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestDi = j;
      }
    }
    if (bestScore >= 0 && bestDi !== di) {
      di = bestDi;
      setCardDir(r, di);
    }
    const pos = etaMtrBoardPosition(r.id, dirs[di], posBoard, boardStop);
    // At first station of this direction: auto-away already chosen — no Opposite
    // At last station: also hide (should have flipped); intermediate: show
    if (pos.isFirst || pos.isLast || pos.index < 0) {
      hideOpposite = true;
    }
    // If stuck on last (arriving), flip to opposite so we suggest away
    if (pos.isLast && dirs.length >= 2) {
      const opp = etaOppositeDirIndex(di, dirs);
      if (opp !== di) {
        di = opp;
        setCardDir(r, di);
        hideOpposite = true;
      }
    }
  } else if (isRail) {
    const cur = dirs[di];
    if (
      cur &&
      boardLabel &&
      etaStationsMatch(cur.destZh || cur.dest, boardLabel)
    ) {
      di = 0;
      setCardDir(r, di);
    } else {
      const allDirs = etaRouteDirections(r, { full: true });
      const stored = allDirs[getCardDir(r)];
      if (stored) {
        const mapped = dirs.findIndex(
          (d) =>
            String(d.bound || "").toUpperCase() ===
              String(stored.bound || "").toUpperCase() &&
            String(d.branch || "") === String(stored.branch || "") &&
            !etaStationsMatch(d.destZh || d.dest, boardLabel),
        );
        if (mapped >= 0) di = mapped;
        else {
          di = 0;
          setCardDir(r, di);
        }
      }
    }
  }

  const dir = dirs[di] || dirs[0] || { dest: r.label };
  const wantB = String(dir.bound || "").toUpperCase();
  const liveB = String(live?.bound || "").toUpperCase();
  const liveForDir =
    live &&
    (dirs.length < 2 ||
      !wantB ||
      wantB === "LINE" ||
      wantB === "LRT" ||
      liveB === wantB ||
      (!liveB && dirs.length < 2));
  let useDir = dir;
  if (liveForDir && live?.dest) {
    // Rail: ignore live dest if it is the board terminus; buses always trust live
    if (
      !isRail ||
      !boardLabel ||
      !etaStationsMatch(live.destZh || live.dest, boardLabel)
    ) {
      useDir = {
        dest: live.dest,
        destZh: live.destZh || live.dest,
        bound: live.bound || dir.bound,
        branch: dir.branch,
      };
    }
  }
  if (
    isRail &&
    boardLabel &&
    etaStationsMatch(useDir.destZh || useDir.dest, boardLabel)
  ) {
    const alt = dirs.find(
      (d) => !etaStationsMatch(d.destZh || d.dest, boardLabel),
    );
    if (alt) useDir = alt;
  }

  const active = i === etaRouteActive ? "is-active" : "";
  return `<li role="option" data-idx="${i}" class="eta-route-card ${active}" style="--i:${i}" aria-selected="${active ? "true" : "false"}">
    <div class="eta-route-card-body">
      ${etaRouteCardInnerHtml(r, useDir, {
        minutes: liveForDir ? live?.minutes : null,
        stopLabel: liveForDir
          ? live?.stopLabel || r.nearbyHint
          : r.nearbyHint,
        scheduled: liveForDir ? live?.scheduled : false,
        clock: liveForDir ? live?.clock : "",
        stopId: liveForDir ? live?.stopId : "",
        outsideService: liveForDir ? !!live?.outsideService : false,
        platforms: liveForDir ? live?.platforms : undefined,
      }, { destLabel: etaDirectionDisplayLabel(dirs, useDir) })}
    </div>
    ${etaCardDotsHtml(r, dirs, di, { hideOpposite })}
  </li>`;
}

/** @type {IntersectionObserver | null} */
let etaCardLiveObserver = null;
/** @type {Set<string>} */
const etaCardLiveInflight = new Set();
/** @type {Map<string, number>} */
const etaCardLiveLastAt = new Map();
/** Min ms between live fetches for the same card */
const ETA_CARD_LIVE_MIN_MS = 25_000;
/** Current list mode: nearby browse vs typed search */
let etaListMode = /** @type {"nearby" | "search" | null} */ (null);
/** First Nearby browse per session — plays the staggered card entrance once */
let etaNearbyFirstBrowse = true;
/** Manual nearby-location override — replays the staggered card entrance */
let etaNearbyReplayAnimate = false;

function teardownEtaCardLiveObserver() {
  if (etaCardLiveObserver) {
    etaCardLiveObserver.disconnect();
    etaCardLiveObserver = null;
  }
}

/**
 * Live-refresh only cards currently visible in the list viewport.
 * Avoids bulk network for off-screen routes.
 */
function setupEtaCardLiveObserver() {
  teardownEtaCardLiveObserver();
  const list = els.etaRouteListSidebar;
  if (!list || typeof IntersectionObserver === "undefined") return;

  etaCardLiveObserver = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        const li = /** @type {HTMLElement} */ (ent.target);
        const idx = Number(li.getAttribute("data-idx"));
        if (!Number.isFinite(idx) || idx < 0) continue;
        const r = etaRouteHits[idx];
        if (!r) continue;
        void maybeRefreshVisibleCardLive(r, idx);
      }
    },
    {
      root: list,
      rootMargin: "48px 0px",
      threshold: 0.12,
    },
  );

  list.querySelectorAll("li[data-idx]").forEach((li) => {
    etaCardLiveObserver?.observe(li);
  });
}

/**
 * @param {EtaRouteEntry} r
 * @param {number} idx
 */
async function maybeRefreshVisibleCardLive(r, idx) {
  if (!r || getUiMode() !== "eta") return;
  // Only auto-live on nearby browse (search list may not have board stops)
  if (etaListMode !== "nearby") return;
  const key = etaRouteKey(r);
  const now = Date.now();
  const last = etaCardLiveLastAt.get(key) || 0;
  if (now - last < ETA_CARD_LIVE_MIN_MS) return;
  if (etaCardLiveInflight.has(key)) return;

  etaCardLiveInflight.add(key);
  etaCardLiveLastAt.set(key, now);
  try {
    const prev = etaLiveByKey.get(key);
    const prevSnap = prev
      ? `${prev.minutes}|${prev.dest || ""}|${prev.bound || ""}|${prev.scheduled ? 1 : 0}|${prev.stopLabel || ""}`
      : "";
    const ok = await refreshCardLiveEta(r, { silent: true });
    if (!ok) return;
    const next = etaLiveByKey.get(key);
    const nextSnap = next
      ? `${next.minutes}|${next.dest || ""}|${next.bound || ""}|${next.scheduled ? 1 : 0}|${next.stopLabel || ""}`
      : "";
    if (prevSnap === nextSnap) return;
    // List may have changed while fetching
    const still =
      etaRouteHits[idx] === r ||
      etaRouteKey(etaRouteHits[idx] || {}) === key;
    if (!still) {
      const ni = etaRouteHits.findIndex((x) => etaRouteKey(x) === key);
      if (ni < 0) return;
      patchEtaRouteCardAt(ni);
      return;
    }
    patchEtaRouteCardAt(idx);
  } finally {
    etaCardLiveInflight.delete(key);
  }
}

/**
 * Update a single card in-place (no full list wipe / no scroll jump).
 * @param {number} idx
 */
function patchEtaRouteCardAt(idx) {
  const list = els.etaRouteListSidebar;
  const r = etaRouteHits[idx];
  if (!list || !r) return;
  const li = list.querySelector(`li[data-idx="${idx}"]`);
  if (!li) return;
  const tmp = document.createElement("ul");
  tmp.innerHTML = etaRouteCardLiHtml(r, idx);
  const next = tmp.firstElementChild;
  if (!next) return;
  // Rebind handlers by replacing node then attaching to this card only
  li.replaceWith(next);
  bindEtaRouteCardEvents(next);
  // Keep observing the new node
  etaCardLiveObserver?.observe(next);
}

/**
 * @param {Element} li
 */
function bindEtaRouteCardEvents(li) {
  if (!(li instanceof HTMLElement)) return;
  li.addEventListener("click", (e) => {
    // Opposite handled on its own button
    if (e.target.closest?.(".eta-card-dir-switch, .wheels-dir-switch")) return;
    const idx = Number(li.getAttribute("data-idx"));
    etaRouteActive = idx;
    selectEtaRoute(etaRouteHits[idx], idx);
  });

  li.querySelectorAll(".eta-card-dir-switch").forEach((switchBtn) => {
    switchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(li.getAttribute("data-idx"));
      const r = etaRouteHits[idx];
      if (!r) return;

      const action = switchBtn.getAttribute("data-action") || "opposite";

      // Same dir set as the card render (rail filters same-station dests)
      const boardLabel = etaBoardLabelClean(
        etaLiveByKey.get(etaRouteKey(r))?.stopLabel || r.nearbyHint || "",
      );
      const isRail = r.kind === "mtr" || r.kind === "lrt";
      let dirs = etaRouteDirections(r, { full: true });
      if (isRail) {
        const filtered = etaFilterSameStationDirs(dirs, boardLabel, r);
        if (filtered.length) dirs = filtered;
      }
      if (dirs.length < 2) return;

      const cur = resolveCardDirIndex(r, dirs);
      let next = cur;
      if (action === "branch") {
        const branchSibs = etaBranchSiblingIndices(dirs, cur);
        if (branchSibs.length < 2) return;
        next = etaNextBranchIndex(cur, dirs);
      } else if (action === "departure") {
        if (!etaHasDepartureSwitch(dirs)) return;
        next = etaNextDepartureIndex(cur, dirs);
      } else {
        if (!etaHasRealOpposite(dirs) || etaHasDepartureSwitch(dirs)) return;
        // Opposite = reverse only (To Tsuen Wan → To Central), not branch cycle
        next = etaOppositeDirIndex(cur, dirs);
      }
      if (next === cur) return;

      const to = dirs[next];
      if (r.kind === "mtr" && to?.branch) {
        etaDetailMtrBranchOverride = String(to.branch).toUpperCase();
      } else if (r.kind === "mtr") {
        etaDetailMtrBranchOverride = null;
      }

      setCardDir(r, next);
      syncDirChoiceToLive(r, next, dirs);
      etaRouteActive = idx;
      // Instant UI (dest + dots); live minutes refresh after
      patchEtaRouteCardAt(idx);
      syncEtaActive();

      void refreshCardLiveEta(r, { silent: true, force: true }).then(() => {
        if (
          etaRouteHits[idx] !== r &&
          etaRouteKey(etaRouteHits[idx] || {}) !== etaRouteKey(r)
        ) {
          return;
        }
        applyNearbyDirLive(r);
        patchEtaRouteCardAt(idx);
        syncEtaActive();
      });

      if (
        etaSelectedForDetails &&
        etaRouteKey(etaSelectedForDetails) === etaRouteKey(r) &&
        sidebarPage === "eta-route"
      ) {
        etaSelectedForDetails = r;
        void showEtaRouteDetailsPanel();
      }
    });
  });
}

/**
 * Status panel for the ETA route list (loading / empty / error).
 * @param {"loading"|"empty"|"error"} status
 * @param {string} [message]
 */
function etaRouteListStatusHtml(status, message = "") {
  if (status === "loading") {
    return `<li class="eta-route-status is-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="eta-route-status-spinner" aria-hidden="true"></span>
      <span class="sr-only">${escapeHtml(message || t("Loading routes…"))}</span>
    </li>`;
  }
  if (status === "error") {
    return `<li class="eta-route-status is-error" role="alert">
      <span class="material-symbols-outlined eta-route-status-icon" aria-hidden="true">error</span>
      <span class="eta-route-status-title">${escapeHtml(message || t("Couldn’t load routes"))}</span>
      <span class="eta-route-status-sub">${escapeHtml(t("Check your connection and try again"))}</span>
    </li>`;
  }
  // empty / not found
  return `<li class="eta-route-status is-empty" role="status">
    <span class="material-symbols-outlined eta-route-status-icon" aria-hidden="true">search_off</span>
    <span class="eta-route-status-title">${escapeHtml(message || t("No routes found"))}</span>
    <span class="eta-route-status-sub">${escapeHtml(t("Try another filter or search term"))}</span>
  </li>`;
}

/**
 * Reverse stagger on the current Nearby cards (manual location override).
 * Resolves once the exit has finished so the spinner can replace the cards.
 */
function animateEtaCardsExit() {
  const list = els.etaRouteListSidebar;
  if (!list || !list.querySelector("li.eta-route-card")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    list.classList.add("is-exiting");
    // Exit lasts ~0.58s (delay cap 8×35ms + 0.3s anim) — wait past it
    window.setTimeout(() => {
      list.classList.remove("is-exiting");
      resolve();
    }, 650);
  });
}

/**
 * @param {EtaRouteEntry[]} hits
 * @param {string} [hint]
 * @param {{ skipPrefetch?: boolean, status?: "loading"|"empty"|"error", mode?: "nearby"|"search" }} [opts]
 */
function renderEtaRouteSuggest(hits, hint = "", opts = {}) {
  const list = els.etaRouteListSidebar;
  if (!list) return;

  if (opts.mode === "nearby" || opts.mode === "search") {
    etaListMode = opts.mode;
  }

  if (opts.status === "loading") {
    teardownEtaCardLiveObserver();
    etaRouteHits = [];
    etaRouteActive = -1;
    list.innerHTML = etaRouteListStatusHtml(
      "loading",
      hint || "Loading routes…",
    );
    return;
  }
  if (opts.status === "error") {
    teardownEtaCardLiveObserver();
    etaRouteHits = [];
    etaRouteActive = -1;
    if (opts.mode === "nearby") etaNearbyReplayAnimate = false;
    list.innerHTML = etaRouteListStatusHtml("error", hint || "Couldn’t load routes");
    return;
  }

  etaRouteHits = hits;
  // Keep selection index if still in range; do not auto-select 0
  if (etaRouteActive >= hits.length) etaRouteActive = hits.length ? 0 : -1;

  // Prefetch CTB/NLB OD so cards don't reuse KMB destinations for same #
  if (
    !opts.skipPrefetch &&
    hits.some(
      (r) =>
        r.co === "ctb" ||
        r.co === "nlb" ||
        r.co === "gmb" ||
        r.kind === "lrt",
    )
  ) {
    void prefetchEtaDirections(hits).then(() => {
      // Re-render once OD arrives (skipPrefetch to avoid loop)
      if (etaRouteHits === hits) {
        renderEtaRouteSuggest(hits, hint, {
          skipPrefetch: true,
          mode: etaListMode || undefined,
        });
      }
    });
  }

  if (!hits.length) {
    teardownEtaCardLiveObserver();
    if (opts.mode === "nearby") etaNearbyReplayAnimate = false;
    list.innerHTML = etaRouteListStatusHtml(
      "empty",
      hint && /no |not found|none/i.test(hint)
        ? hint
        : "No routes found",
    );
    return;
  }

  // First Nearby browse per session, or a manual location override:
  // stagger cards in (search stays instant)
  const firstNearby =
    opts.mode === "nearby" &&
    hits.length > 0 &&
    (etaNearbyFirstBrowse || etaNearbyReplayAnimate);
  if (firstNearby) {
    etaNearbyFirstBrowse = false;
    etaNearbyReplayAnimate = false;
  }
  list.innerHTML = hits.map((r, i) => etaRouteCardLiHtml(r, i)).join("");

  if (firstNearby) {
    list.classList.add("is-first-browse");
    // Let later re-renders (prefetch OD, soft refresh) skip the animation
    window.setTimeout(() => list.classList.remove("is-first-browse"), 1200);
  }

  list.querySelectorAll("li[data-idx]").forEach((li) => {
    bindEtaRouteCardEvents(li);
  });

  // Live ETA only for on-screen cards (nearby browse)
  if (etaListMode === "nearby") {
    setupEtaCardLiveObserver();
  } else {
    teardownEtaCardLiveObserver();
  }
}

/** Generation so stale browse results don’t overwrite a newer search. */
let etaSuggestGen = 0;

/** Refresh sidebar list from current toolbar input + filter. */
async function refreshEtaRouteSuggest() {
  if (getUiMode() !== "eta") return;
  const gen = ++etaSuggestGen;
  const q = String(els.inputEtaRoute?.value || "").trim();

  if (q.length >= 1) {
    // Unified Destination/Route search (Phase 5)
    etaNearbyDirsByKey.clear();
    // Soft: keep previous cards while typing; only flash loading if list empty
    const softSearch = etaRouteHits.length > 0;
    etaListMode = "search";
    if (!softSearch) {
      renderEtaRouteSuggest([], t("Searching…"), {
        status: "loading",
        mode: "search",
      });
    }
    try {
      await ensureKmbRouteBounds();
      if (gen !== etaSuggestGen || getUiMode() !== "eta") return;
      if (String(els.inputEtaRoute?.value || "").trim() !== q) return;
      const result = await runUnifiedSearch(q);
      if (gen !== etaSuggestGen || getUiMode() !== "eta") return;
      if (String(els.inputEtaRoute?.value || "").trim() !== q) return;

      if (result.kind === "routes") {
        const hits = result.routes || [];
        // MTR search cards need a board stop for terminus-aware direction
        // logic (hide Opposite at EAL/TKL first stations) — same as nearby.
        if (etaUserGeo && hits.some((r) => r.kind === "mtr")) {
          await attachMtrSearchBoardLabels(hits, {
            lat: etaUserGeo.lat,
            lon: etaUserGeo.lon,
          });
          if (gen !== etaSuggestGen || getUiMode() !== "eta") return;
          if (String(els.inputEtaRoute?.value || "").trim() !== q) return;
        }
        renderEtaRouteSuggest(
          hits,
          hits.length ? result.hint || "" : result.hint || t("No routes match “{q}”", { q }),
          hits.length ? { mode: "search" } : { status: "empty", mode: "search" },
        );
      } else if (result.kind === "places") {
        teardownEtaCardLiveObserver();
        etaListMode = "search";
        const places = result.places || [];
        renderPlaceSuggest(
          places,
          places.length
            ? result.hint || t("Places · tap to plan trip")
            : result.hint || t("No places match “{q}”", { q }),
        );
      } else {
        renderEtaRouteSuggest([], t("Enter a Destination/Route"), {
          status: "empty",
          mode: "search",
        });
      }
    } catch (e) {
      console.warn("[eta] search", e);
      if (gen !== etaSuggestGen) return;
      renderEtaRouteSuggest([], t("Search failed"), {
        status: "error",
        mode: "search",
      });
    }
    return;
  }

  // Empty search field — nearby browse
  // Soft refresh: keep existing cards (no “Loading nearby routes…” flash).
  // Live ETAs for visible cards only run via IntersectionObserver after paint.
  // Manual location override: cards fall out (reverse stagger), then the
  // spinner shows while the new location's routes load.
  const overrideThisRefresh = etaNearbyReplayAnimate;
  if (overrideThisRefresh) {
    await animateEtaCardsExit();
    // A search may have started while the exit played — never clobber it
    if (gen !== etaSuggestGen || getUiMode() !== "eta") return;
  }
  const softNearby =
    etaListMode === "nearby" &&
    etaRouteHits.length > 0 &&
    !els.etaRouteListSidebar?.querySelector(".eta-route-status.is-loading");

  if (!softNearby || overrideThisRefresh) {
    etaNearbyDirsByKey.clear();
    renderEtaRouteSuggest([], t("Loading nearby routes…"), {
      status: "loading",
      mode: "nearby",
    });
  } else {
    etaListMode = "nearby";
    // Keep direction slots so Opposite / live cache survive soft geo/filter churn
  }

  try {
    await Promise.all([
      ensureKmbRouteBounds(),
      ensureKmbStops(),
      ensureMtrBusData().catch(() => {}),
      ensureLrtRouteData().catch(() => {}),
    ]);
    if (gen !== etaSuggestGen || getUiMode() !== "eta") return;
    if (String(els.inputEtaRoute?.value || "").trim().length >= 1) return;
    // Discover nearby routes; defer bulk MTR/LRT live — visible cards refresh
    const { hits, hint } = await browseEtaRoutes(28, { skipLiveAttach: true });
    if (gen !== etaSuggestGen || getUiMode() !== "eta") return;
    if (String(els.inputEtaRoute?.value || "").trim().length >= 1) return;
    if (!hits.length) {
      renderEtaRouteSuggest([], hint || t("No nearby routes"), {
        status: "empty",
        mode: "nearby",
      });
    } else {
      // Allow visible cards a live pass for this location / result set
      etaCardLiveLastAt.clear();
      renderEtaRouteSuggest(hits, hint, { mode: "nearby" });
    }
  } catch (e) {
    console.warn("[eta] browse", e);
    if (gen !== etaSuggestGen) return;
    // Soft: keep stale cards on network blip — but never after an override
    // (those cards already animated out and were replaced by the spinner)
    if (softNearby && etaRouteHits.length && !overrideThisRefresh) return;
    renderEtaRouteSuggest([], t("Couldn’t load nearby routes"), {
      status: "error",
      mode: "nearby",
    });
  }
}

/** @type {EtaRouteEntry | null} */
let etaSelectedForDetails = null;
/** @type {Array<{ seq: number, name: string, stopId?: string, lon?: number, lat?: number }>} */
let etaSelectedStops = [];
/**
 * Cached ETA map geometry so board-stop progress can update without re-fetch.
 * @type {{
 *   coords: number[][],
 *   color: string,
 *   routeId: string,
 *   stops: Array<{ lon: number, lat: number, name?: string, stopId?: string, seq?: number, _polylineOnly?: boolean }>,
 * } | null}
 */
let etaMapGeomCache = null;

/**
 * Index of nearest polyline vertex to a lon/lat.
 * @param {number[][]} coords
 * @param {number} lon
 * @param {number} lat
 */
function nearestLineVertexIndex(coords, lon, lat) {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const d = haversineMEta(lat, lon, c[1], c[0]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

/**
 * Map each stop to a polyline vertex, searching only forward so circular
 * routes that revisit the same lat/lon (S64 airport loop) use the N-th visit.
 * Far-ahead vertices are penalised by 30% of their distance-along gap beyond
 * a 1500 m free zone: on a loop the closure brings vertices back near the
 * terminus, and a raw nearest-vertex search lets early stops snap onto the
 * return leg — the cut then lands at the loop end and almost the whole route
 * greys out. The free zone keeps the penalty from biasing a real visit that
 * sits a few hundred metres ahead of the search floor.
 * @param {number[][]} lineCoords
 * @param {Array<{ lon: number, lat: number }>} named
 * @param {number[]} cum cumulative distance along the polyline (metres)
 * @returns {number[]} vertex index per stop
 */
function projectStopsOntoLineMonotonic(lineCoords, named, cum) {
  /** @type {number[]} */
  const verts = [];
  let searchFrom = 0;
  const n = lineCoords.length;
  for (const s of named) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) {
      verts.push(searchFrom);
      continue;
    }
    let bestI = searchFrom;
    let bestScore = Infinity;
    for (let i = searchFrom; i < n; i++) {
      const c = lineCoords[i];
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const d = haversineMEta(s.lat, s.lon, c[1], c[0]);
      // Nearest wins, but vertices far ahead of the previous visit pay a
      // distance penalty (1500 m free zone) so the closure of a circular
      // route cannot beat the stop's real (earlier) visit.
      const score = d + Math.max(0, cum[i] - cum[searchFrom] - 1500) * 0.3;
      if (score < bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    verts.push(bestI);
    // Advance so the next identical stop matches a later path vertex
    searchFrom = Math.min(bestI + 1, n - 1);
  }
  return verts;
}

/**
 * Project lon/lat onto segment a→b (equirectangular, metres) — returns the
 * projected point and distance.
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} lon
 * @param {number} lat
 */
function projectLonLatOnSegment(a, b, lon, lat) {
  const cos = Math.cos((((a[1] + b[1] + lat) / 3) * Math.PI) / 180);
  const ax = a[0] * cos;
  const ay = a[1];
  const bx = b[0] * cos;
  const by = b[1];
  const px = lon * cos;
  const py = lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return null;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qlon = a[0] + (b[0] - a[0]) * t;
  const qlat = a[1] + (b[1] - a[1]) * t;
  const dLat = (lat - qlat) * (Math.PI / 180);
  const dLon = (lon - qlon) * (Math.PI / 180);
  return {
    lon: qlon,
    lat: qlat,
    d: 6371000 * Math.hypot(dLat, dLon * Math.cos((lat * Math.PI) / 180)),
  };
}

/**
 * Cut a decimated polyline exactly at the board stop: a monotonic scan of the
 * segments at or after the previous stop's vertex (floorAlong) takes the
 * segment-level projection closest to the stop, so the grey boundary lands on
 * the stop instead of the nearest (~100 m+) vertex. Segments far ahead of the
 * floor pay a distance penalty (1500 m free zone) so a circular route's
 * closure cannot beat the real visit. Falls back to null when nothing fits.
 * @param {number[][]} lineCoords
 * @param {{ lon?: number, lat?: number }} stop
 * @param {number[]} cumArr cumulative distance along the polyline (metres)
 * @param {number} floorAlong lower bound (metres) — previous stop's vertex
 * @returns {{ passed: number[][], remaining: number[][] } | null}
 */
function refineEtaCutAtStop(lineCoords, stop, cumArr, floorAlong) {
  if (!lineCoords?.length || !stop) return null;
  let best = null;
  for (let i = 0; i < lineCoords.length - 1; i++) {
    if (cumArr[i + 1] + 1 < floorAlong) continue;
    const ca = lineCoords[i];
    const cb = lineCoords[i + 1];
    if (!ca || !cb || !Number.isFinite(ca[0]) || !Number.isFinite(cb[0])) {
      continue;
    }
    const p = projectLonLatOnSegment(ca, cb, stop.lon, stop.lat);
    if (!p) continue;
    // Nearest wins, but segments far ahead of the previous stop's vertex pay
    // a distance penalty (1500 m free zone) so a loop closure cannot beat
    // the stop's real visit.
    const ahead = Math.max(0, cumArr[i] - floorAlong);
    const score = p.d + Math.max(0, ahead - 1500) * 0.3;
    if (!best || score < best.score) best = { ...p, i, score };
  }
  if (!best || best.d > 400) return null;
  const pt = [best.lon, best.lat];
  return {
    passed: lineCoords.slice(0, best.i + 1).concat([pt]),
    remaining: [pt].concat(lineCoords.slice(best.i + 1)),
  };
}

/**
 * Split full route polyline at the selected board stop (same idea as list is-before).
 * Circular-safe: revisits use monotonic projection, not nearest-first.
 * @param {number[][]} lineCoords
 * @param {Array<{ lon?: number, lat?: number, _polylineOnly?: boolean }>} stops
 * @param {number} boardIndex index into named (non-polylineOnly) stops
 * @returns {{ passed: number[][], remaining: number[][] }}
 */
function splitEtaLineAtBoard(lineCoords, stops, boardIndex) {
  const named = (stops || []).filter(
    (s) =>
      !s._polylineOnly &&
      Number.isFinite(s.lon) &&
      Number.isFinite(s.lat),
  );
  if (!lineCoords?.length || named.length < 2) {
    return { passed: [], remaining: lineCoords?.slice() || [] };
  }
  const bi = Math.max(0, Math.min(boardIndex | 0, named.length - 1));
  if (bi <= 0) {
    return { passed: [], remaining: lineCoords.slice() };
  }

  // Chord line = one vertex per stop → split at stop index
  if (lineCoords.length === named.length) {
    return {
      passed: lineCoords.slice(0, bi + 1),
      remaining: lineCoords.slice(bi),
    };
  }

  // Dense path (circular-safe): project every stop forward, cut at board visit.
  // Cumulative distance along the polyline (metres) — shared by the vertex
  // search's far-ahead penalty and the segment cut's monotonic floor.
  const cum = [0];
  for (let i = 1; i < lineCoords.length; i++) {
    const a = lineCoords[i - 1];
    const b = lineCoords[i];
    cum.push(
      cum[i - 1] +
        (Number.isFinite(a?.[0]) && Number.isFinite(b?.[0])
          ? haversineMEta(a[1], a[0], b[1], b[0])
          : 0),
    );
  }
  const verts = projectStopsOntoLineMonotonic(lineCoords, named, cum);
  const vi =
    verts[bi] ??
    nearestLineVertexIndex(lineCoords, named[bi].lon, named[bi].lat);
  const cut = refineEtaCutAtStop(
    lineCoords,
    named[bi],
    cum,
    bi > 0 ? cum[verts[bi - 1]] : 0,
  );
  if (cut) return cut;
  return {
    passed: lineCoords.slice(0, vi + 1),
    remaining: lineCoords.slice(vi),
  };
}

/**
 * Apply passed/remaining line + stop colours for ETA board index.
 * Uses etaMapGeomCache from the last paintEtaRouteOnMap.
 * @param {number} boardIndex
 * @param {{ fit?: boolean }} [opts]
 */
function applyEtaRouteProgressOnMap(boardIndex, opts = {}) {
  if (!map?.getStyle || !etaMapGeomCache) return;
  ensureRouteLayers();
  const { coords, color, stops } = etaMapGeomCache;
  if (!coords?.length) return;

  const named = (stops || []).filter(
    (s) =>
      !s._polylineOnly &&
      Number.isFinite(s.lon) &&
      Number.isFinite(s.lat),
  );
  const bi = Math.max(
    0,
    Math.min(
      Number.isFinite(boardIndex) ? boardIndex : 0,
      Math.max(0, named.length - 1),
    ),
  );

  const { passed, remaining } = splitEtaLineAtBoard(coords, stops, bi);
  /** @type {object[]} */
  const lineFeats = [];
  // Draw remaining first so it can sit under; actually draw passed under remaining
  if (passed.length >= 2) {
    lineFeats.push({
      type: "Feature",
      properties: {
        kind: "transit",
        color,
        passed: true,
        passed_color: mixTowardWhite(color),
        route: etaMapGeomCache.routeId,
      },
      geometry: { type: "LineString", coordinates: passed },
    });
  }
  if (remaining.length >= 2) {
    lineFeats.push({
      type: "Feature",
      properties: {
        kind: "transit",
        color,
        passed: false,
        route: etaMapGeomCache.routeId,
      },
      geometry: { type: "LineString", coordinates: remaining },
    });
  } else if (coords.length >= 2 && !lineFeats.length) {
    lineFeats.push({
      type: "Feature",
      properties: { kind: "transit", color, passed: false },
      geometry: { type: "LineString", coordinates: coords },
    });
  }

  const stopFeats = named.map((s, i) => {
    const isBoard = i === bi;
    const isPassed = i < bi;
    const label = s.name || `Stop ${i + 1}`;
    return {
      type: "Feature",
      properties: {
        name: label,
        stop_name: label,
        stop_id: s.stopId || "",
        stop_index: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i + 1,
        seq: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i + 1,
        role: isBoard ? "board" : isPassed ? "passed" : "via",
        passed: isPassed,
        color,
        // Passed stops: opaque route colour lightened toward white (no grey)
        ...(isPassed ? { passed_color: mixTowardWhite(color) } : {}),
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    };
  });

  const lineSrc = map.getSource("route-line");
  const stopSrc = map.getSource("route-stops");
  if (!lineSrc || !stopSrc) return;

  lineSrc.setData({ type: "FeatureCollection", features: lineFeats });
  stopSrc.setData({ type: "FeatureCollection", features: stopFeats });

  try {
    for (const id of [
      "route-line-casing",
      "route-line-main",
      "route-stops-circle",
      "route-stops-label",
    ]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", "visible");
        map.moveLayer(id);
      }
    }
  } catch {
    /* ignore */
  }
  // Progress redraw just pulled the route/stops to the top — put live buses
  // back above them (stop-tap used to bury the markers under the line).
  promoteBusPosLayers();

  if (opts.fit && coords.length >= 2) {
    fitMapToRouteCoords(coords, { maxZoom: 15, duration: 900 });
  }
}

/**
 * Animate camera to route path, padded for the visible map (sheet/dock).
 * @param {number[][]} coords [lon,lat][]
 * @param {{ duration?: number, maxZoom?: number }} [opts]
 */
function netFitPadding(desired = {}) {
  // MapLibre's cameraForBounds ADDS the transform's persisted padding (left
  // behind by any earlier easeTo/flyTo that carried padding, e.g. the nearby
  // override ease) to the requested padding; when the two together exceed
  // the canvas it returns undefined and cameraForBounds AND fitBounds both
  // silently no-op ("map stays put"). Request only the difference above the
  // current padding so the total inset is what we actually want.
  const cur = map.getPadding?.() ?? {};
  const out = {};
  for (const k of ["top", "bottom", "left", "right"]) {
    out[k] = Math.max(0, (desired[k] ?? 0) - (cur[k] ?? 0));
  }
  return out;
}

function fitMapToRouteCoords(coords, opts = {}) {
  if (!map || !coords?.length) return;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const c of coords) {
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLon) || minLon === Infinity) return;
  // Pad degenerate single-point bounds slightly so fitBounds always animates
  if (minLon === maxLon) {
    minLon -= 0.008;
    maxLon += 0.008;
  }
  if (minLat === maxLat) {
    minLat -= 0.008;
    maxLat += 0.008;
  }

  const run = () => {
    try {
      if (!map?.getStyle?.()) return;
      // stop()+resize() disengage a live locate lock (it would otherwise
      // re-centre on the user at the next position fix, undoing the fit).
      disengageGeolocateFollow();
      const bounds = [
        [minLon, minLat],
        [maxLon, maxLat],
      ];
      const padding = netFitPadding(
        mapVisiblePadding({
          top: 28,
          right: 8,
          bottom: 20,
          left: 8,
        })
      );
      const duration = opts.duration ?? 900;
      const maxZoom = opts.maxZoom ?? 15;
      if (typeof map.cameraForBounds === "function") {
        const camera = map.cameraForBounds(bounds, {
          padding,
          maxZoom,
        });
        if (camera?.center && Number.isFinite(camera?.zoom)) {
          // cameraForBounds already framed the bounds inside `padding` —
          // do NOT pass padding to flyTo again or the view shifts by the
          // padding delta (route ends up off-centre / under the sheet).
          map.flyTo({
            center: camera.center,
            zoom: camera.zoom,
            duration,
            essential: true,
            curve: 1.2,
          });
          return;
        }
      }
      map.fitBounds(bounds, {
        padding,
        maxZoom,
        duration,
        essential: true,
        linear: false,
        curve: 1.2,
      });
    } catch (e) {
      console.warn("[eta] fitMapToRouteCoords", e);
    }
  };

  // Wait for the bottom sheet / dock to settle (height animates ~0.32s
  // when detail opens) so mapVisiblePadding measures the final layout, not
  // a mid-flight frame that centres the route under the panel.
  // Do NOT gate on map.loaded(): it stays false while PMTiles tiles stream,
  // and "load" fires only once — waiting on it skips the fit forever.
  const runAfterSettle = () => {
    const toolbar = document.getElementById("main-toolbar");
    const stack = document.getElementById("panel-bottom-stack");
    const snap = () =>
      `${toolbar?.getBoundingClientRect().top ?? -1}|${
        stack?.getBoundingClientRect().top ?? -1
      }`;
    const deadline = performance.now() + 480;
    let prev = snap();
    const tick = () => {
      const cur = snap();
      if (cur === prev || performance.now() > deadline) {
        run();
        return;
      }
      prev = cur;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const start = () => {
    if (map.getStyle?.()) {
      runAfterSettle();
      return;
    }
    map.once?.("styledata", runAfterSettle);
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(start);
  });
}

/**
 * Line / card colour aligned with Trip plan (GTFS route_color + MTR brand map).
 * @param {EtaRouteEntry | null | undefined} route
 */
function companyLineColor(route) {
  if (!route) return ETA_AGENCY_GTFS_COLORS.kmb;

  if (route.kind === "mtr") {
    return (
      routeColorCss({
        route_short_name: route.id,
        route_name: route.label || route.id,
        route_long_name: route.label || "",
        mode: "subway",
        agency: { id: "MTRR", name: "MTR" },
        color: "#003DA5",
      }) || "#003DA5"
    );
  }
  if (route.kind === "lrt") {
    return (
      routeColorCss({
        route_short_name: route.id,
        route_name: route.label || route.id,
        mode: "tram",
        agency: { id: "LR", name: "Light Rail" },
        color: "#D3A809",
      }) || "#D3A809"
    );
  }
  if (route.kind === "mtr_bus") return ETA_AGENCY_GTFS_COLORS.lrtfeeder;

  const co = String(route.co || "").toLowerCase();
  if (ETA_AGENCY_GTFS_COLORS[co]) return ETA_AGENCY_GTFS_COLORS[co];
  // Unknown bus → KMB red (GTFS default for franchised KMB)
  return ETA_AGENCY_GTFS_COLORS.kmb;
}

/**
 * Load stop sequence + coordinates — strict by operator (never mix CTB/NLB with KMB).
 * @param {EtaRouteEntry} route
 */
/**
 * Whether a published bus-shape agency is allowed for this operator.
 * Empty shape agency is never reused across operators (prevents KMB shape on CTB #).
 * @param {string} co
 * @param {string} shapeAg
 */
function shapeAgencyMatchesCo(co, shapeAg) {
  const c = String(co || "").toLowerCase();
  const a = String(shapeAg || "").toLowerCase();
  if (!c) return true; // unknown operator — allow
  if (!a) return false; // tagged route must have tagged shape
  if (a.includes("joint")) return true;
  if (a.includes(c) || c.includes(a)) return true;
  if ((c === "kmb" || c === "lwb") && (a.includes("kmb") || a.includes("lwb")))
    return true;
  if (
    c === "ctb" &&
    (a.includes("ctb") || a.includes("citybus") || a.includes("nwfb"))
  )
    return true;
  if (c === "nlb" && a.includes("nlb")) return true;
  if (c === "gmb" && (a.includes("gmb") || a.includes("minibus"))) return true;
  return false;
}

/**
 * Build a RAPTOR-like route option for shape matching / densify (same as trip plan).
 * @param {EtaRouteEntry} route
 * @param {Array<{ seq?: number, name?: string, stopId?: string, lon: number, lat: number }>} stops
 * @param {{ orig?: string, dest?: string, bound?: string }} [dir]
 */
/**
 * @param {EtaRouteEntry} route
 * @param {Array<{ seq?: number, name?: string, stopId?: string, lon: number, lat: number }>} stops
 * @param {{ orig?: string, dest?: string, bound?: string }} [dir]
 * @param {{ stopId?: string, name?: string, lon?: number, lat?: number } | null} [boardStop]
 *   When set, used as boarding stop for ETA fetch (`opt.from`).
 */
function etaRouteAsOption(route, stops, dir = {}, boardStop = null) {
  const pts = (stops || [])
    .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && !s._polylineOnly)
    .map((s, i) => {
      const code = s.stationCode || s.code || "";
      return {
        stop_id: s.stopId || code || String(i),
        id: s.stopId || code || String(i),
        stop_name: s.name || "",
        name: s.name || "",
        station_code: code || undefined,
        stationCode: code || undefined,
        code: code || undefined,
        lon: s.lon,
        lat: s.lat,
        location: { lon: s.lon, lat: s.lat },
        seq: s.seq || i + 1,
        gmbRouteId: s.gmbRouteId || undefined,
        gmbRouteSeq: s.gmbRouteSeq || undefined,
      };
    });

  let mode = "bus";
  let agency = { id: "KMB", name: "KMB" };
  let routeIdPrefix = "KMB";
  if (route.kind === "mtr") {
    mode = "subway";
    agency = { id: "MTRR", name: "MTR Rail" };
    routeIdPrefix = "MTR";
  } else if (route.kind === "lrt") {
    mode = "tram";
    agency = { id: "LR", name: "Light Rail" };
    routeIdPrefix = "LRT";
  } else if (route.kind === "mtr_bus") {
    mode = "bus";
    agency = { id: "LRTFEEDER", name: "MTR Bus" };
    routeIdPrefix = "LRTFEEDER";
  } else {
    const co = String(route.co || "kmb").toUpperCase();
    agency = { id: co, name: co };
    routeIdPrefix = co;
  }

  let from = pts[0] || null;
  if (boardStop) {
    const bid = boardStop.stopId != null ? String(boardStop.stopId) : "";
    const bCode = boardStop.stationCode || boardStop.code || "";
    const wantSeq = Number(boardStop.seq ?? boardStop.stopSeq);
    const wantIdx = Number(boardStop.stopIndex);
    // Prefer exact visit on circular routes (same stop_id, different seq)
    let match = null;
    if (Number.isFinite(wantIdx) && pts[wantIdx]) {
      match = pts[wantIdx];
    } else if (Number.isFinite(wantSeq)) {
      match =
        pts.find((p) => Number(p.seq) === wantSeq) ||
        pts.find(
          (p) =>
            bid &&
            (String(p.stop_id) === bid || String(p.id) === bid) &&
            Number(p.seq) === wantSeq,
        ) ||
        null;
    }
    if (!match && bid) {
      match =
        pts.find((p) => String(p.stop_id) === bid || String(p.id) === bid) ||
        null;
    }
    if (!match && bCode) {
      match =
        pts.find(
          (p) =>
            String(p.station_code || p.code || "").toUpperCase() ===
            String(bCode).toUpperCase(),
        ) || null;
    }
    if (!match && boardStop.name) {
      match =
        pts.find(
          (p) =>
            p.stop_name === boardStop.name || p.name === boardStop.name,
        ) || null;
    }
    if (match) {
      from = match;
    } else if (
      Number.isFinite(boardStop.lon) &&
      Number.isFinite(boardStop.lat)
    ) {
      from = {
        stop_id: bid || bCode || "board",
        id: bid || bCode || "board",
        stop_name: boardStop.name || "",
        name: boardStop.name || "",
        station_code: bCode || undefined,
        stationCode: bCode || undefined,
        code: bCode || undefined,
        seq: Number.isFinite(wantSeq) ? wantSeq : undefined,
        lon: boardStop.lon,
        lat: boardStop.lat,
        location: { lon: boardStop.lon, lat: boardStop.lat },
      };
    }
  }

  return {
    kind: route.kind,
    etaKind: route.kind,
    route_short_name: route.id,
    route_name: route.label || route.id,
    route_id: `${routeIdPrefix}-${route.id}`,
    mode,
    agency,
    headsign: dir.dest || "",
    // Direction hint for GTFS shape selection: "O"/"I" → direction_id 0/1,
    // matching the stop-sequence grouping (see routeShapes.getGtfsBusShape).
    bound: dir.bound || "",
    // RBS has no live ETA — carry its headway + service window so the
    // scheduled-fallback in eta.js shows a realistic “Timetable” grid.
    headwayMins: dir.headwayMins || undefined,
    first: dir.first != null ? dir.first : undefined,
    last: dir.last != null ? dir.last : undefined,
    maxPerHour: dir.maxPerHour != null ? dir.maxPerHour : undefined,
    overnight: dir.overnight || undefined,
    from: from || {
      stop_name: dir.orig || "",
      location: { lon: 0, lat: 0 },
    },
    to: pts[pts.length - 1] || {
      stop_name: dir.dest || "",
      location: { lon: 0, lat: 0 },
    },
    stops: pts,
  };
}

/**
 * Stop sequence from the downloaded dataset (GTFS bus-shapes + local packs).
 * Used first so a PWA opened already-offline can paint markers without
 * waiting on live operator APIs (which hang when onLine is a false positive).
 */
async function loadDownloadedBusStops(route, bound, co) {
  const busCo = co || (route.kind === "bus" ? "kmb" : "");
  if (
    !busCo ||
    busCo === "rbs" ||
    !(
      route.kind === "bus" ||
      ["kmb", "lwb", "ctb", "nlb", "gmb"].includes(busCo)
    )
  ) {
    return [];
  }
  try {
    const { getGtfsRouteStopSequence } = await import("./routeShapes.js");
    const rid = String(route.id || "");
    const candidates = [`${busCo.toUpperCase()}-${rid}`];
    if (busCo === "lwb") candidates.push(`KMB-${rid}`);
    if (busCo === "gmb") {
      for (const region of ["HKI", "KLN", "NT"]) {
        candidates.push(`GMB-${region}-${rid}`);
      }
    }
    for (const routeId of candidates) {
      const seq = await getGtfsRouteStopSequence(
        {
          route_id: routeId,
          route_short_name: rid,
          agency: { id: busCo.toUpperCase(), name: busCo.toUpperCase() },
        },
        bound,
      );
      if (seq.length >= 2) return seq;
    }
  } catch (e) {
    console.warn("[eta] downloaded stop-sequence", e);
  }
  return [];
}

async function loadEtaRouteStops(route) {
  const coPre = String(route.co || "").toLowerCase();
  const skipLiveEta = appIsOffline();
  // Local packs only — do not await live /eta OD here. A PWA opened already
  // offline still reports onLine=true on some devices; those fetches hang
  // and stop markers never paint.
  if (route.kind === "mtr_bus" || coPre === "lrtfeeder" || coPre === "mtrbus") {
    await ensureMtrBusData();
  }
  if (route.kind === "lrt") {
    await ensureLrtRouteData();
  }
  if (route.kind === "mtr") {
    await ensureMtrStationLinesMap();
  }
  if (coPre === "rbs") {
    await ensureRbsRouteData();
  }

  // Full OD bounds so Opposite (card dir 0|1) maps to real O/I sequences
  const dirs = etaRouteDirections(route, { full: true });
  const di = resolveCardDirIndex(route, dirs);
  const dir = dirs[di] || dirs[0];
  let bound = String(dir?.bound || "O").toUpperCase();
  if (bound === "LINE" || bound === "LRT") bound = "O";
  const co = String(route.co || "").toLowerCase();
  const departureSwitch = etaHasDepartureSwitch(dirs);

  // AM/PM variants (S64C) share a GTFS bound and the shapes pack only stores
  // the circular `st` list — pick the matching KMB service type / schedule
  // pattern so Switch Departure actually swaps the stop list.
  if (
    departureSwitch &&
    (co === "kmb" || co === "lwb" || (route.kind === "bus" && !co))
  ) {
    if (!skipLiveEta) {
      const exact = await loadKmbRouteStopsExact(route.id, dir);
      if (exact.length >= 2) return exact;
    }
    const fromSched = await loadScheduleVariantStops(route, dir);
    if (fromSched.length >= 2) return fromSched;
  }

  // Downloaded GTFS first — paints markers when the PWA is opened already
  // offline. Do not wait on live /eta hosts: navigator.onLine is often still
  // true on a cold start, and those fetches hang. ETA ids strip the GTFS prefix.
  const downloaded = await loadDownloadedBusStops(route, bound, co);
  if (downloaded.length >= 2) {
    if (!departureSwitch) return downloaded;
    const wantLoop = etaIsCircularDir(dir) || dir?.variant === "loop";
    if (stopListIsLoop(downloaded) === wantLoop) return downloaded;
  }

  // Load official stop sequence from operator APIs first (names + ETA ids).
  // Offline: skip live ETA hosts and use the downloaded GTFS / local copies.
  // Contributed path is applied later in paint via buildTransitPolyline (trip plan).

  // ── GMB (etagmb open data) ──
  if (!skipLiveEta && co === "gmb") {
    try {
      let seq = await loadGmbStopSequence(route.id, bound);
      if (seq.length < 2) {
        seq = await loadGmbStopSequence(
          route.id,
          bound === "I" ? "O" : "I",
        );
      }
      if (seq.length >= 2) return seq;
      console.warn("[eta] GMB stops empty for", route.id, "bound", bound);
    } catch (e) {
      console.warn("[eta] GMB route-stop", e);
    }
  }

  // ── MTR Bus (official open data, not KMB) ──
  if (route.kind === "mtr_bus" || co === "lrtfeeder" || co === "mtrbus") {
    let seq = mtrBusStopSequence(route.id, bound);
    if (seq.length < 2) {
      seq = mtrBusStopSequence(route.id, bound === "I" ? "O" : "I");
    }
    if (seq.length < 2) {
      // Last resort: any stops for this route id (any direction)
      seq = mtrBusStopSequence(route.id, "O");
      if (seq.length < 2) seq = mtrBusStopSequence(route.id, "I");
    }
    if (seq.length >= 2) return seq;
    console.warn("[eta] MTR Bus stops empty for", route.id, "bound", bound);
  }

  // ── RBS (residents' bus, TD headway GTFS — no live ETA) ──
  if (co === "rbs") {
    await ensureRbsRouteData();
    let seq = rbsRouteStops(route.id, bound);
    if (seq.length < 2) {
      seq = rbsRouteStops(route.id, bound === "I" ? "O" : "I");
    }
    if (seq.length >= 2) return seq;
    console.warn("[eta] RBS stops empty for", route.id, "bound", bound);
  }

  // ── KMB / LWB only (never fall through for CTB/NLB/MTR Bus) ──
  // Circular / one-way airport feeders (S64 series) often have:
  //  · only outbound stop-lists (inbound = [])
  //  · multiple service_type rows (1 / 2 / 3)
  if (
    !skipLiveEta &&
    (co === "kmb" || co === "lwb" || (route.kind === "bus" && !co))
  ) {
    try {
      const serviceType =
        dir?.serviceType ??
        dir?.service_type ??
        // Prefer matching bound’s service type from OD table
        (kmbRouteBoundsMap?.get(String(route.id || "").toUpperCase()) || [])
          .find(
            (b) =>
              String(b.bound || "").toUpperCase() === bound ||
              String(b.bound || "").toUpperCase() === "O",
          )?.service_type ??
        null;
      const stops = departureSwitch
        ? await loadKmbRouteStopsExact(route.id, dir)
        : await loadKmbRouteStopsRobust(route.id, bound, serviceType);
      if (stops.length >= 2) return stops;
      if (departureSwitch) {
        const fromSched = await loadScheduleVariantStops(route, dir);
        if (fromSched.length >= 2) return fromSched;
      }
      console.warn(
        "[eta] KMB stops empty for",
        route.id,
        "bound",
        bound,
        "serviceType",
        serviceType,
      );
    } catch (e) {
      console.warn("[eta] kmb route-stop", e);
    }
  }

  // ── CTB only ──
  if (!skipLiveEta && co === "ctb") {
    try {
      const direction = bound === "I" ? "inbound" : "outbound";
      const rs = await fetch(
        `/eta/ctb/route-stop/CTB/${encodeURIComponent(route.id)}/${direction}`,
        { headers: { Accept: "application/json" } },
      );
      if (rs.ok) {
        const j = await rs.json();
        const rows = (j.data || [])
          .slice()
          .sort((a, b) => Number(a.seq) - Number(b.seq));
        const limited = rows.slice(0, 100);
        /** @type {Array<{seq:number,name:string,stopId:string,lon:number,lat:number}>} */
        const stops = [];
        await Promise.all(
          limited.map(async (row) => {
            const sid = String(row.stop || "");
            try {
              const sr = await fetch(
                `/eta/ctb/stop/${encodeURIComponent(sid)}`,
                { headers: { Accept: "application/json" } },
              );
              if (!sr.ok) return;
              const sj = await sr.json();
              const d = sj.data || {};
              const lat = Number(d.lat);
              const lon = Number(d.long ?? d.lon);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
              stops.push({
                seq: Number(row.seq) || 0,
                name: d.name_tc || d.name_en || sid,
                nameEn: d.name_en || "",
                nameTc: d.name_tc || "",
                stopId: sid,
                lon,
                lat,
              });
            } catch {
              /* skip */
            }
          }),
        );
        stops.sort((a, b) => a.seq - b.seq);
        if (stops.length >= 2) return stops;
      }
    } catch (e) {
      console.warn("[eta] ctb route-stop", e);
    }
  }

  // ── NLB: pick routeId for selected direction (each OD is its own routeId) ──
  if (!skipLiveEta && co === "nlb") {
    try {
      await ensureNlbRouteBounds();
      const want = String(route.id).toUpperCase();
      const variants = nlbRouteBoundsMap?.get(want) || [];
      let routeId = dir?.routeId || "";
      if (!routeId && variants.length) {
        const pick =
          variants.find((v) => String(v.bound || "").toUpperCase() === bound) ||
          variants[Math.min(di, variants.length - 1)] ||
          variants[0];
        routeId = pick?.routeId || "";
      }
      if (!routeId) {
        // Fallback: list API
        const lr = await fetch("/eta/nlb/route.php?action=list", {
          headers: { Accept: "application/json" },
        });
        if (lr.ok) {
          const lj = await lr.json();
          const routes = lj.routes || lj.data || [];
          const matches = routes.filter(
            (r) => String(r.routeNo || r.route || "").toUpperCase() === want,
          );
          const hit = matches[Math.min(di, Math.max(0, matches.length - 1))] || matches[0];
          routeId = hit?.routeId || hit?.route_id || "";
        }
      }
      if (routeId) {
        for (const path of [
          `/eta/nlb/stop.php?action=list&routeId=${encodeURIComponent(routeId)}`,
          `/eta/nlb/route.stop.list.php?routeId=${encodeURIComponent(routeId)}`,
        ]) {
          try {
            const sr = await fetch(path, {
              headers: { Accept: "application/json" },
            });
            if (!sr.ok) continue;
            const sj = await sr.json();
            const raw = sj.stops || sj.data || [];
            const stops = raw
              .map((s, i) => {
                const lat = Number(s.latitude ?? s.lat);
                const lon = Number(s.longitude ?? s.long ?? s.lon);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
                return {
                  seq: Number(s.stopSequence ?? s.seq) || i + 1,
                  name:
                    s.stopName_c ||
                    s.stopName_e ||
                    s.name_tc ||
                    s.name ||
                    "",
                  nameEn: s.stopName_e || s.name_en || "",
                  nameTc: s.stopName_c || s.name_tc || "",
                  stopId: String(s.stopId || s.stop || ""),
                  lon,
                  lat,
                };
              })
              .filter(Boolean)
              .sort((a, b) => a.seq - b.seq);
            if (stops.length >= 2) return stops;
          } catch {
            /* try next */
          }
        }
      }
    } catch (e) {
      console.warn("[eta] nlb route", e);
    }
  }

  // ── GTFS stop-sequence fallback (offline / operator API down) ──────────
  if (downloaded.length >= 2) return downloaded;
  const gtfsAgain = await loadDownloadedBusStops(route, bound, co);
  if (gtfsAgain.length >= 2) return gtfsAgain;

  // MTR line stations — official line order (not nearest-neighbour)
  if (route.kind === "mtr") {
    const line = String(route.id).toUpperCase();
    const branch =
      etaDetailMtrBranchOverride ||
      dir?.branch ||
      mtrResolveBranch(line, "", bound) ||
      null;
    if (etaDetailMtrBranchOverride) etaDetailMtrBranchOverride = null;
    const codes = mtrLineCodesInOrder(line, bound, branch);
    /** @type {Map<string, (typeof MTR_STATIONS)[0]>} */
    const byCode = new Map();
    for (const st of MTR_STATIONS) {
      if (st.code) byCode.set(String(st.code).toUpperCase(), st);
    }
    // Also index from geojson-backed line map names if code missing in directory
    const ordered = [];
    const used = new Set();
    for (const code of codes) {
      const st = byCode.get(code);
      if (!st || !Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
      if (used.has(code)) continue;
      used.add(code);
      const lab = mtrStationLabel(code);
      ordered.push({
        name: st.name_zh
          ? `${st.name_zh} ${st.name_en}`
          : st.name_en || lab.en,
        nameEn: st.name_en || lab.en,
        nameTc: st.name_zh || lab.zh,
        stopId: `MTR-${code}`,
        stationCode: code,
        code,
        lon: st.lon,
        lat: st.lat,
        seq: ordered.length + 1,
      });
    }
    // Append any on-line stations missing from fixed order (rare).
    // Do not re-attach the other branch terminus on EAL/TKL (LMC vs LOW, LHP vs POA).
    if (line !== "EAL" && line !== "TKL") {
      for (const st of MTR_STATIONS) {
        const code = st.code ? String(st.code).toUpperCase() : "";
        if (!code || used.has(code)) continue;
        if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
        const lines =
          mtrStationLinesMap?.get(String(st.name_en || "").toLowerCase()) ||
          [];
        if (!lines.map((x) => String(x).toUpperCase()).includes(line)) continue;
        ordered.push({
          name: st.name_zh ? `${st.name_zh} ${st.name_en}` : st.name_en,
          nameEn: st.name_en || "",
          nameTc: st.name_zh || "",
          stopId: `MTR-${code}`,
          stationCode: code,
          code,
          lon: st.lon,
          lat: st.lat,
          seq: ordered.length + 1,
        });
        used.add(code);
      }
    }
    if (ordered.length >= 2) return ordered;
    // Fallback: no MTR_LINE_ORDER entry — geo nearest-neighbour
    if (!MTR_LINE_ORDER[line]) {
      console.warn("[eta] no MTR_LINE_ORDER for", line);
    }
  }

  // LRT: per-route sequence from open-data CSV (not all stops A–Z)
  if (route.kind === "lrt") {
    await ensureLrtRouteData();
    let seq = lrtStopSequence(route.id, bound);
    if (seq.length < 2) {
      seq = lrtStopSequence(route.id, bound === "I" ? "O" : "I");
    }
    // Retry load once if still empty (first fetch may have failed under COEP)
    if (seq.length < 2) {
      await ensureLrtRouteData({ force: true });
      seq = lrtStopSequence(route.id, bound);
      if (seq.length < 2) {
        seq = lrtStopSequence(route.id, bound === "I" ? "O" : "I");
      }
    }
    if (seq.length >= 2) return seq;
    // Last resort: any direction for this line
    seq = lrtStopSequence(route.id, "1");
    if (seq.length < 2) seq = lrtStopSequence(route.id, "2");
    if (seq.length >= 2) return seq;
    console.warn("[eta] LRT stops empty for", route.id, "bound", bound);
  }

  // Fallback: contributed shape only (no official stop API) — still show path
  if (route.kind === "bus" || route.kind === "mtr_bus" || co === "gmb") {
    const match = matchBusShapeForRoute({
      route_short_name: route.id,
      agency: co || "",
      direction: bound === "I" ? "inbound" : "outbound",
      from: dir?.orig || "",
      to: dir?.dest || "",
    });
    if (
      match?.shape?.coordinates?.length >= 2 &&
      shapeAgencyMatchesCo(co, String(match.shape.agency || "").toLowerCase())
    ) {
      const vs = match.shape.visual_stops || [];
      if (vs.length) {
        return vs
          .map((s, i) => {
            const c = s.visual || s.official;
            if (!Array.isArray(c) || c.length < 2) return null;
            return {
              seq: Number(s.seq) || i + 1,
              name: String(s.name || `Stop ${i + 1}`),
              stopId: s.stop_id || "",
              lon: Number(c[0]),
              lat: Number(c[1]),
              _shape: match.shape,
            };
          })
          .filter(Boolean);
      }
      return match.shape.coordinates.map((c, i) => ({
        seq: i + 1,
        name:
          i === 0
            ? "Start"
            : i === match.shape.coordinates.length - 1
              ? "End"
              : "",
        lon: Number(c[0]),
        lat: Number(c[1]),
        _shape: match.shape,
        _polylineOnly: i > 0 && i < match.shape.coordinates.length - 1,
      }));
    }
  }

  return [];
}

/**
 * Draw selected ETA route on map (polyline + stops).
 * Path uses the same pipeline as Trip plan: contributed bus-shapes → OSRM densify.
 * Passed segment before the board stop is greyed (same logic as the stop list).
 * @param {EtaRouteEntry} route
 * @param {Array<{ seq: number, name: string, stopId?: string, lon: number, lat: number, _shape?: any, _polylineOnly?: boolean }>} stops
 * @param {{ boardIndex?: number, fit?: boolean }} [opts]
 */
async function paintEtaRouteOnMap(route, stops, opts = {}) {
  if (!map?.getStyle) return;
  ensureRouteLayers();
  const color = companyLineColor(route);
  const boardIndex = Number.isFinite(opts.boardIndex) ? opts.boardIndex : 0;
  const doFit = opts.fit !== false;

  const dirs = etaRouteDirections(route);
  const di = resolveCardDirIndex(route, dirs);
  const dir = dirs[Math.min(di, dirs.length - 1)] || dirs[0];
  const opt = etaRouteAsOption(route, stops, dir);

  /** @type {number[][]} */
  let lineCoords = [];

  // Rail: ordered stop chords + basemap rail snap (official sequences).
  // Bus / MTR Bus share the trip-plan path: overrides → GTFS shapes → OSRM.
  const isRail = route.kind === "mtr" || route.kind === "lrt";

  if (!isRail) {
    try {
      const poly = await buildTransitPolyline(opt);
      if (poly?.length >= 2) {
        lineCoords = poly
          .map((p) => [Number(p.lon), Number(p.lat)])
          .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      }
    } catch (e) {
      console.warn("[eta] buildTransitPolyline", e);
    }
  }

  // MTR / LRT: snap to basemap railway geometry when possible
  if (
    lineCoords.length < 2 &&
    (route.kind === "mtr" || route.kind === "lrt")
  ) {
    try {
      const { densifyAlongBasemapRail } = await import("./railSnapper.js");
      const pts = (stops || [])
        .filter(
          (s) =>
            Number.isFinite(s.lon) &&
            Number.isFinite(s.lat) &&
            !s._polylineOnly,
        )
        .map((s) => ({ lon: s.lon, lat: s.lat, id: s.stopId || s.code }));
      if (pts.length >= 2 && typeof densifyAlongBasemapRail === "function") {
        const poly = await densifyAlongBasemapRail(pts, {
          mode: route.kind === "lrt" ? "tram" : "subway",
          route_short_name: route.id,
          route_name: route.label || route.id,
          route_id: `${route.kind}-${route.id}`,
        });
        if (poly?.length >= 2) {
          lineCoords = poly
            .map((p) => [Number(p.lon), Number(p.lat)])
            .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
        }
      }
    } catch (e) {
      console.warn("[eta] rail snap", e);
    }
  }

  // Contributed bus shape (MTR Bus / franchised)
  if (lineCoords.length < 2) {
    const shape =
      stops.find((s) => s._shape)?._shape || matchBusShapeOverride(opt);
    if (shape?.coordinates?.length >= 2) {
      const poly = busShapeToPolyline(shape, opt.stops, sliceRouteBetweenStops);
      lineCoords = (poly?.length >= 2 ? poly : shape.coordinates)
        .map((c) =>
          Array.isArray(c)
            ? [Number(c[0]), Number(c[1])]
            : [Number(c.lon), Number(c.lat)],
        )
        .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    }
  }

  // Official stop sequence as polyline (always works when stops loaded)
  if (lineCoords.length < 2) {
    console.warn(
      "[eta] no densified path for",
      route.co || route.kind,
      route.id,
      "— stop chords",
    );
    lineCoords = (stops || [])
      .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && !s._polylineOnly)
      .map((s) => [s.lon, s.lat]);
  }

  const stopFeats = stops
    .filter(
      (s) => !s._polylineOnly && Number.isFinite(s.lon) && Number.isFinite(s.lat),
    )
    .map((s, i, arr) => {
      const label = s.name || `Stop ${i + 1}`;
      return {
        type: "Feature",
        properties: {
          name: label,
          stop_name: label,
          stop_id: s.stopId || "",
          stop_index: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i + 1,
          seq: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i + 1,
          // Same marker style for all stops
          role: "via",
          color,
        },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      };
    });

  // Contributed visual_stops (same as trip plan)
  try {
    const shape = matchBusShapeOverride(opt);
    if (shape?.visual_stops?.length) {
      applyVisualStopsFromShape(stopFeats, shape);
    }
  } catch (e) {
    console.warn("[eta] visual_stops", e);
  }

  // Visual positions for routes WITHOUT contributed visual_stops: snap official
  // stops onto the drawn polyline (same projection the trip plan uses). Display
  // only — official coords / identity stay; stops far from the line keep their
  // official position (parallel-road guard). Contributed visual_stops win.
  if (lineCoords.length >= 2) {
    try {
      const line = lineCoords.map((c) => ({
        lon: Number(c[0]),
        lat: Number(c[1]),
      }));
      const isRailKind = route.kind === "mtr" || route.kind === "lrt";
      const maxErr = isRailKind ? PLATFORM_SNAP_MAX_M : STOP_SNAP_MAX_M;
      const targets = stopFeats
        .map((f, i) => ({
          f,
          i,
          lon: Number(f.geometry?.coordinates?.[0]),
          lat: Number(f.geometry?.coordinates?.[1]),
        }))
        .filter(
          (t) =>
            Number.isFinite(t.lon) &&
            Number.isFinite(t.lat) &&
            t.f.properties?.visual_override !== true,
        );
      const projected = projectStops(
        line,
        targets.map((t) => ({ id: String(t.i), lon: t.lon, lat: t.lat })),
      );
      let snapped = 0;
      for (const t of targets) {
        const p = projected.find((x) => x.id === String(t.i));
        if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
        if (Number.isFinite(p.error) && p.error > maxErr) continue;
        t.f.geometry = { type: "Point", coordinates: [p.lon, p.lat] };
        t.f.properties.snapped = true;
        snapped += 1;
      }
      if (snapped) {
        console.info("[eta] snapped", snapped, "stops onto route line");
      }
    } catch (e) {
      console.warn("[eta] stop snap failed", e);
    }
  }

  if (lineCoords.length < 2) {
    etaMapGeomCache = null;
    console.warn(
      "[eta] no line coords for",
      route.co || route.kind,
      route.id,
      "stops",
      stops.length,
    );
    const lineSrc = map.getSource("route-line");
    const stopSrc = map.getSource("route-stops");
    lineSrc?.setData({ type: "FeatureCollection", features: [] });
    stopSrc?.setData({
      type: "FeatureCollection",
      features: stopFeats,
    });
    return;
  }

  // Cache full geometry; progress (grey passed segment) applied from board index.
  // Deep-copy stops and bake contributed visual_stops offsets (already applied
  // to stopFeats, built 1:1 in the same filtered order) into the copies so
  // later board-tap re-cuts keep visual marker positions, not official coords.
  etaMapGeomCache = {
    coords: lineCoords,
    color,
    routeId: String(route.id || ""),
    stops: (stops || []).map((s) => ({ ...s })),
  };
  {
    let fi = 0;
    for (const s of etaMapGeomCache.stops) {
      if (s._polylineOnly || !Number.isFinite(s.lon) || !Number.isFinite(s.lat)) {
        continue;
      }
      const c = stopFeats[fi]?.geometry?.coordinates;
      if (Array.isArray(c) && c.length >= 2) {
        s.lon = Number(c[0]);
        s.lat = Number(c[1]);
      }
      fi += 1;
    }
  }
  applyEtaRouteProgressOnMap(boardIndex, { fit: doFit });
  busPosAdoptMapGeom();
}

/**
 * Select a route from the search list → open route detail for that stop.
 * Shape is drawn by showEtaRouteDetailsPanel after stops load.
 * @param {EtaRouteEntry | undefined} route
 * @param {number} [listIndex]
 */
function selectEtaRoute(route, listIndex) {
  if (!route) return;
  if (typeof listIndex === "number" && listIndex >= 0) {
    etaRouteActive = listIndex;
  }
  etaSelectedForDetails = route;
  // Invalidate any in-flight shape paint; detail page will redraw
  ++etaShapeGen;
  etaSelectedStops = [];
  etaDetailStopIndex = -1;
  clearRouteGeometry();

  const dirs = etaRouteDirections(route);
  const di = getCardDir(route);
  const dir = dirs[Math.min(di, dirs.length - 1)] || dirs[0];
  const live = etaLiveByKey.get(etaRouteKey(route));
  const kindLabel =
    route.kind === "mtr"
      ? "MTR"
      : route.kind === "lrt"
        ? "LRT"
        : route.kind === "mtr_bus"
          ? "MTR Bus"
          : route.co === "gmb"
            ? "GMB"
            : route.co === "ctb"
              ? "CTB"
              : route.co === "nlb"
                ? "NLB"
                : route.co === "kmb" || route.co === "lwb"
                  ? "KMB"
                  : "Bus";
  // Localized destination for the toast: English first for en / ja / ko,
  // Chinese first for zh modes (falling back to the other when absent).
  const dest =
    LANG_META[getLang()].stationMode === "en"
      ? live?.dest || dir?.dest || live?.destZh || dir?.destZh || route.label
      : live?.destZh || dir?.destZh || live?.dest || dir?.dest || route.label;
  showToast(t("{kindLabel} {routeId} → {dest}", { kindLabel: t(kindLabel), routeId: route.id, dest }), 1800);
  setDetailOpen(true);
  syncEtaActive();
  if (els.etaRouteActions) els.etaRouteActions.hidden = true;
  syncPinnedRouteToolbar();
  const oldPanel = document.getElementById("eta-route-details-panel");
  if (oldPanel) oldPanel.remove();

  // Open stop/route detail page (no map shape)
  void showEtaRouteDetailsPanel();

  if (els.planResults) {
    els.planResults.hidden = true;
  }
}

/**
 * Compact wait for big ETA card (“5m”, “Now”, “N/A”) — Wheels-style.
 * @param {number | null | undefined} mins
 */
function formatWaitCompact(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return t("N/A");
  const n = Math.round(Number(mins));
  if (n < 0) return t("{n}m", { n });
  if (n === 0) return t("Now");
  return t("{n}m", { n });
}

/**
 * Stop-list wait label — use “min” so it is not read as metres.
 * e.g. “5 min”, “-3 min”, “Now”.
 * @param {number | null | undefined} mins
 */
function formatWaitStopList(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return t("N/A");
  const n = Math.round(Number(mins));
  if (n < 0) return t("{n} min", { n });
  if (n === 0) return t("Now");
  if (n === 1) return t("1 min");
  return t("{n} min", { n });
}

/**
 * Stop-list label: “5 min” or bus “5 min・$12.5” (section fare board→terminus).
 * @param {number | null | undefined} mins
 * @param {number | null | undefined} [fareHkd]
 */
function formatStopReachLabel(mins, fareHkd = null) {
  const wait = formatWaitStopList(mins);
  if (fareHkd != null && Number.isFinite(Number(fareHkd))) {
    return `${wait}・${formatHkd(Number(fareHkd))}`;
  }
  return wait;
}

/**
 * Estimate full-route ride seconds from stop coordinates (urban average).
 * @param {Array<{ lon?: number, lat?: number }>} stops
 * @param {"bus"|"mtr"|"lrt"|"mtr_bus"|string} kind
 */
function estimateEtaRouteRideSeconds(stops, kind) {
  let distM = 0;
  let segs = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (
      a &&
      b &&
      Number.isFinite(a.lon) &&
      Number.isFinite(a.lat) &&
      Number.isFinite(b.lon) &&
      Number.isFinite(b.lat)
    ) {
      distM += haversineMEta(a.lat, a.lon, b.lat, b.lon);
      segs++;
    }
  }
  // Typical HK average including dwell: bus ~18 km/h, rail faster
  const mps =
    kind === "mtr" ? 9 : kind === "lrt" ? 6.5 : kind === "mtr_bus" ? 5.5 : 5;
  const dwellSec =
    Math.max(0, stops.length - 1) *
    (kind === "mtr" || kind === "lrt" ? 25 : 18);
  if (distM > 40 && segs > 0) {
    return Math.max(60, Math.round(distM / mps) + dwellSec);
  }
  // Fallback: ~1.1 min per hop
  return Math.max(60, Math.round(Math.max(stops.length - 1, 1) * 66));
}

/**
 * Minutes from *now* until the next vehicle reaches each stop.
 * Anchored on selected-stop wait + travel along the route.
 * Stops before the selected stop get negative times (“-5m” = already passed).
 *
 * @param {Array<{ stopId?: string, name?: string, lon?: number, lat?: number }>} named
 * @param {number} boardIndex
 * @param {number | null | undefined} boardWaitMins
 * @param {string} kind
 * @returns {(number | null)[]}
 */
function etaStopReachMinutes(named, boardIndex, boardWaitMins, kind) {
  const n = named.length;
  /** @type {(number | null)[]} */
  const out = Array(n).fill(null);
  if (!n || boardIndex < 0 || boardIndex >= n) return out;
  const rideSec = estimateEtaRouteRideSeconds(named, kind);
  const offsets = stopOffsetMinutesFromBoard({}, named, rideSec);
  const base = offsets[boardIndex] ?? 0;
  const wait =
    boardWaitMins != null && Number.isFinite(Number(boardWaitMins))
      ? Number(boardWaitMins)
      : 0;
  for (let i = 0; i < n; i++) {
    // Relative to selected stop: wait + (offset_i − offset_selected)
    out[i] = wait + ((offsets[i] ?? base) - base);
  }
  return out;
}

/**
 * Operator label for route hero (Citybus, KMB, MTR…).
 * @param {EtaRouteEntry} route
 */
function etaOperatorDisplayName(route) {
  if (!route) return t("Bus");
  if (route.kind === "mtr") return t("MTR");
  if (route.kind === "lrt") return t("Light Rail");
  if (route.kind === "mtr_bus") return t("MTR Bus");
  const co = String(route.co || "").toLowerCase();
  if (co === "ctb") return t("Citybus");
  if (co === "kmb") return t("KMB");
  if (co === "nlb") return t("NLB");
  if (co === "lwb") return t("LWB");
  if (co === "gmb") return t("GMB");
  return co ? co.toUpperCase() : t("Bus");
}

/** Selected stop index on ETA route detail (for per-stop ETA). */
let etaDetailStopIndex = 0;
/** Generation for stop-ETA fetches (ignore stale). */
let etaDetailEtaGen = 0;
/** Last successful full-render ctx of the ETA route detail body (silent refresh). */
let etaDetailCtx = null;
/** Refresh generation — a newer render / stop pick / superseding refresh wins. */
let etaDetailRefreshGen = 0;
/**
 * One-shot MTR branch override when auto-flipping at a branch terminus
 * (e.g. LOHAS → North Point must reverse the LHP path, not Po Lam).
 * @type {string | null}
 */
let etaDetailMtrBranchOverride = null;

/**
 * Fetch live/timetable ETA for one board stop on a route.
 * @param {EtaRouteEntry} route
 * @param {object} dir
 * @param {{ stopId?: string, name?: string, lon?: number, lat?: number } | null} boardStop
 * @param {string} dest
 */
async function fetchEtaForDetailStop(route, dir, boardStop, dest) {
  const opt = etaRouteAsOption(route, etaSelectedStops, dir, boardStop);
  let etaResult = null;
  if (boardStop && Number.isFinite(Number(boardStop.lon))) {
    try {
      etaResult = await fetchBoardEta(opt);
    } catch (e) {
      console.warn("[eta] details eta", e);
    }
  }
  return resolveBrowseEta(etaResult, opt, {
    dest,
    route: route.id,
  });
}

/**
 * Display label for one ETA slot's own destination (per-departure).
 * Covers peak-hour / special trips whose dest differs from the direction.
 * MTR Next Train returns station codes (e.g. "POA") — map to names.
 * @param {{ dest?: string, destZh?: string } | null | undefined} slot
 * @param {string} [kind] route kind ("mtr" maps codes)
 */
function etaSlotDestLabel(slot, kind) {
  const dest = String(slot?.dest || "").trim();
  if (!dest) return "";
  if (kind === "mtr" && /^[A-Z]{2,4}$/.test(dest)) {
    const lab = mtrStationLabel(dest);
    if (lab && (lab.en || lab.zh) && (lab.en !== dest || lab.zh !== dest)) {
      return stationDisplayName({ name_en: lab.en, name_zh: lab.zh });
    }
  }
  // Bus/rail slot dests carry destZh alongside dest — follow the station mode
  const zh = String(slot?.destZh || "").trim();
  const mode = LANG_META[getLang()].stationMode;
  if (mode === "en") return dest;
  const zhOut = zh ? (mode === "hans" ? simplifyZh(zh) : zh) : "";
  if (zhOut && dest && zhOut !== dest) return `${zhOut} ${dest}`;
  return zhOut || dest;
}

/**
 * Wheels big-slot HTML for ETA result.
 * @param {object} etaResult
 * @param {{ kind?: string }} [opts]
 */
function wheelsEtaSlotsHtml(etaResult, opts = {}) {
  const slots = (etaResult?.etas || []).slice(0, 3);
  const hasLive = slots.some((s) => !s.scheduled);
  if (!slots.length) {
    const outside = !!etaResult?.outsideService;
    const sub = outside
      ? etaResult?.remark && !/non-?service/i.test(etaResult.remark)
        ? String(etaResult.remark)
        : t("Outside service")
      : t("No departure");
    return {
      html: `<div class="wheels-eta-slot is-empty is-outside-service">
        <span class="wheels-eta-wait">${escapeHtml(t("N/A"))}</span>
        <span class="wheels-eta-clock" title="${outside ? escapeHtml(t("Outside service hours")) : escapeHtml(t("No departure data"))}">${escapeHtml(sub)}</span>
      </div>`,
      hasLive: false,
      slots: [],
      outsideService: outside,
    };
  }
  const html = slots
    .map((slot) => {
      const wait = formatWaitCompact(slot.waitMins);
      // Always prefer a wall clock: live/etaIso, then derive from wait mins
      let clock =
        slot.clock || (slot.etaIso ? formatHkClock(slot.etaIso) : "") || "";
      if ((!clock || clock === "—") && slot.waitMins != null) {
        const ms = Date.now() + Math.round(Number(slot.waitMins)) * 60_000;
        clock = formatHkClock(ms);
      }
      const due = slot.waitMins != null && slot.waitMins <= 0;
      const clockBase = clock && clock !== "—" ? clock : "—";
      // Short tags avoid wrap under wait times on narrow cards
      const kind = slot.scheduled ? t("Sched") : t("Live");
      const kindTitle = slot.scheduled ? t("SCHEDULED") : t("LIVE");
      const clockLine = `${clockBase}・${kind}`;
      // Per-departure destination (peak-hour special trips show their own)
      const destLine = etaSlotDestLabel(slot, opts.kind);
      const destHtml = destLine
        ? `<span class="wheels-eta-slotdest" title="${escapeHtml(t("To {dest}", { dest: destLine }))}">${escapeHtml(destLine)}</span>`
        : "";
      // Live slots carry their ETA time so the global 1 s ticker can count
      // the wait down against it (scheduled slots have no etaIso — static).
      const etaT = slot.etaIso ? Date.parse(slot.etaIso) : NaN;
      const etaTAttr = Number.isFinite(etaT) ? ` data-eta-t="${etaT}"` : "";
      return `<div class="wheels-eta-slot${due ? " is-due" : ""}${slot.scheduled ? " is-scheduled" : ""}">
        <span class="wheels-eta-wait"${etaTAttr}>${escapeHtml(wait)}</span>
        <span class="wheels-eta-clock" title="${kindTitle}">${escapeHtml(clockLine)}</span>${destHtml}
      </div>`;
    })
    .join("");
  return { html, hasLive, slots, outsideService: false };
}

/**
 * Paint ETA route detail body for a selected stop index.
 * Fixed chrome (card / dir / toggle) + scrollable stop list only.
 * @param {EtaRouteEntry} route
 * @param {object} ctx
 */
async function renderEtaRouteDetailBody(route, ctx) {
  const {
    gen,
    color,
    coLabel,
    dest,
    dir,
    di,
    dirs,
    named,
    selectedIndex,
    preserveScroll = false,
  } = ctx;
  if (!els.etaRouteDetailBody) return;

  const boardIndex =
    named.length && selectedIndex >= 0 && selectedIndex < named.length
      ? selectedIndex
      : 0;
  const boardStopRaw = named[boardIndex] || null;
  // Always carry visit index for pin / ETA / grey path on circular routes
  const boardStop = boardStopRaw
    ? {
        ...boardStopRaw,
        stopIndex: boardIndex,
        seq: boardStopRaw.seq ?? boardIndex + 1,
      }
    : null;
  const boardName = boardStop
    ? boardStop.visitTotal > 1
      ? `${boardStop.name} · ${boardStop.visitN}/${boardStop.visitTotal}`
      : boardStop.name || ""
    : "";

  const prevScroll =
    preserveScroll
      ? els.etaRouteDetailBody.querySelector("#eta-detail-stops")?.scrollTop || 0
      : 0;

  // Loading state on card only when switching stops
  const cardSlotsEl = els.etaRouteDetailBody.querySelector("#eta-detail-slots");
  if (cardSlotsEl && preserveScroll) {
    cardSlotsEl.innerHTML = `<div class="wheels-eta-slot is-empty"><span class="wheels-eta-wait">…</span></div>`;
  }
  const boardEl = els.etaRouteDetailBody.querySelector("#eta-detail-board");
  if (boardEl && preserveScroll) boardEl.textContent = boardName;

  const etaFetchId = ++etaDetailEtaGen;
  const etaResult = await fetchEtaForDetailStop(route, dir, boardStop, dest);
  if (gen !== etaShapeGen || etaFetchId !== etaDetailEtaGen) return;

  // Board line: station name + platform for rail (MTR / LRT) after live fetch
  const platOk = etaOperatorShowsPlatform(etaResult.operator);
  const plats = platOk ? etaResult?.servingPlatforms || [] : [];
  const boardText =
    boardName && plats.length
      ? stationNameWithPlatforms(stationBaseName(boardName), plats)
      : boardName;

  const { html: etaBigHtml, hasLive, slots } = wheelsEtaSlotsHtml(etaResult, {
    kind: route.kind,
  });
  const reachMins = named.length
    ? etaStopReachMinutes(named, boardIndex, slots[0]?.waitMins, route.kind)
    : [];

  const oppDi = etaOppositeDirIndex(di, dirs);
  const canDeparture = etaHasDepartureSwitch(dirs) && dirs.length >= 2;
  // Route detail keeps Opposite everywhere: at a first station it flips to
  // the reverse bound and boards at that direction's first station (see the
  // #btn-eta-detail-dir handler). List cards do the terminus hiding.
  const canOpposite = !canDeparture && etaHasRealOpposite(dirs) && oppDi !== di;
  const branchSibs = etaBranchSiblingIndices(dirs, di);
  const canBranch = branchSibs.length >= 2;
  const nextBr = canBranch ? dirs[etaNextBranchIndex(di, dirs)] : null;
  const branchPair = etaBranchPairLabels(dirs[di], nextBr);
  // Panel header shows every branch terminus; stop list head keeps `dest`
  // (the current branch) — see rt-route-to below.
  const panelDest = etaPanelDestLabel(dirs, di) || dest;

  const nextDepDir = canDeparture ? dirs[etaNextDepartureIndex(di, dirs)] : null;
  const dirSwitchButtons = [
    canDeparture
      ? `<button type="button" class="wheels-dir-switch" id="btn-eta-detail-dir" data-action="departure" aria-label="${escapeHtml(t("Switch Departure"))}" title="${escapeHtml(etaDepartureLabel(nextDepDir || {}))}">
          <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
          <span>${escapeHtml(t("Switch Departure"))}</span>
          ${etaDirectionDotsHtml(di)}
        </button>`
      : "",
    canOpposite
      ? `<button type="button" class="wheels-dir-switch" id="btn-eta-detail-dir" aria-label="${escapeHtml(t("Switch direction"))}">
          <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
          <span>${escapeHtml(t("Opposite"))}</span>
          ${etaDirectionDotsHtml(di)}
        </button>`
      : "",
    canBranch
      ? `<button type="button" class="wheels-dir-switch wheels-branch-switch" id="btn-eta-detail-branch" aria-label="${escapeHtml(t("Switch branch"))}" title="${escapeHtml(t("Switch branch: {cur} ⇄ {other}", { cur: String(branchPair.cur), other: String(branchPair.other) }))}">
          <span class="material-symbols-outlined" aria-hidden="true">alt_route</span>
          <span>${escapeHtml(t("Branch"))}</span>
          ${etaBranchLabelsHtml(branchPair)}
        </button>`
      : "",
    isJointBusRoute(route)
      ? `<button type="button" class="wheels-dir-switch" id="btn-eta-detail-op" aria-label="${escapeHtml(t("Switch operator"))}" title="${escapeHtml(t("KMB / Citybus"))}">
          <span class="material-symbols-outlined" aria-hidden="true">swap_horiz</span>
          <span>${escapeHtml(String(route.co || "").toLowerCase() === "ctb" ? t("Citybus") : t("KMB"))}</span>
        </button>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  const dirSwitchHtml = dirSwitchButtons
    ? `<div class="wheels-dir-switch-row">${dirSwitchButtons}</div>`
    : "";

  let stopsHtml = "";
  if (!named.length && etaSelectedStops.length) {
    stopsHtml = `<p class="hint">${escapeHtml(t("{n} path points on map (stop names unavailable).", { n: etaSelectedStops.length }))}</p>`;
  } else if (!named.length) {
    stopsHtml = `<p class="hint">${escapeHtml(t("No stop list for {co} {id}.", { co: coLabel, id: route.id }))}</p>`;
  } else {
    const modeIcon =
      route.kind === "mtr"
        ? "subway"
        : route.kind === "lrt"
          ? "tram"
          : "directions_bus";
    const headRow = routeLineRowHtml({
      kind: "transit",
      line: "solid",
      color,
      icon: modeIcon,
      bodyHtml: `<div class="rt-transit-head">
        <span class="rt-route-id">${escapeHtml(route.id)}</span>
        <span class="rt-route-to">${escapeHtml(etaHasDepartureSwitch(dirs) ? etaDepartureLabel(dir) : (localizeDirLabel(dir, "dest") || dest))}</span>
      </div>`,
    });
    // Bus section fares: board here → terminus (TD section; index-map if zh names)
    const isBusFamily =
      route.kind === "bus" ||
      route.kind === "mtr_bus" ||
      ["kmb", "ctb", "nlb", "lwb", "gmb", "lrtfeeder"].includes(
        String(route.co || "").toLowerCase(),
      );
    const fareBaseOpt = isBusFamily
      ? {
          ...etaRouteAsOption(route, named, dir, named[boardIndex] || null),
          bound: dir.bound || "",
        }
      : null;
    const ticket = getFareType();

    const stopRows = named
      .map((s, i) => {
        const isLast = i === named.length - 1;
        const isEtaStop = i === boardIndex;
        const isBefore = i < boardIndex;
        const reach = reachMins[i];
        let fareHkd = null;
        if (isBusFamily && fareBaseOpt && !isLast) {
          fareHkd = estimateBusBoardFare(fareBaseOpt, named, i, ticket);
          // If alignment failed, name-match this stop alone → terminus
          if (fareHkd == null) {
            fareHkd = estimateBusBoardToTerminusByStop(
              fareBaseOpt,
              {
                name: s.nameEn || s.name_en || s.name,
                name_en: s.nameEn || s.name_en || "",
                nameEn: s.nameEn || s.name_en || "",
                name_tc: s.nameTc || s.name_tc || s.name || "",
                stop_name: s.nameEn || s.name_en || s.name,
                stopId: s.stopId || s.stop_id || "",
              },
              ticket,
            );
          }
        }
        const roleHtml =
          reach != null
            ? `<span class="rt-stop-role rt-stop-eta-mins${isBefore ? " is-past" : ""}">${escapeHtml(formatStopReachLabel(reach, fareHkd))}</span>`
            : "";
        // Circular multi-visit: “2/2” so pin/list don’t collapse same stopId
        const visitHtml =
          s.visitTotal > 1
            ? `<span class="rt-stop-visit" title="${escapeHtml(t("Visit {visitN} of {visitTotal} on this route", { visitN: s.visitN, visitTotal: s.visitTotal }))}">${s.visitN}/${s.visitTotal}</span>`
            : "";
        // Passed rail: route colour lightened toward white (no grey, no alpha)
        const stepColor = isBefore
          ? (cssSupportsColorMix()
              ? `color-mix(in srgb, ${color} 60%, white)`
              : "#ffffff")
          : color;
        let row = routeLineRowHtml({
          kind: "stop",
          line: isLast ? "none" : "solid",
          color: stepColor,
          last: isLast,
          extraClass: `eta-pick-stop${isEtaStop ? " rt-stop-eta-active" : ""}${isBefore ? " eta-stop-before" : ""}`,
          bodyHtml: `<span class="rt-stop-name${isEtaStop ? " is-eta-stop" : ""}${isBefore ? " is-past" : ""}">${escapeHtml(s.name)}${visitHtml}</span>${roleHtml}`,
        });
        row = row.replace(
          "<div ",
          `<div data-eta-stop-idx="${i}" role="button" tabindex="0" aria-pressed="${isEtaStop ? "true" : "false"}" title="${escapeHtml(t("Show ETA at this stop"))}" `,
        );
        return row;
      })
      .join("");
    stopsHtml = `<div class="plan-timeline plan-route-line plan-route-line-full eta-route-line" aria-label="${escapeHtml(t("Stops on route"))}">${headRow}${stopRows}</div>`;
  }

  els.etaRouteDetailBody.innerHTML = `
    <div class="wheels-route-detail">
      <div class="wheels-route-detail-fixed">
        <div class="wheels-eta-card" id="eta-detail-card" style="--wheels-route-color:${safeCssColor(color, "#888888")}">
          <div class="wheels-eta-dest">
            <span class="material-symbols-outlined wheels-eta-dest-icon" aria-hidden="true">arrow_forward</span>
            <span class="wheels-eta-dest-text">${escapeHtml(panelDest)}</span>
            <span class="wheels-eta-updated" data-eta-updated data-fetched-at="${Number.isFinite(Number(etaResult?.fetchedAt)) ? Number(etaResult?.fetchedAt) : ""}">${escapeHtml(formatUpdatedAgo(etaResult?.fetchedAt))}</span>
          </div>
          <p class="wheels-eta-board" id="eta-detail-board"${boardText ? "" : " hidden"}>${escapeHtml(boardText)}</p>
          <div class="wheels-eta-slots" id="eta-detail-slots" role="list" aria-label="${hasLive ? escapeHtml(t("Live arrivals")) : escapeHtml(t("Scheduled departures"))}">
            ${etaBigHtml}
          </div>
        </div>
        ${dirSwitchHtml}
        <button
          type="button"
          class="wheels-full-route-toggle"
          id="btn-eta-full-route"
          aria-expanded="true"
          aria-controls="eta-detail-card"
          title="${escapeHtml(t("Hide ETA to browse the full stop list"))}"
        >
          <span class="material-symbols-outlined" aria-hidden="true">expand_less</span>
          <span class="wheels-full-route-label">${escapeHtml(t("Full route"))}</span>
          <span class="wheels-stop-count">${escapeHtml(t("{n} stops", { n: named.length || etaSelectedStops.length }))}</span>
        </button>
      </div>
      <div class="wheels-stop-panel" id="eta-detail-stops">
        ${stopsHtml}
      </div>
    </div>`;

  const panel = els.etaRouteDetailBody.querySelector("#eta-detail-stops");
  if (panel && preserveScroll) panel.scrollTop = prevScroll;

  els.etaRouteDetailBody
    .querySelector("#btn-eta-detail-dir")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dirs || dirs.length < 2) return;
      const asDeparture =
        e.currentTarget?.getAttribute("data-action") === "departure" ||
        etaHasDepartureSwitch(dirs);
      // Opposite = reverse only; Switch Departure cycles AM/PM variants.
      const next = asDeparture
        ? etaNextDepartureIndex(di, dirs)
        : etaOppositeDirIndex(di, dirs);
      if (next === di) return;
      const to = dirs[next];
      if (route.kind === "mtr" && to?.branch) {
        etaDetailMtrBranchOverride = String(to.branch).toUpperCase();
      } else if (route.kind === "mtr") {
        etaDetailMtrBranchOverride = null;
      }
      setCardDir(route, next);
      syncDirChoiceToLive(route, next, dirs);
      // If on first station of current dir → board first of opposite
      // (first of reverse = previous terminus). Otherwise match same stop.
      if (selectedIndex === 0) {
        etaDetailStopIndex = 0;
      } else {
        // Keep physical station if present on reverse list after reload
        const curStop = named[selectedIndex];
        const code = String(
          curStop?.stationCode || curStop?.code || "",
        ).toUpperCase();
        etaDetailStopIndex = 0;
        if (code && route.kind === "mtr") {
          // loadEtaRouteStops will rebuild; mark preferred board via live meta
          const live = etaLiveByKey.get(etaRouteKey(route)) || {};
          etaLiveByKey.set(etaRouteKey(route), {
            ...live,
            stopId: code,
            stopLabel: curStop?.name || live.stopLabel || "",
            bound: to?.bound || live.bound,
          });
        }
      }
      void showEtaRouteDetailsPanel();
    });

  els.etaRouteDetailBody
    .querySelector("#btn-eta-detail-branch")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dirs || dirs.length < 2) return;
      const next = etaNextBranchIndex(di, dirs);
      if (next === di) return;
      const to = dirs[next];
      if (route.kind === "mtr" && to?.branch) {
        etaDetailMtrBranchOverride = String(to.branch).toUpperCase();
      }
      setCardDir(route, next);
      syncDirChoiceToLive(route, next, dirs);
      // Stay at same physical board when possible (shared trunk stations)
      const curStop = named[selectedIndex];
      const code = String(
        curStop?.stationCode || curStop?.code || "",
      ).toUpperCase();
      etaDetailStopIndex = 0;
      if (code) {
        const live = etaLiveByKey.get(etaRouteKey(route)) || {};
        etaLiveByKey.set(etaRouteKey(route), {
          ...live,
          stopId: code,
          stopLabel: curStop?.name || live.stopLabel || "",
          bound: to?.bound || live.bound,
        });
      }
      void showEtaRouteDetailsPanel();
    });

  els.etaRouteDetailBody
    .querySelector("#btn-eta-detail-op")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ops = jointOpsOf(route);
      if (ops.length < 2) return;
      const cur = String(route.co || "kmb").toLowerCase();
      const next = ops[(Math.max(0, ops.indexOf(cur)) + 1) % ops.length];
      route.co = next;
      route.label = `${next === "ctb" ? "CTB" : next === "lwb" ? "LWB" : "KMB"} ${route.id}`;
      route.jointOps = ops;
      void showEtaRouteDetailsPanel();
    });

  // Mobile: hide ETA card so half-height drawer can show the full stop list.
  // Desktop: “Full route” is a static label (arrow hidden via CSS); click is a no-op.
  // Opposite stays visible while ETA is collapsed so direction can still flip.
  const toggle = els.etaRouteDetailBody.querySelector("#btn-eta-full-route");
  const detailRoot = els.etaRouteDetailBody.querySelector(".wheels-route-detail");
  toggle?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      typeof matchMedia !== "undefined" &&
      matchMedia("(min-width: 641px)").matches
    ) {
      return;
    }
    const etaCollapsed = detailRoot?.classList.toggle("is-eta-collapsed");
    // aria-expanded = ETA panel is shown
    toggle.setAttribute("aria-expanded", etaCollapsed ? "false" : "true");
    const ic = toggle.querySelector(".material-symbols-outlined");
    const lab = toggle.querySelector(".wheels-full-route-label");
    if (ic) ic.textContent = etaCollapsed ? "expand_more" : "expand_less";
    if (lab) lab.textContent = etaCollapsed ? "Show ETA" : "Full route";
    toggle.title = etaCollapsed
      ? "Show live / scheduled ETA"
      : "Hide ETA to browse the full stop list";
  });

  const pickStop = (idx) => {
    if (!Number.isFinite(idx) || idx < 0 || idx >= named.length) return;
    if (idx === etaDetailStopIndex && preserveScroll) return;

    // MTR/LRT: last station → auto-switch to opposite direction’s first station
    if (
      idx === named.length - 1 &&
      dirs.length >= 2 &&
      (route.kind === "mtr" || route.kind === "lrt") &&
      etaAutoFlipAtTerminus(route, dirs, di, named[idx])
    ) {
      etaDetailStopIndex = 0;
      void showEtaRouteDetailsPanel();
      return;
    }

    etaDetailStopIndex = idx;
    // Remember visit for pin / live cache (circular multi-visit)
    try {
      const key = etaRouteKey(route);
      const prev = etaLiveByKey.get(key) || {};
      const s = named[idx];
      etaLiveByKey.set(key, {
        ...prev,
        stopId: s?.stopId || prev.stopId,
        stopLabel: s?.name || prev.stopLabel,
        stopIndex: idx,
        stopSeq: s?.seq ?? idx + 1,
        visitN: s?.visitN,
      });
    } catch {
      /* ignore */
    }
    // Grey path already passed (monotonic cut for circular revisits)
    try {
      applyEtaRouteProgressOnMap(idx, { fit: false });
    } catch {
      /* ignore */
    }
    void renderEtaRouteDetailBody(route, {
      ...ctx,
      selectedIndex: idx,
      preserveScroll: true,
    });
    void busPosSyncState();
  };

  panel?.querySelectorAll("[data-eta-stop-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      pickStop(Number(el.getAttribute("data-eta-stop-idx")));
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pickStop(Number(el.getAttribute("data-eta-stop-idx")));
      }
    });
  });

  // Pin in liquid-glass bottom chrome — this specific visit (circular-safe)
  const pinBtn = document.getElementById("btn-eta-detail-pin");
  if (pinBtn) {
    const pinStop = boardStop
      ? {
          ...boardStop,
          stopIndex: boardIndex,
          seq: boardStop.seq ?? boardIndex + 1,
        }
      : null;
    const pinnedNow = isRoutePinned(route, pinStop);
    pinBtn.classList.toggle("is-pinned", pinnedNow);
    pinBtn.title = pinnedNow ? t("Unpin stop") : t("Pin this stop");
    pinBtn.setAttribute(
      "aria-label",
      pinnedNow ? t("Unpin stop") : t("Pin this stop"),
    );
    const labelEl = pinBtn.querySelector(".eta-detail-chrome-label");
    if (labelEl) labelEl.textContent = pinnedNow ? t("Pinned") : t("Pin stop");
    const ic = pinBtn.querySelector(".material-symbols-outlined");
    if (ic) ic.textContent = pinnedNow ? "keep" : "push_pin";
    pinBtn.onclick = () => {
      const nowPinned = togglePinnedEtaRoute(route, pinStop);
      const label = boardStop?.name
        ? `${route.id} @ ${boardName || boardStop.name}`
        : route.id;
      showToast(nowPinned ? `Pinned ${label}` : `Unpinned ${label}`, 1600);
      syncPinnedRouteToolbar();
      pinBtn.classList.toggle("is-pinned", nowPinned);
      pinBtn.title = nowPinned ? t("Unpin stop") : t("Pin this stop");
      pinBtn.setAttribute(
        "aria-label",
        nowPinned ? t("Unpin stop") : t("Pin this stop"),
      );
      if (labelEl) labelEl.textContent = nowPinned ? t("Pinned") : t("Pin stop");
      if (ic) ic.textContent = nowPinned ? "keep" : "push_pin";
    };
  }

  // Keep selected stop in view when first opening (not when re-picking)
  if (!preserveScroll && panel && boardIndex > 0) {
    const sel = panel.querySelector(
      `[data-eta-stop-idx="${boardIndex}"]`,
    );
    sel?.scrollIntoView({ block: "center", behavior: "auto" });
  }

  // Remember the rendered state so the 60 s silent ETA-card refresh can reuse it
  etaDetailCtx = { ...ctx, route, boardStop, boardName, boardIndex };
}

/**
 * Silent 60 s refresh of the route-detail ETA card while the page stays open.
 * Patches only the card (slots / board line / “Updated Ns ago” chip) from the
 * last full-render ctx; the stop list and the map are left untouched. A
 * superseding refresh, a newer full render, or a stop switch all win via the
 * guards below — a failed fetch keeps the previous card for the next tick.
 */
async function refreshEtaRouteDetailEta() {
  if (document.visibilityState !== "visible") return;
  if (sidebarPage !== "eta-route") return;
  const route = etaSelectedForDetails;
  const ctx = etaDetailCtx;
  if (!route || !ctx || !ctx.named?.length) return;
  if (etaRouteKey(ctx.route) !== etaRouteKey(route)) return;
  if (etaDetailStopIndex !== ctx.boardIndex) return; // stop switched mid-flight
  const root = els.etaRouteDetailBody;
  if (!root) return;
  if (root.querySelector(".wheels-route-detail")?.classList.contains("is-eta-collapsed")) return;

  const fetchId = ++etaDetailRefreshGen;
  let etaResult = null;
  try {
    const opt = etaRouteAsOption(ctx.route, etaSelectedStops, ctx.dir, ctx.boardStop);
    const raw = await fetchBoardEta(opt);
    etaResult = resolveBrowseEta(raw, opt, {
      dest: ctx.dest,
      route: ctx.route.id,
    });
  } catch (e) {
    console.warn("[eta] detail silent refresh", e);
    return; // keep the previous card — the next tick retries
  }
  if (fetchId !== etaDetailRefreshGen) return; // a newer refresh superseded us
  if (etaDetailCtx !== ctx) return; // a newer full render replaced us
  if (etaDetailStopIndex !== ctx.boardIndex) return;
  if (sidebarPage !== "eta-route" || !els.etaRouteDetailBody) return;

  const { html: etaBigHtml, hasLive } = wheelsEtaSlotsHtml(etaResult, {
    kind: ctx.route.kind,
  });
  const slotsEl = els.etaRouteDetailBody.querySelector("#eta-detail-slots");
  if (slotsEl) {
    slotsEl.innerHTML = etaBigHtml;
    slotsEl.setAttribute(
      "aria-label",
      hasLive ? "Live arrivals" : "Scheduled departures",
    );
  }
  // Board line — serving platforms can differ per live result
  const platOk = etaOperatorShowsPlatform(etaResult.operator);
  const plats = platOk ? etaResult?.servingPlatforms || [] : [];
  const boardText =
    ctx.boardName && plats.length
      ? stationNameWithPlatforms(stationBaseName(ctx.boardName), plats)
      : ctx.boardName;
  const boardEl = els.etaRouteDetailBody.querySelector("#eta-detail-board");
  if (boardEl) {
    boardEl.textContent = boardText;
    boardEl.hidden = !boardText;
  }
  // “Updated Ns ago” chip — reset to the fresh fetch time
  const updatedEl = els.etaRouteDetailBody.querySelector("[data-eta-updated]");
  if (updatedEl) {
    const t = Number(etaResult?.fetchedAt);
    updatedEl.dataset.fetchedAt = Number.isFinite(t) ? String(t) : "";
    updatedEl.textContent = formatUpdatedAgo(etaResult?.fetchedAt);
  }
}

// Route-detail ETA card: silent refresh every minute while the page is open
setInterval(() => {
  void refreshEtaRouteDetailEta();
}, 60_000);

// Live ETA waits count down every second (same round-to-minute rule as
// waitMinutesFromIso) against the fetched ETA times, so the card tracks the
// bus instead of freezing the value fetched at open. The moment the soonest
// ETA passes the detail card re-fetches — the marker is anchored to the same
// ETAs, so the map arrival and the roll to the next bus stay in sync (the
// fixed 60 s refresh could otherwise still show “1 min” while the bus sat at
// the stop and then drove past it).
let etaDetailDueRefreshedAt = 0;
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  let soonest = Infinity;
  let soonestEl = null;
  for (const el of document.querySelectorAll(".wheels-eta-wait[data-eta-t]")) {
    const t = Number(el.dataset.etaT || 0);
    if (!Number.isFinite(t) || t <= 0) continue;
    const mins = Math.max(0, Math.round((t - now) / 60_000));
    el.textContent = formatWaitCompact(mins);
    el.closest(".wheels-eta-slot")?.classList.toggle("is-due", mins <= 0);
    if (t < soonest) {
      soonest = t;
      soonestEl = el;
    }
  }
  if (
    soonestEl &&
    soonestEl.closest("#eta-detail-slots") &&
    soonest <= now &&
    now - etaDetailDueRefreshedAt > 15_000
  ) {
    etaDetailDueRefreshedAt = now;
    void refreshEtaRouteDetailEta();
  }
}, 1_000);

/**
 * Open ETA route detail page — Wheels-style hero + ETA card + stop timeline.
 */
async function showEtaRouteDetailsPanel(opts = {}) {
  if (!opts.fromTrip) etaRouteReturnTrip = null;
  syncEtaRouteBackChrome();
  const route = etaSelectedForDetails;
  if (!route) {
    showToast(t("Select a route first"), 1800);
    return;
  }
  const gen = ++etaShapeGen;
  // setSidebarPage handles full-sheet on mobile for eta-route
  setSidebarPage("eta-route");

  // Ensure fare pack is ready so section prices aren’t blank on first open
  try {
    await faresReadyPromise;
  } catch {
    /* tables optional */
  }

  const co = String(route.co || "").toLowerCase();
  if (co === "ctb") await ensureCtbRouteBound(route.id);
  if (co === "nlb") await ensureNlbRouteBounds();
  if (route.kind === "bus") {
    await ensureKmbRouteBounds();
  }
  if (route.kind === "mtr_bus" || co === "lrtfeeder" || co === "mtrbus") {
    await ensureMtrBusData();
  }
  if (route.kind === "lrt") {
    await ensureLrtRouteData({ force: false });
  }
  if (co === "gmb") {
    await ensureGmbRouteDirections(route.id);
  }
  if (route.kind === "mtr") {
    await ensureMtrStationLinesMap();
  }
  if (gen !== etaShapeGen) return;

  const color = companyLineColor(route);
  const coLabel = etaOperatorDisplayName(route);

  // Big route number lives on the map (Wheels); panel head stays empty/minimal
  if (els.etaRouteDetailHead) {
    els.etaRouteDetailHead.innerHTML = "";
  }
  setMapRouteBadge(coLabel, route.id, color, route.label, route.kind, route);
  if (els.etaRouteDetailBody) {
    els.etaRouteDetailBody.innerHTML = `<p class="hint wheels-route-loading">${escapeHtml(t("Loading route…"))}</p>`;
  }

  // Load stops first; draw path after board index is known (grey = already passed)
  try {
    setMapRouteLoading(true, t("Loading {co} {id}…", { co: coLabel, id: route.id }));
    // Prefetch the GTFS bus-shape file in parallel with the operator stop
    // sequence, so the map line paints as soon as stops arrive (previously
    // the shape fetch only started after stops had loaded).
    if (route.kind === "bus" || route.kind === "mtr_bus") {
      try {
        const { preloadGtfsBusShape } = await import("./routeShapes.js");
        const coPre = String(
          route.co || (route.kind === "mtr_bus" ? "LRTFEEDER" : "KMB"),
        ).toUpperCase();
        void preloadGtfsBusShape({
          route_id: `${coPre}-${route.id}`,
          route_short_name: String(route.id || ""),
          agency: { id: coPre, name: coPre },
        });
      } catch {
        /* best-effort — paint path falls back to OSRM */
      }
    }
    // When switching Opposite, reload stops for the active bound
    const stops = await loadEtaRouteStops(route);
    if (gen !== etaShapeGen) return;
    etaSelectedStops = stops;
    // Baked names are Chinese-first; re-bake for the active language
    etaSelectedStops.forEach((s) => localizeStopName(s));
  } catch (e) {
    if (gen !== etaShapeGen) return;
    console.warn("[eta] details load", e);
  }

  if (gen !== etaShapeGen) return;

  // Full OD for stop list / Opposite — keep all real directions on detail
  // (list cards filter same-station dests separately)
  let dirs = etaRouteDirections(route, { full: true });
  dirs = await filterDirsWithRealStops(route, dirs);
  await Promise.all(dirs.map((d) => hydrateDirSchedule(route, d)));
  if (gen !== etaShapeGen) return;
  // Respect Opposite / list card dir — do not overwrite from live bound
  let di = resolveCardDirIndex(route, dirs);
  if (di >= dirs.length) di = Math.max(0, dirs.length - 1);
  setCardDir(route, di);
  let dir = dirs[di] || dirs[0] || { dest: route.label };
  let dest = dir.destZh || dir.dest || route.label;
  const namedRaw = etaSelectedStops.filter((s) => s.name && !s._polylineOnly);
  // Circular multi-visit labels (S64 revisits Cathay City / loop stops)
  const named = annotateCircularVisits(namedRaw);

  // Board stop: pin visit index first (circular), then live pin, then list index
  const liveMeta = etaLiveByKey.get(etaRouteKey(route));
  const liveBound = String(liveMeta?.bound || "").toUpperCase();
  const dirBound = String(dir?.bound || "").toUpperCase();
  const liveBoundOk =
    !liveBound ||
    !dirBound ||
    liveBound === dirBound ||
    liveBound === "LINE" ||
    liveBound === "LRT" ||
    dirBound === "LINE" ||
    dirBound === "LRT";
  let selectedIndex = Math.min(
    Math.max(0, etaDetailStopIndex >= 0 ? etaDetailStopIndex : 0),
    Math.max(0, named.length - 1),
  );
  // Restore pinned / circular visit (stopIndex / stopSeq / session tap)
  if (!liveBoundOk) {
    selectedIndex = 0;
  } else {
    selectedIndex = resolveCircularBoardIndex(named, {
      stopId: liveMeta?.stopId || route.stopId,
      stopName: liveMeta?.stopLabel || route.stopName,
      nameEn: liveMeta?.stopNameEn || route.stopNameEn,
      stopIndex:
        etaDetailStopIndex >= 0
          ? etaDetailStopIndex
          : Number.isFinite(Number(route.stopIndex))
            ? Number(route.stopIndex)
            : liveMeta?.stopIndex,
      stopSeq: liveMeta?.stopSeq ?? route.stopSeq,
      visitN: liveMeta?.visitN ?? route.visitN,
    });
  }

  // Last station on this bound → auto-switch to opposite direction’s first stop
  // (Opposite control stays available on detail; list cards hide it)
  if (
    named.length >= 2 &&
    selectedIndex === named.length - 1 &&
    dirs.length >= 2 &&
    (route.kind === "mtr" || route.kind === "lrt")
  ) {
    const flipped = etaAutoFlipAtTerminus(route, dirs, di, named[selectedIndex]);
    if (flipped) {
      etaDetailStopIndex = 0;
      if (gen === etaShapeGen) setMapRouteLoading(false);
      void showEtaRouteDetailsPanel();
      return;
    }
  }

  etaDetailStopIndex = selectedIndex;

  // Draw route with passed segment greyed (board index = selected stop)
  // paint with fit:true zooms to the route path once geometry is on the map
  try {
    if (etaSelectedStops.length >= 2) {
      await paintEtaRouteOnMap(route, etaSelectedStops, {
        boardIndex: selectedIndex,
        fit: true,
      });
    } else {
      clearRouteGeometry();
    }
  } catch (e) {
    if (gen !== etaShapeGen) return;
    console.warn("[eta] details paint", e);
  } finally {
    if (gen === etaShapeGen) setMapRouteLoading(false);
  }

  if (gen !== etaShapeGen) return;

  await renderEtaRouteDetailBody(route, {
    gen,
    color,
    coLabel,
    dest,
    dir,
    di,
    dirs,
    named,
    selectedIndex,
    preserveScroll: false,
  });
  void busPosSyncState();
}

/**
 * At a terminus stop: switch to the reverse direction and board there.
 * @param {EtaRouteEntry} route
 * @param {Array<{ bound?: string, branch?: string }>} dirs
 * @param {number} di
 * @param {{ stationCode?: string, code?: string, name?: string }} lastStop
 * @returns {boolean} true if direction was changed
 */
function etaAutoFlipAtTerminus(route, dirs, di, lastStop) {
  // Buses / GMB / MTR Bus: never auto-flip (one-way & circular OD differ)
  if (!route || route.kind === "bus" || route.kind === "mtr_bus") return false;
  if (route.kind !== "mtr" && route.kind !== "lrt") return false;
  if (!dirs?.length || dirs.length < 2 || !lastStop) return false;
  const lastCode = String(
    lastStop.stationCode || lastStop.code || "",
  ).toUpperCase();
  let nextDi = di;
  if (route.kind === "mtr" && lastCode) {
    nextDi = etaOppositeDirIndexForTerminus(route.id, dirs, di, lastCode);
    const next = dirs[nextDi];
    let startCode = "";
    try {
      const codes = mtrLineCodesInOrder(
        route.id,
        next?.bound || "I",
        next?.branch || null,
      );
      startCode = codes[0] || "";
    } catch {
      /* ignore */
    }
    if (startCode !== lastCode) {
      const iDi = dirs.findIndex(
        (d, i) =>
          i !== di &&
          (String(d.bound || "").toUpperCase() === "I") !==
            (String(dirs[di]?.bound || "").toUpperCase() === "I"),
      );
      if (iDi >= 0) nextDi = iDi;
      if (
        lastCode === "LMC" ||
        lastCode === "LOW" ||
        lastCode === "LHP" ||
        lastCode === "POA"
      ) {
        etaDetailMtrBranchOverride = lastCode;
      } else if (dirs[di]?.branch) {
        etaDetailMtrBranchOverride = String(dirs[di].branch).toUpperCase();
      }
    } else if (
      String(dirs[nextDi]?.bound || "").toUpperCase() === "I" &&
      dirs[di]?.branch
    ) {
      etaDetailMtrBranchOverride = String(dirs[di].branch).toUpperCase();
    }
  } else {
    nextDi = etaNextDirIndex(di, dirs);
  }
  if (nextDi === di && !etaDetailMtrBranchOverride) return false;
  setCardDir(route, nextDi);
  syncDirChoiceToLive(route, nextDi, dirs);
  return true;
}

function syncEtaModeChips() {
  document.querySelectorAll(".eta-method-pill[data-eta-mode]").forEach((btn) => {
    const mode = btn.getAttribute("data-eta-mode") || "";
    const on = etaTrafficModes.has(/** @type {"bus"|"mtr"|"lrt"|"gmb"} */ (mode));
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // Hint on the group when All (none selected)
  const group = document.querySelector(".eta-method-pills");
  if (group) {
    group.classList.toggle("is-all", etaFilterIsAll());
    group.setAttribute(
      "data-filter",
      etaFilterIsAll() ? "all" : [...etaTrafficModes].join("+"),
    );
  }
}

function setEtaSearchOpen(open) {
  const want = !!open;
  // Morph via class only (keep field in layout for width animation)
  if (els.appNavSearchWrap) {
    els.appNavSearchWrap.classList.toggle("is-open", want);
  }
  // Apple Music–style: only current tab icon stays visible while search is open.
  // Always clear both classes together so CSS can't stick in open layout.
  if (els.appBottomNav) {
    els.appBottomNav.classList.toggle("is-search-open", want);
  }
  if (!want) {
    // Leaving search mode — drop the query and bounce back to the browse
    // list so the pill never reopens with a stale search (tab switch,
    // pinned tap, Escape, mode change, collapse-on-empty).
    if (els.inputEtaRoute) els.inputEtaRoute.value = "";
    els.appNavSearchWrap?.classList.remove("is-open");
    els.appBottomNav?.classList.remove("is-search-open");
    void refreshEtaRouteSuggest();
    syncDetailTitle();
  }
  if (els.appNavSearchField) {
    // Never use [hidden] — it fights the expand animation
    els.appNavSearchField.hidden = false;
    els.appNavSearchField.setAttribute("aria-hidden", want ? "false" : "true");
    if (want) els.appNavSearchField.removeAttribute("inert");
    else els.appNavSearchField.setAttribute("inert", "");
  }
  if (els.btnNavSearch) {
    els.btnNavSearch.setAttribute("aria-expanded", String(want));
    // Keep button in DOM for morph (CSS fades it)
    els.btnNavSearch.hidden = false;
    els.btnNavSearch.tabIndex = want ? -1 : 0;
  }
  if (want) {
    setDetailOpen(true);
    if (getUiMode() === "route") {
      // Plan mode: search focuses origin field instead
      els.appNavSearchWrap?.classList.remove("is-open");
      els.appBottomNav?.classList.remove("is-search-open");
      if (els.btnNavSearch) {
        els.btnNavSearch.tabIndex = 0;
        els.btnNavSearch.setAttribute("aria-expanded", "false");
      }
      if (els.appNavSearchField) {
        els.appNavSearchField.setAttribute("aria-hidden", "true");
        els.appNavSearchField.setAttribute("inert", "");
      }
      els.inputOrigin?.focus?.();
      return;
    }
    if (getUiMode() !== "eta") setUiMode("eta");
    if (sidebarPage !== "search" && sidebarPage !== "eta-route") {
      setSidebarPage("search");
    }
    // Double rAF so CSS sees closed → open and runs transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => els.inputEtaRoute?.focus?.());
    });
    syncDetailTitle();
  }
}

function collapseEtaSearchIfEmpty() {
  const q = String(els.inputEtaRoute?.value || "").trim();
  if (!q) setEtaSearchOpen(false);
}

function initEtaRouteSearchUi() {
  const input = els.inputEtaRoute;

  els.btnEtaRouteDetails?.addEventListener("click", () => {
    void showEtaRouteDetailsPanel();
  });
  els.btnEtaRouteBack?.addEventListener("click", () => {
    const trip = etaRouteReturnTrip;
    etaRouteReturnTrip = null;
    if (trip) {
      openTripDetailPage(trip, trip);
      return;
    }
    setSidebarPage("search");
  });

  els.btnEtaPinRoute?.addEventListener("click", () => {
    const route = etaSelectedForDetails;
    if (!route) {
      showToast("Select a route first", 1600);
      return;
    }
    const live = etaLiveByKey.get(etaRouteKey(route));
    const named = etaSelectedStops.filter((s) => s.name && !s._polylineOnly);
    const board =
      (live?.stopId &&
        named.find((s) => String(s.stopId) === String(live.stopId))) ||
      (live?.stopLabel && named.find((s) => s.name === live.stopLabel)) ||
      named[etaDetailStopIndex] ||
      named[0] ||
      null;
    const nowPinned = togglePinnedEtaRoute(route, board);
    const label = board?.name ? `${route.id} @ ${board.name}` : route.id;
    showToast(nowPinned ? `Pinned ${label}` : `Unpinned ${label}`, 1600);
    syncPinnedRouteToolbar();
  });

  els.btnEtaPinned?.addEventListener("click", () => {
    void openPinnedRoutePage();
  });

  document.querySelectorAll(".eta-method-pill[data-eta-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.getAttribute("data-eta-mode") || "";
      const mode =
        raw === "mtr" || raw === "lrt" || raw === "gmb" || raw === "bus"
          ? raw
          : null;
      if (!mode) return;
      // Toggle pill: on → off; none left = All
      if (etaTrafficModes.has(mode)) etaTrafficModes.delete(mode);
      else etaTrafficModes.add(mode);
      syncEtaTrafficModeLegacy();
      etaRouteActive = -1;
      etaSelectedForDetails = null;
      etaSelectedStops = [];
      etaLiveByKey.clear();
      etaNearbyDirsByKey.clear();
      if (els.etaRouteActions) els.etaRouteActions.hidden = true;
      setSidebarPage("search");
      clearRouteGeometry();
      syncEtaModeChips();
      void refreshEtaRouteSuggest();
    });
  });
  syncEtaModeChips();
  syncPinnedRouteToolbar();
  setEtaSearchOpen(false);

  els.btnNavSearch?.addEventListener("click", () => {
    setDetailOpen(true);
    setEtaSearchOpen(true);
    void refreshEtaRouteSuggest();
  });
  els.btnEtaSearchToggle?.addEventListener("click", () => {
    setDetailOpen(true);
    setEtaSearchOpen(true);
    void refreshEtaRouteSuggest();
  });

  if (input) {
    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (getUiMode() !== "eta") return;
        etaRouteActive = -1;
        void refreshEtaRouteSuggest();
      }, 120);
    });

    input.addEventListener("keydown", (e) => {
      if (getUiMode() !== "eta") return;
      if (e.key === "Escape") {
        e.preventDefault();
        // setEtaSearchOpen(false) clears the query and restores browse
        setEtaSearchOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        etaRouteActive = Math.min(
          Math.max(etaRouteActive + 1, 0),
          etaRouteHits.length - 1,
        );
        syncEtaActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        etaRouteActive = Math.max(etaRouteActive - 1, 0);
        syncEtaActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (etaRouteActive >= 0) {
          selectEtaRoute(etaRouteHits[etaRouteActive], etaRouteActive);
        }
      }
    });

    input.addEventListener("focus", () => {
      if (getUiMode() !== "eta") return;
      setDetailOpen(true);
      setEtaSearchOpen(true);
      void refreshEtaRouteSuggest();
    });
  }

  // Reopening the PWA (iOS WebView state restoration after the app was
  // closed) must not resurrect a stale search query — clear the field and
  // collapse back to the tab switcher.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    if (els.inputEtaRoute) els.inputEtaRoute.value = "";
    collapseEtaSearchIfEmpty();
  });

  if (getUiMode() === "eta") {
    if (els.etaSidebarPanel) els.etaSidebarPanel.hidden = false;
    if (els.tripPlanSidebarPanel) els.tripPlanSidebarPanel.hidden = true;
    void ensureMtrStationLinesMap();
    void Promise.all([
      ensureKmbRouteBounds(),
      ensureKmbStops(),
      ensureLrtRouteData().catch(() => {}),
      ensureGmbRouteCodes().catch(() => {}),
    ]).then(() => refreshEtaRouteSuggest());
  }

  void ensureMtrStationLinesMap();
  void ensureKmbRouteBounds();
  void ensureKmbStops();
  void ensureMtrBusData().then(() => {
    buildEtaRouteCatalog();
  });
  void ensureLrtRouteData();
  void ensureGmbRouteCodes();
}

function syncEtaActive() {
  const list = els.etaRouteListSidebar;
  if (!list) return;
  list.querySelectorAll("li[data-idx]").forEach((li) => {
    const i = Number(li.getAttribute("data-idx"));
    const on = i === etaRouteActive;
    li.classList.toggle("is-active", on);
    li.setAttribute("aria-selected", on ? "true" : "false");
    if (on) li.scrollIntoView({ block: "nearest" });
  });
}

initEtaRouteSearchUi();

// Keep toolbar open (close control removed from chrome)
setToolbarOpen(true);
// Panel width is fluid (CSS) — clear any legacy lock
requestAnimationFrame(() => {
  clearDockWidthLock();
  syncDockChromeWidth();
});

// Detail expand/collapse (same dock, height grows/shrinks)
els.btnDetailOpen?.addEventListener("click", () => {
  const open = els.app?.dataset?.detail !== "open";
  if (!open && sidebarPage === "trip") {
    // Collapse dock also leaves trip page
    closeTripDetailPage();
  }
  setDetailOpen(open);
});
els.btnDetailClose?.addEventListener("click", () => {
  if (sidebarPage === "trip") {
    closeTripDetailPage();
    return;
  }
  setDetailOpen(false);
});
// Legacy toggle
els.btnPanel?.addEventListener("click", () => {
  const open = els.app?.dataset?.detail !== "open";
  setDetailOpen(open);
});

// Trip detail sidebar page
els.btnSubpageBack?.addEventListener("click", () => {
  if (sidebarPage === "trip") closeTripDetailPage();
  else setSidebarPage("search");
});

// Pin / unpin the trip shown on the detail page
els.btnSubpagePin?.addEventListener("click", () => {
  const plan = tripDetailPlan();
  if (!plan) return;
  const pinned = togglePinPlan(plan);
  updateSubpagePinButton();
  showToast(pinned ? "Trip plan pinned" : "Trip plan unpinned", 1600);
});

// Instant sync when returning to the tab (PRD dual-loop: Instant Sync)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (sidebarPage === "trip" && tripDetailIdx != null) {
    void refreshTripDetailEtas(tripEtaGen);
  }
});

// Mode switch (app nav Nearby / Trip Plan)
// Search open (Music-style): only current tab icon shows — tap it to close search.
els.modeButtons().forEach((btn) => {
  btn.addEventListener("click", (e) => {
    if (els.appNavSearchWrap?.classList.contains("is-open")) {
      e.preventDefault();
      e.stopPropagation();
      setEtaSearchOpen(false);
      collapseEtaSearchIfEmpty();
      // Clear empty query collapse already handled; blur search
      try {
        els.inputEtaRoute?.blur?.();
      } catch {
        /* ignore */
      }
      return;
    }
    setUiMode(btn.dataset.uiMode || "eta");
  });
});
// Pinned tab: same close-search behaviour when search is expanded
els.btnEtaPinned?.addEventListener(
  "click",
  (e) => {
    if (els.appNavSearchWrap?.classList.contains("is-open")) {
      e.preventDefault();
      e.stopPropagation();
      setEtaSearchOpen(false);
      try {
        els.inputEtaRoute?.blur?.();
      } catch {
        /* ignore */
      }
    }
  },
  true,
);
setUiMode(getUiMode());
setDetailOpen(true);

// Profile menu → Settings / About as panel pages (not modal sheets)
function closeProfileMenu() {
  if (els.profileMenu) {
    els.profileMenu.hidden = true;
    els.profileMenu.setAttribute("hidden", "");
  }
  if (els.btnProfile) els.btnProfile.setAttribute("aria-expanded", "false");
}
function openProfileMenu() {
  if (!els.profileMenu || !els.btnProfile) return;
  els.profileMenu.hidden = false;
  els.profileMenu.removeAttribute("hidden");
  els.btnProfile.setAttribute("aria-expanded", "true");
}
function toggleProfileMenu() {
  if (!els.profileMenu) return;
  if (els.profileMenu.hidden || els.profileMenu.hasAttribute("hidden")) {
    openProfileMenu();
  } else {
    closeProfileMenu();
  }
}
// Ensure menu starts closed (CSS must not force display:flex while hidden)
closeProfileMenu();

els.btnProfile?.addEventListener("click", (e) => {
  e.stopPropagation();
  e.preventDefault();
  // Collapsed sheet shows only the title bar — expand before opening the menu
  if (els.app?.dataset?.sheet === "closed") setSheetState("open");
  toggleProfileMenu();
});
els.btnSettings?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeProfileMenu();
  setSidebarPage("settings");
  void updateDataCacheStatus();
});
els.btnInfo?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeProfileMenu();
  setSidebarPage("about");
});
els.btnLicenses?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeProfileMenu();
  openSheet(els.licensesSheet);
});
els.btnTermsPrivacy?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeProfileMenu();
  openSheet(els.termsPrivacySheet);
});
wireSheet(els.licensesSheet);
wireSheet(els.termsPrivacySheet);
document.addEventListener("click", (e) => {
  const root = els.mapProfile || document.getElementById("map-profile");
  if (!root?.contains(/** @type {Node} */ (e.target))) {
    closeProfileMenu();
  }
});

// Expandable Search (right) — primary entry; setEtaSearchOpen mirrors this

// Mobile sheet grabber — finger-follow + closed / half / full snaps
// Document-level move/up for Safari (pointer capture is unreliable on iOS)
function wireSheetSnap() {
  const chrome = els.sheetChrome;
  const toolbar = document.getElementById("main-toolbar");
  if (!chrome || !toolbar) return;

  let startY = 0;
  let startH = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // px/ms (positive = finger down)
  let dragging = false;
  let moved = false;
  let activePointerId = null;

  const isDesktop = () =>
    typeof matchMedia !== "undefined" &&
    matchMedia("(min-width: 641px)").matches;

  const clampH = (h, snaps) =>
    Math.max(snaps.closed, Math.min(snaps.full, h));

  /**
   * Content height only (chrome+list). CSS adds dock band:
   * height = content + --nav-dock-h so shell stays one piece under fixed nav.
   */
  const applyDragHeight = (contentPx) => {
    const c = Math.round(contentPx);
    document.documentElement.style.setProperty("--sheet-drag-h", `${c}px`);
    // Let CSS calc(content + dock) apply — only set drag token
    toolbar.style.removeProperty("height");
    toolbar.style.removeProperty("max-height");
  };

  const clearDragStyles = () => {
    toolbar.classList.remove("is-sheet-dragging");
    toolbar.style.removeProperty("height");
    toolbar.style.removeProperty("max-height");
    document.documentElement.style.removeProperty("--sheet-drag-h");
  };

  const contentHeightNow = () => {
    const snaps = sheetSnapHeights();
    const dock = snaps.dock || measureNavDockH() || 0;
    const total = toolbar.getBoundingClientRect().height || 0;
    // Prefer published CSS token (content-only)
    const token = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sheet-h"),
    );
    if (Number.isFinite(token) && token > 0) return token;
    if (total > dock) return Math.round(total - dock);
    return snaps.open;
  };

  const onStart = (y, pointerId) => {
    if (isDesktop()) return false;
    dragging = true;
    moved = false;
    activePointerId = pointerId ?? null;
    startY = y;
    lastY = y;
    lastT = performance.now();
    velocity = 0;
    startH = contentHeightNow();
    toolbar.classList.add("is-sheet-dragging");
    applyDragHeight(startH);
    return true;
  };

  const onMove = (y) => {
    if (!dragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    // Finger down → sheet shrinks (dy > 0)
    const dy = y - startY;
    if (Math.abs(dy) > 3) moved = true;
    velocity = (y - lastY) / dt;
    lastY = y;
    lastT = now;
    const snaps = sheetSnapHeights();
    applyDragHeight(clampH(startH - dy, snaps));
  };

  const nearestSnap = (h, v, snaps) => {
    const flick = v * 200;
    const target = h - flick;
    const pts = [
      { k: "closed", h: snaps.closed },
      { k: "open", h: snaps.open },
      { k: "full", h: snaps.full },
    ];
    let best = pts[0];
    let bestD = Math.abs(target - pts[0].h);
    for (const p of pts) {
      const d = Math.abs(target - p.h);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return /** @type {"closed"|"open"|"full"} */ (best.k);
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    activePointerId = null;
    const snaps = sheetSnapHeights();
    const dragToken = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--sheet-drag-h",
      ),
    );
    // Content-only height for snap (not full shell including dock)
    const h = Number.isFinite(dragToken) ? dragToken : contentHeightNow();
    if (!moved) {
      clearDragStyles();
      // Transition was disabled while the drag class was on — flush styles so
      // the tap snap animates instead of jumping (e.g. full → half).
      void toolbar.offsetHeight;
      toggleSheetSnap();
      return;
    }
    const snap = nearestSnap(h, velocity, snaps);
    // Re-arm the transition starting from the released height: pin the height
    // while the drag class comes off, then let setSheetState animate to snap.
    toolbar.style.height = `${Math.round(
      toolbar.getBoundingClientRect().height,
    )}px`;
    toolbar.classList.remove("is-sheet-dragging");
    void toolbar.offsetHeight;
    setSheetState(snap);
  };

  const isProfileHit = (t) =>
    t instanceof Element &&
    !!t.closest(
      "#map-profile, .panel-profile, #btn-profile, #profile-menu, .profile-menu-item",
    );

  chrome.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button != null && e.button !== 0) return;
      if (isProfileHit(e.target)) return;
      if (!onStart(e.clientY, e.pointerId)) return;
      try {
        chrome.setPointerCapture?.(e.pointerId);
      } catch {
        /* Safari may ignore; document listeners cover moves */
      }
      e.preventDefault();
    },
    { passive: false },
  );

  // Document-level so drag continues if finger leaves the grab bar
  const onDocPointerMove = (e) => {
    if (!dragging) return;
    if (activePointerId != null && e.pointerId !== activePointerId) return;
    onMove(e.clientY);
    e.preventDefault();
  };
  const onDocPointerUp = (e) => {
    if (!dragging) return;
    if (activePointerId != null && e.pointerId !== activePointerId) return;
    onEnd();
  };

  document.addEventListener("pointermove", onDocPointerMove, {
    passive: false,
  });
  document.addEventListener("pointerup", onDocPointerUp);
  document.addEventListener("pointercancel", onDocPointerUp);

  // iOS Safari touch fallback (some WebViews lag pointer events)
  chrome.addEventListener(
    "touchstart",
    (e) => {
      if (isDesktop()) return;
      if (isProfileHit(e.target)) return;
      const t = e.changedTouches?.[0];
      if (!t) return;
      onStart(t.clientY, t.identifier);
      e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      const t = e.touches?.[0];
      if (!t) return;
      onMove(t.clientY);
      e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    "touchend",
    () => {
      if (dragging) onEnd();
    },
    { passive: true },
  );
  document.addEventListener(
    "touchcancel",
    () => {
      if (dragging) onEnd();
    },
    { passive: true },
  );

  // Swallow synthetic click after drag/tap handling
  chrome.addEventListener(
    "click",
    (e) => {
      if (isProfileHit(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}
wireSheetSnap();
// Publish initial --sheet-h for tools / attribution offset
try {
  if (
    typeof matchMedia !== "undefined" &&
    matchMedia("(max-width: 640px)").matches
  ) {
    measureNavDockH();
    setSheetState(els.app?.dataset?.sheet || "open");
  }
} catch {
  /* ignore */
}
// iOS PWA: safe-area + visualViewport settle after first paint
try {
  schedulePwaDockRemeasure();
  window.addEventListener("orientationchange", () => {
    setTimeout(() => schedulePwaDockRemeasure(), 200);
  });
} catch {
  /* ignore */
}

/** Contributor path editor (About → Contribute route path) */
const pathContributor = createPathContributor({
  map,
  showToast,
  searchRoutes: async (q) => {
    try {
      await ensureRbsRouteData();
    } catch {
      /* catalog still has franchised buses */
    }
    try {
      await ensureKmbRouteBounds();
    } catch {
      /* directions filled later */
    }
    return searchEtaRoutes(q, 12);
  },
  routeDirections: async (r) => {
    if (!r) return [];
    const co = String(r.co || "").toLowerCase();
    try {
      if (co === "kmb" || co === "lwb" || (r.kind === "bus" && !co)) {
        await ensureKmbRouteBounds();
      }
      if (co === "ctb") await ensureCtbRouteBound(r.id);
      if (co === "nlb") await ensureNlbRouteBounds();
      if (co === "gmb") await ensureGmbRouteDirections(r.id);
      if (r.kind === "lrt") await ensureLrtRouteData();
      if (r.kind === "mtr_bus") await ensureMtrBusData();
    } catch {
      /* still try OD table */
    }
    let dirs = etaRouteDirections(r, { full: true });
    try {
      dirs = await filterDirsWithRealStops(r, dirs);
    } catch {
      /* keep OD */
    }
    return dirs;
  },
  clearRoutePath: () => {
    try {
      clearRouteGeometry();
    } catch {
      /* ignore */
    }
    try {
      setMapRouteLoading(false);
    } catch {
      /* ignore */
    }
  },
  getSelectedPlanRoute: () => {
    if (tripDetailIdx == null && (!plans?.length)) return null;
    const plan = tripDetailIdx != null ? tripDetailPlan() : plans?.[0];
    if (!plan) return null;
    for (const leg of plan.legs || []) {
      if (leg.type !== "transit" || !leg.route_options?.[0]) continue;
      const opt = leg.route_options[0];
      return {
        agency: opt.agency?.id || opt.agency?.name || "",
        route_short_name: opt.route_short_name || "",
        route_id: opt.route_id || "",
        from:
          opt.from?.stop_name ||
          opt.stops?.[0]?.stop_name ||
          "",
        to:
          opt.to?.stop_name ||
          (opt.stops?.length
            ? opt.stops[opt.stops.length - 1]?.stop_name
            : "") ||
          "",
      };
    }
    return null;
  },
  /** Densified transit polyline from last painted plan (lon,lat pairs). */
  getSelectedPlanPolyline: () => {
    const data = lastRouteGeo;
    if (!data?.features?.length) return null;
    for (const f of data.features) {
      if (f.properties?.kind !== "transit") continue;
      const coords = f.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length >= 2) {
        return coords.map((c) => [c[0], c[1]]);
      }
    }
    for (const f of data.features) {
      const coords = f.geometry?.coordinates;
      if (f.geometry?.type === "LineString" && coords?.length >= 2) {
        return coords.map((c) => [c[0], c[1]]);
      }
    }
    return null;
  },
});

// Escape closes sheets → trip page → detail dock
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (pathContributor?.isOpen()) {
    pathContributor.close();
    return;
  }
  if (els.licensesSheet && !els.licensesSheet.hidden) {
    closeSheet(els.licensesSheet);
    return;
  }
  if (els.settingsSheet && !els.settingsSheet.hidden) {
    closeSheet(els.settingsSheet);
    return;
  }
  if (els.infoSheet && !els.infoSheet.hidden) {
    closeSheet(els.infoSheet);
    return;
  }
  if (sidebarPage === "trip") {
    closeTripDetailPage();
    return;
  }
  if (els.app?.dataset?.detail === "open") {
    setDetailOpen(false);
  }
});

els.linkMeta.href = `${DATA_BASE}/metadata.json`;

loadManifest().catch((err) => {
  console.error(err);
  els.metaStatus.textContent = t("Could not reach data edge.");
  showToast(t("Metadata unavailable — map may still load from PMTiles URL"));
});

// PWA: register service worker only in production builds.
// Dev + COEP require-corp: a SW can break large graph fetches.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    // Query-bust so browsers re-fetch sw.js even when an old cache-first SW is live
    const swUrl = `${import.meta.env.BASE_URL}sw.js?v=14`;
    let refreshing = false;
    let updateRequested = false;
    const reloadOnce = () => {
      // Reload only after the user approved an update — never on a silent
      // background activation (first install claims the page in place).
      if (!updateRequested || refreshing) return;
      refreshing = true;
      try {
        window.location.reload();
      } catch {
        /* ignore */
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
    navigator.serviceWorker.addEventListener("message", (ev) => {
      if (ev?.data?.type === "SW_ACTIVATED") reloadOnce();
    });

    navigator.serviceWorker
      .register(swUrl)
      .then((reg) => {
        console.info("[sw] registered", reg.scope);
        const kick = () => {
          try {
            reg.update();
          } catch {
            /* ignore */
          }
        };
        kick();
        // Data cache is opt-in — sync the toggle state into the SW
        notifyDataCachePref();
        // Cloud/Local source preference drives the SW serve decision
        notifyDataSourcePref();
        // A staged update from a previous session — ask before applying.
        if (navigator.serviceWorker.controller && reg.waiting) {
          promptAppUpdate(reg, () => {
            updateRequested = true;
            try {
              reg.waiting?.postMessage?.({ type: "SKIP_WAITING" });
            } catch {
              /* ignore */
            }
          });
        }
        // Standalone often stays warm — re-check when returning to the app
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") kick();
        });
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          let prompted = false;
          nw.addEventListener("statechange", () => {
            if (
              nw.state === "installed" &&
              navigator.serviceWorker.controller &&
              !prompted
            ) {
              prompted = true;
              promptAppUpdate(reg, () => {
                updateRequested = true;
                try {
                  reg.waiting?.postMessage?.({ type: "SKIP_WAITING" });
                } catch {
                  /* ignore */
                }
              });
            }
          });
        });
      })
      .catch((err) => {
        console.warn("[sw] register failed", err);
      });
  });
} else if ("serviceWorker" in navigator) {
  // Clear any previous SW that may block local graph loads
  navigator.serviceWorker.getRegistrations?.().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
}

/** Tell the service worker the current data-cache preference (safe when absent). */
function notifyDataCachePref() {
  const enabled = loadDataCachePref();
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "DATA_CACHE_PREF",
      enabled,
    });
  } catch {
    /* ignore */
  }
  return enabled;
}

/** Tell the service worker the data-source preference (safe when absent). */
function notifyDataSourcePref() {
  const prefer = loadDataSourcePref();
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "DATA_SOURCE_PREF",
      prefer,
    });
  } catch {
    /* ignore */
  }
  return prefer;
}

/**
 * One generic prompt for app/data updates. Returns false when another
 * prompt is already open (callers should skip).
 */
let updateDialogOpen = false;
function showUpdateDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = t("Later"),
  onConfirm,
  onCancel,
}) {
  const overlay = document.getElementById("update-overlay");
  if (!overlay || updateDialogOpen) return false;
  updateDialogOpen = true;
  const titleEl = document.getElementById("update-overlay-title");
  const msgEl = document.getElementById("update-overlay-msg");
  const nowBtn = document.getElementById("btn-update-now");
  const laterBtn = document.getElementById("btn-update-later");
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (nowBtn) nowBtn.textContent = confirmLabel;
  if (laterBtn) laterBtn.textContent = cancelLabel;
  overlay.hidden = false;
  const close = () => {
    overlay.hidden = true;
    updateDialogOpen = false;
    nowBtn?.removeEventListener("click", confirm);
    laterBtn?.removeEventListener("click", cancel);
  };
  const confirm = () => {
    close();
    onConfirm();
  };
  const cancel = () => {
    close();
    onCancel?.();
  };
  nowBtn?.addEventListener("click", confirm);
  laterBtn?.addEventListener("click", cancel);
  return true;
}

/**
 * Ask before applying a staged service-worker update — a silent reload
 * would lose the user's session.
 * @param {ServiceWorkerRegistration} reg
 * @param {() => void} apply
 */
function promptAppUpdate(reg, apply) {
  showUpdateDialog({
    title: t("Update available"),
    message: t("A new version of MORGAN Travelers is ready. Reload now to get it?"),
    confirmLabel: t("Update now"),
    onConfirm: apply,
  });
}

/**
 * Background data check: when the data edge's update stamp differs from
 * the one recorded at the last offline download, offer a refresh. Runs on
 * every launch (see loadManifest).
 * @param {{ updated_at?: string }} meta
 */
function maybePromptDataUpdate(meta) {
  if (!meta?.updated_at) return;
  if (!navigator.serviceWorker?.controller) return; // no SW → no download
  if (!loadDataCachePref()) return;
  const stored = localStorage.getItem(DATA_UPDATED_AT_STORAGE_KEY);
  if (!stored || stored === meta.updated_at) return;
  showUpdateDialog({
    title: t("Data update available"),
    message: t("The transit data has been refreshed on the server. Re-download the offline set to get the latest routes, stops and fares?"),
    confirmLabel: t("Update data"),
    onConfirm: () => {
      const sw = navigator.serviceWorker?.controller;
      if (sw) void startOfflineDownload(sw);
    },
  });
}

/**
 * Report the SW data cache (Settings → Data cache status line).
 * Cache names must stay in sync with public/sw.js DATA_CACHE / TILES_CACHE.
 */
async function updateDataCacheStatus() {
  const el = document.getElementById("data-cache-status");
  const details = document.getElementById("data-cache-details");
  if (!el) return;
  const showStatus = (text) => {
    el.textContent = text;
    el.hidden = false;
    if (details) details.hidden = true;
  };
  const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
  try {
    const controlled = !!sw?.controller;
    const reg = sw ? await sw.getRegistration() : null;
    if (!("caches" in window) || !controlled) {
      const state = loadDataCachePref() ? "inactive" : "off";
      const why = !sw
        ? "service worker unsupported"
        : reg
          ? "service worker registered but not controlling — reload once"
          : "no service worker registered (dev mode or registration blocked)";
      showStatus(`Data cache: ${state} — ${why}`);
      return;
    }
    const { keys, bytes } = await dataCacheStats();
    if (details) {
      // Same label/value style as the Dataset status card above
      details.innerHTML = `<div><dt>Cache</dt><dd>${keys} assets · ${(bytes / 1048576).toFixed(1)} MB</dd></div>`;
      details.hidden = false;
      el.hidden = true;
    } else {
      showStatus(`Cache: ${keys} assets · ${(bytes / 1048576).toFixed(1)} MB`);
    }
  } catch {
    showStatus("Data cache: unavailable");
  }
}

// Debug / E2E: expose map + stop helpers on window
if (typeof window !== "undefined") {
  window.__morganMap = map;
  window.__morganDebug = {
    ensureRouteLayers,
    setRouteStops,
    stopsGeoFromPlan,
    promoteRouteStopLayers,
    setPoint,
    getPlans: () => plans,
    getVia: () => vias[0]?.point || null,
    getVias: () => vias.map((v) => v.point).filter(Boolean),
    selectPlan,
    runPlan,
  };
}

// ── Live bus positions (PRD 4.2, Beta) ─────────────────────────────────────
// Self-contained additive block: Beta toggle UI, engine lifecycle, marker
// layers, and the PRD 4.3 loops (Instant Sync / Pulse / Baseline). The engine
// runs only while the ETA route-detail page shows a KMB/CTB/NLB bus route AND
// the settings toggle is on; otherwise the app behaves exactly as before — no
// timers, no map sources, no fetches. No existing function is edited.

let busPosEngine = null;
let busPosSyncing = false;
let busPosCheapSig = ""; // last synced detail-state signature
let busPosSig = ""; // signature of the running engine's ctx
let busPosLayersOn = false;
let busPosModPromise = null;
let busPosRouteShapesPromise = null;
const getBusPosMod = () =>
  (busPosModPromise ||= import("./busPositionEngine.js"));
const getBusPosRouteShapesMod = () =>
  (busPosRouteShapesPromise ||= import("./routeShapes.js"));
const BUS_POS_LAYER_IDS = [
  "bus-pos-halo",
  "bus-pos-radar",
  "bus-pos-dot",
];

function promoteBusPosLayers() {
  if (!map?.getStyle) return;
  for (const id of BUS_POS_LAYER_IDS) {
    try {
      if (map.getLayer(id)) map.moveLayer(id);
    } catch {
      /* style not ready */
    }
  }
}

/** After the ETA path is painted, hand the polyline to the live-pos engine
 *  (rail densify lives only in paint — don't run it twice). */
function busPosAdoptMapGeom() {
  if (!busPosEngine?.running || !etaMapGeomCache?.coords?.length) return;
  const st = busPosDetailState();
  if (!st) return;
  const coords = etaMapGeomCache.coords
    .map((c) => ({ lon: Number(c[0]), lat: Number(c[1]) }))
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (coords.length < 2 || !busPosProjectOntoShape) return;
  const stopDistM = [];
  let searchFrom = 0;
  for (const s of st.named) {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) {
      stopDistM.push(NaN);
      continue;
    }
    const p = busPosProjectOntoShape(coords, s.lon, s.lat, searchFrom);
    if (!p) {
      stopDistM.push(NaN);
      continue;
    }
    stopDistM.push(p.alongM);
    searchFrom = p.segEnd;
  }
  const cumM = [0];
  for (let i = 1; i < coords.length; i++) {
    cumM.push(cumM[i - 1] + busPosDistM(coords[i - 1].lon, coords[i - 1].lat, coords[i].lon, coords[i].lat));
  }
  const shape = { coords, cumM };
  busPosShape = shape;
  busPosEngine.updateBoard({ stopDistM, shape });
}

// Marker cosmetics + animation state (PRD 4.2 marker enhancements):
// eased glide between emits, route-colored outline/text, white fill, radar
// pulse. All values are (re)set when the engine (re)starts for a route.
const busPosDisplay = new Map(); // id → eased display state
let busPosAnimId = 0; // rAF handle of the marker/radar render loop
// Drawn shape for the path-following glide (captured once per engine start):
// retargets project positions onto it (alongM) and frames render back to
// lon/lat along the polyline, so markers round curves instead of cutting
// straight across. Cleared when the engine stops.
let busPosShape = null;
let busPosAlongToLonLat = null; // engine module export (getBusPosMod)
let busPosProjectOntoShape = null; // routeShapes export (getBusPosRouteShapesMod)
let busPosColor = ETA_AGENCY_GTFS_COLORS.kmb; // route line color
let busPosRgb = [238, 23, 31]; // same color as [r, g, b] for rgba() expressions
const busPosReducedMotion =
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
const BUS_POS_RADAR_MS = 5000; // radar pulse period

/** Equirectangular distance between two lon/lat points (m). */
function busPosDistM(lon1, lat1, lon2, lat2) {
  const cos = Math.cos((lat1 + lat2) * (Math.PI / 360));
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * cos;
  return Math.hypot(dLat, dLon);
}

/** "#RRGGBB" → [r, g, b] (radar ring needs rgba() with a per-phase alpha). */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return [238, 23, 31];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Current detail-page state the engine needs, or null when it must not run:
 * bus route (KMB/CTB/NLB), toggle on, eta-route page open, named stops with
 * ETA-able stop ids, and a board stop. Sync-only — never awaits.
 */
function busPosDetailState() {
  const route = etaSelectedForDetails;
  if (!route) return null;
  if (!loadLiveBusPref()) return null;
  if (sidebarPage !== "eta-route") return null;
  const kind = route.kind;
  let co = String(route.co || "").toLowerCase();
  if (kind === "mtr") co = "mtr";
  else if (kind === "lrt") co = "lrt";
  else if (kind !== "bus" || !["kmb", "ctb", "nlb"].includes(co)) return null;
  const named = etaSelectedStops.filter((s) => s.name && !s._polylineOnly);
  if (named.length < 2) return null;
  const boardIndex = Math.min(
    Math.max(0, etaDetailStopIndex >= 0 ? etaDetailStopIndex : 0),
    named.length - 1,
  );
  if (!named[boardIndex]?.stopId && kind !== "mtr" && kind !== "lrt") return null;
  if ((kind === "mtr" || kind === "lrt") && !named[boardIndex]) return null;
  return { route, co, kind, named, boardIndex, fetchMore: loadLiveBusMorePref() };
}

/** Cheap signature of the detail state (direction flips change it). */
function busPosCheapSigOf(st) {
  const dirs = etaRouteDirections(st.route, { full: true });
  let di = resolveCardDirIndex(st.route, dirs);
  if (di >= dirs.length) di = Math.max(0, dirs.length - 1);
  const dir = dirs[di] || dirs[0] || {};
  const bound = String(dir.bound || "O").toUpperCase();
  return [
    canonicalLivePosOp(st.co, st.route.id),
    String(st.route.id || ""),
    bound === "LINE" ? String(st.kind || "") : bound,
    String(dir?.serviceType ?? dir?.service_type ?? ""),
    String(dir?.routeId || ""),
    st.named.length,
    st.fetchMore ? "more" : "",
  ].join("|");
}

/**
 * Build the engine ctx for the current detail state (async: direction
 * filtering, GTFS shape, stop along-shape distances). Returns null when the
 * route has no usable shape.
 */
async function busPosBuildCtx(st) {
  // Same direction resolution as showEtaRouteDetailsPanel (filtered dirs + card)
  const dirs = await filterDirsWithRealStops(
    st.route,
    etaRouteDirections(st.route, { full: true }),
  );
  if (!dirs?.length) return null;
  let di = resolveCardDirIndex(st.route, dirs);
  if (di >= dirs.length) di = Math.max(0, dirs.length - 1);
  const dir = dirs[di] || dirs[0];
  const bound = String(dir?.bound || "O").toUpperCase();
  const isRailKind = st.kind === "mtr" || st.kind === "lrt";
  if (!isRailKind && (bound === "LINE" || bound === "LRT")) return null;

  const { getGtfsBusShape, projectOntoShape, cumulativeMeters } =
    await getBusPosRouteShapesMod();
  busPosProjectOntoShape = projectOntoShape;
  const coUp = st.co.toUpperCase();
  const opt = {
    route_id: `${coUp}-${st.route.id}`,
    route_short_name: String(st.route.id || ""),
    agency: { id: coUp, name: coUp },
    bound,
    stops: st.named,
    headsign: dir?.dest || "",
    from: st.named[0],
    to: st.named[st.named.length - 1],
  };

  // Full-route line only: exact contributed override, else GTFS.
  // Do not use a sliced map cache or a "similar" corridor — the engine
  // projects every schedule stop onto this line; a short/wrong slice
  // drops every pattern and the markers never appear.
  /** @type {Array<{ lon: number, lat: number }> | null} */
  let coords = null;
  let usedContrib = false;
  if (isRailKind) {
    // Do NOT densify rails here — paintEtaRouteOnMap already snaps to the
    // basemap. A second densify raced the path draw and left MTR/LRT with
    // no line. Reuse the painted polyline, else stop chords until paint lands.
    const cached = etaMapGeomCache?.coords;
    if (cached?.length >= 2) {
      coords = cached
        .map((c) => ({ lon: Number(c[0]), lat: Number(c[1]) }))
        .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
    }
    if (!coords || coords.length < 2) {
      coords = st.named
        .filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat))
        .map((s) => ({ lon: s.lon, lat: s.lat }));
    }
  } else {
    try {
      const override = matchBusShapeOverride(opt);
      const exact =
        override &&
        String(override.route_short_name || "").trim().toUpperCase() ===
          String(st.route.id || "").trim().toUpperCase();
      if (exact && override.coordinates?.length >= 2) {
        coords = override.coordinates
          .map((c) => ({ lon: Number(c[0]), lat: Number(c[1]) }))
          .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
        if (coords.length < 2) coords = null;
        else usedContrib = true;
      }
    } catch (e) {
      console.warn("[buspos] contributed shape", e);
    }
    if (!coords) {
      const gtfs = await getGtfsBusShape(opt);
      if (gtfs?.coords?.length >= 2) coords = gtfs.coords;
    }
  }
  if (!coords?.length) {
    console.warn("[buspos] no shape for", st.co, st.route.id, bound);
    return null;
  }

  const measure = (line) => {
    const stopDistM = [];
    let searchFrom = 0;
    let ok = 0;
    for (const s of st.named) {
      if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) {
        stopDistM.push(NaN);
        continue;
      }
      const p = projectOntoShape(line, s.lon, s.lat, searchFrom);
      if (!p) {
        stopDistM.push(NaN);
        continue;
      }
      stopDistM.push(p.alongM);
      searchFrom = p.segEnd;
      ok += 1;
    }
    return { stopDistM, ok };
  };

  let { stopDistM, ok } = measure(coords);
  if (usedContrib && ok < 2) {
    const gtfs = await getGtfsBusShape(opt);
    if (gtfs?.coords?.length >= 2) {
      coords = gtfs.coords;
      ({ stopDistM, ok } = measure(coords));
    }
  }
  const cumM = cumulativeMeters(coords);
  if (!cumM?.length) {
    console.warn("[buspos] empty shape measure for", st.co, st.route.id);
    return null;
  }
  const shape = { coords, cumM };

  const serviceType =
    Number(dir?.serviceType ?? dir?.service_type) ||
    Number(
      (kmbRouteBoundsMap?.get(String(st.route.id || "").toUpperCase()) || []).find(
        (b) => String(b.bound || "").toUpperCase() === bound,
      )?.service_type,
    ) ||
    1;
  const sig = [
    canonicalLivePosOp(st.co, st.route.id),
    String(st.route.id || ""),
    bound,
    String(serviceType),
    String(dir?.routeId || ""),
    st.named.length,
  ].join("|");

  return {
    sig,
    ctx: {
      op: st.co,
      routeId: String(st.route.id || ""),
      routeShort: String(st.route.id || ""),
      bound,
      serviceType,
      stops: st.named.map((s, i) => ({
        stopId: s.stopId || s.stationCode || s.code || "",
        seq: s.seq ?? i + 1,
        lon: s.lon,
        lat: s.lat,
      })),
      boardStopIndex: st.boardIndex,
      shape,
      stopDistM,
      fetchMore: !!st.fetchMore,
      nlbRouteIds: st.co === "nlb" ? [String(dir?.routeId || "")].filter(Boolean) : undefined,
    },
  };
}

/** Start/stop/restart the engine to match the current detail state. */
async function busPosSyncState() {
  const st = busPosDetailState();
  const cheap = st ? busPosCheapSigOf(st) : "";
  if (!cheap) {
    if (busPosEngine || busPosLayersOn) busPosStopEngine();
    busPosCheapSig = "";
    busPosSig = "";
    return;
  }
  if (busPosEngine && cheap === busPosCheapSig) {
    const ctx = busPosEngine.ctx;
    const opChanged =
      String(ctx?.op || "").toLowerCase() !== String(st.co || "").toLowerCase();
    const boardChanged = ctx?.boardStopIndex !== st.boardIndex;
    if (boardChanged || opChanged) {
      busPosEngine.updateBoard({
        boardStopIndex: st.boardIndex,
        op: st.co,
        stops: st.named.map((s, i) => ({
          stopId: s.stopId || s.stationCode || s.code || "",
          seq: s.seq ?? i + 1,
          lon: s.lon,
          lat: s.lat,
        })),
        fetchMore: st.fetchMore,
      });
      void busPosEngine.poll();
    }
    return;
  }
  if (busPosSyncing) return;
  busPosSyncing = true;
  try {
    busPosCheapSig = cheap;
    const built = await busPosBuildCtx(st);
    const st2 = busPosDetailState();
    // Ignore cheap-sig flicker (map cache landing mid-build). Only drop if
    // the user left the page or switched route / bound.
    if (!st2) return;
    const cheapNow = busPosCheapSigOf(st2);
    const sameRoute =
      cheapNow.split("|").slice(0, 5).join("|") ===
      cheap.split("|").slice(0, 5).join("|");
    if (!sameRoute) return;
    if (busPosEngine) busPosStopEngine();
    if (!built) return;
    const { BusPositionEngine, alongToLonLat } = await getBusPosMod();
    busPosAlongToLonLat = alongToLonLat;
    busPosEngine = new BusPositionEngine({ onUpdate: busPosOnUpdate });
    busPosEngine.start(built.ctx);
    busPosShape = built.ctx.shape;
    busPosSig = built.sig;
    if (busPosEngine.running) {
      // Route line color → marker outline, route-number text, radar ring
      busPosColor = companyLineColor(st.route) || ETA_AGENCY_GTFS_COLORS.kmb;
      busPosRgb = hexToRgb(busPosColor);
      busPosEnsureLayers();
      void busPosEngine.poll();
      syncBetaBanner();
    }
  } finally {
    busPosSyncing = false;
  }
}

function busPosStopEngine() {
  busPosEngine?.stop();
  busPosEngine = null;
  busPosShape = null;
  busPosSig = "";
  if (busPosAnimId) cancelAnimationFrame(busPosAnimId);
  busPosAnimId = 0;
  busPosDisplay.clear();
  busPosRemoveLayers();
  syncBetaBanner();
}

/** GeoJSON source + three marker layers, added above everything on start. */
function busPosEnsureLayers() {
  if (!map?.getStyle || busPosLayersOn) return;
  if (!map.getSource("bus-positions")) {
    map.addSource("bus-positions", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("bus-pos-halo")) {
    map.addLayer({
      id: "bus-pos-halo",
      type: "circle",
      source: "bus-positions",
      paint: {
        "circle-radius": 18,
        "circle-color": "#0a0c10",
        "circle-opacity": 0.55,
        "circle-blur": 0.7,
      },
    });
  }
  // Radar pulse: transparent ring in the route color, expanding + fading on a
  // 5 s loop. The per-frame radarPhase feature property (0..1) drives both the
  // radius and the stroke alpha via data-driven expressions.
  if (!map.getLayer("bus-pos-radar")) {
    map.addLayer({
      id: "bus-pos-radar",
      type: "circle",
      source: "bus-positions",
      layout: busPosReducedMotion ? { visibility: "none" } : {},
      paint: {
        // Filled pulse: route-color fill that fades out as it expands.
        // Smaller footprint (14->54px) and the alpha dies by mid-cycle, so
        // the ripple reads as a quick pulse instead of a lingering disc.
        "circle-radius": ["+", 14, ["*", 40, ["get", "radarPhase"]]],
        "circle-color": [
          "rgba",
          busPosRgb[0],
          busPosRgb[1],
          busPosRgb[2],
          ["*", 0.35, ["max", 0, ["-", 1, ["*", 2, ["get", "radarPhase"]]]]],
        ],
      },
    });
  }
  if (!map.getLayer("bus-pos-dot")) {
    map.addLayer({
      id: "bus-pos-dot",
      type: "circle",
      source: "bus-positions",
      paint: {
        "circle-radius": 14,
        // Inner fill: white; outer outline: the route line color
        "circle-color": "#ffffff",
        // Fades when the stitch confidence drops (marker stays visible but honest)
        "circle-opacity": [
          "case",
          ["<", ["get", "confidence"], 0.6],
          0.25,
          0.95,
        ],
        "circle-stroke-color": busPosColor,
        "circle-stroke-width": 2.5,
      },
    });
  }
  // Route-number label: DOM overlay (not a symbol layer) so it can use the
  // app's Montserrat Bold typeface — the map glyph server only ships Noto Sans.
  if (!document.getElementById("bus-pos-label-layer")) {
    const layer = document.createElement("div");
    layer.id = "bus-pos-label-layer";
    layer.className = "bus-pos-label-layer";
    map.getContainer().appendChild(layer);
  }
  // Reposition labels on MapLibre's render event: it fires after the GL frame
  // is drawn with the current camera (before compositing), so labels stay glued
  // to the markers during pan/zoom/inertia instead of lagging one rAF behind.
  map.off("render", busPosSyncLabels);
  map.on("render", busPosSyncLabels);
  // Re-raise above any layers painted after the panel opened (e.g. MTR)
  for (const id of BUS_POS_LAYER_IDS) {
    try {
      if (map.getLayer(id)) map.moveLayer(id);
    } catch {
      /* style not ready */
    }
  }
  busPosLayersOn = true;
}

function busPosRemoveLayers() {
  for (const id of BUS_POS_LAYER_IDS) {
    try {
      if (map?.getLayer?.(id)) map.removeLayer(id);
    } catch {
      /* ignore */
    }
  }
  try {
    if (map?.getSource?.("bus-positions")) map.removeSource("bus-positions");
  } catch {
    /* ignore */
  }
  document.getElementById("bus-pos-label-layer")?.remove();
  map?.off?.("render", busPosSyncLabels);
  busPosLayersOn = false;
}

/**
 * Engine emit → retarget the eased display positions. The rAF loop renders
 * them, so the marker glides non-linearly instead of jumping between polls.
 *
 * Path-following: the engine emits each vehicle's exact along-shape distance
 * (d), so the target needs NO re-projection — a whole-polyline nearest-point
 * search is ambiguous where a shape loops back on itself (circular routes),
 * which made markers flip between the two nearby legs and glide the long way
 * around the loop. The glide source is likewise derived from the previous
 * glide state (unambiguous), never re-projected from the rendered lon/lat.
 * Projection survives only as a fallback for payloads without d.
 */
function busPosOnUpdate(evt) {
  if (!map?.getStyle) return;
  // Layers may not exist yet if the first emit raced a not-ready style.
  if (!busPosLayersOn && !map.getSource("bus-positions")) busPosEnsureLayers();
  const now = performance.now();
  const project = (lon, lat) =>
    busPosShape && busPosProjectOntoShape
      ? busPosProjectOntoShape(busPosShape.coords, lon, lat)
      : null;
  /** Along-shape distance of the last rendered position (mid-glide interpolated). */
  const prevAlongM = (prev) => {
    if (!prev?.usePath) return null;
    if (prev.dur > 0) {
      const t = Math.min(1, (now - prev.t0) / prev.dur);
      if (t < 1) {
        const k = t * t * (3 - 2 * t);
        return prev.fromD + (prev.targetD - prev.fromD) * k;
      }
    }
    return prev.targetD;
  };
  const seen = new Set();
  for (const v of evt?.vehicles || []) {
    const id = Number(v.id) || 0;
    seen.add(id);
    const tLon = Number(v.lon);
    const tLat = Number(v.lat);
    if (!Number.isFinite(tLon) || !Number.isFinite(tLat)) continue;
    const prev = busPosDisplay.get(id);
    /** @type {{ fromLon: number, fromLat: number, lon: number, lat: number, tLon: number, tLat: number, fromD: number, targetD: number, usePath: boolean, label: string, confidence: number, t0: number, dur: number }} */
    const next = {
      label: String(v.label || ""),
      confidence: Math.max(0.1, Math.min(1, Number(v.confidence) || 0)),
      tLon,
      tLat,
      t0: now,
      fromD: 0,
      targetD: 0,
      usePath: false,
    };
    const tgt = Number.isFinite(v.d) ? { alongM: v.d } : project(tLon, tLat);
    const src = prev ? prevAlongM(prev) : null;
    if (busPosReducedMotion || !prev) {
      // First sighting (or reduced motion): snap straight to the target.
      next.fromLon = tLon;
      next.fromLat = tLat;
      next.lon = tLon;
      next.lat = tLat;
      next.dur = 0;
      if (tgt) {
        next.usePath = true;
        next.fromD = next.targetD = tgt.alongM;
      }
    } else if (tgt && src && Number.isFinite(tgt.alongM) && Number.isFinite(src.alongM)) {
      // Path-following retarget: glide along the polyline from the current
      // rendered distance to the new target's; the duration scales with the
      // along-path distance so curvy or long corrections glide slightly
      // longer (still clamped ≤ 3 s).
      next.usePath = true;
      next.fromD = src.alongM;
      next.targetD = tgt.alongM;
      const ll = busPosAlongToLonLat
        ? busPosAlongToLonLat(busPosShape.coords, busPosShape.cumM, src.alongM)
        : null;
      next.fromLon = ll?.lon ?? prev.lon;
      next.fromLat = ll?.lat ?? prev.lat;
      next.lon = next.fromLon;
      next.lat = next.fromLat;
      next.dur = Math.min(
        3000,
        Math.max(600, Math.abs(tgt.alongM - src.alongM) * 1.2),
      );
    } else {
      // Retarget from the currently displayed position; the glide time scales
      // with distance so big poll corrections catch up gracefully.
      next.fromLon = prev.lon;
      next.fromLat = prev.lat;
      next.lon = prev.lon;
      next.lat = prev.lat;
      next.dur = Math.min(
        3000,
        Math.max(600, busPosDistM(prev.lon, prev.lat, tLon, tLat) * 1.2),
      );
    }
    busPosDisplay.set(id, next);
  }
  // Drop display entries the engine no longer emits (arrived synth buses,
  // evicted vehicles, trips that ended at the terminus): otherwise the
  // markers freeze in place, pulsing forever. The grace covers in-flight
  // glides; a vehicle back a poll later simply re-enters as a fresh marker.
  for (const [id, e] of busPosDisplay) {
    if (!seen.has(id) && now - e.t0 > e.dur + 1500) busPosDisplay.delete(id);
  }
  busPosStartAnim();
}

/** rAF loop: eased marker glide + radar phase → GeoJSON source updates. */
function busPosStartAnim() {
  if (busPosAnimId || !map?.getStyle) return;
  const frame = (now) => {
    busPosAnimId = 0;
    if (!busPosLayersOn || !busPosEngine?.running) return;
    const src = map.getSource("bus-positions");
    if (src) {
      src.setData({
        type: "FeatureCollection",
        features: busPosBuildFeatures(now),
      });
    }
    busPosSyncLabels();
    busPosAnimId = requestAnimationFrame(frame);
  };
  busPosAnimId = requestAnimationFrame(frame);
}

function busPosBuildFeatures(now) {
  const features = [];
  for (const [id, e] of busPosDisplay) {
    let lon = e.tLon;
    let lat = e.tLat;
    if (!busPosReducedMotion && e.dur > 0) {
      const t = Math.min(1, (now - e.t0) / e.dur);
      if (t < 1) {
        // smoothstep: non-linear ease between the last rendered position and
        // the target (the deterministic schedule output becomes a gentle
        // glide, and poll-to-poll corrections ease instead of snapping)
        const k = t * t * (3 - 2 * t);
        if (e.usePath && busPosShape && busPosAlongToLonLat) {
          // Along-polyline interpolation: markers travel the real road
          // distance — rounding curves and sliding back along the path on
          // backward corrections — instead of cutting straight across.
          const ll = busPosAlongToLonLat(
            busPosShape.coords,
            busPosShape.cumM,
            e.fromD + (e.targetD - e.fromD) * k,
          );
          if (ll) {
            lon = ll.lon;
            lat = ll.lat;
          } else {
            lon = e.fromLon + (e.tLon - e.fromLon) * k;
            lat = e.fromLat + (e.tLat - e.fromLat) * k;
          }
        } else {
          lon = e.fromLon + (e.tLon - e.fromLon) * k;
          lat = e.fromLat + (e.tLat - e.fromLat) * k;
        }
        e.lon = lon;
        e.lat = lat;
      } else if (now - e.t0 > e.dur + 1500) {
        // Stale target (tab hidden, rAF paused): snap instead of a long glide.
        e.fromLon = e.tLon;
        e.fromLat = e.tLat;
        e.fromD = e.targetD;
        e.dur = 0;
      } else {
        e.lon = e.tLon;
        e.lat = e.tLat;
      }
    }
    // Rendered position for the DOM label overlay (next frame's from-position)
    e.lon = lon;
    e.lat = lat;
    features.push({
      type: "Feature",
      properties: {
        label: e.label,
        confidence: e.confidence,
        // Radar pulse phase 0..1, staggered per vehicle, repeats every 5 s.
        radarPhase: busPosReducedMotion
          ? 0
          : ((now + id * 1373) % BUS_POS_RADAR_MS) / BUS_POS_RADAR_MS,
      },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }
  return features;
}

/**
 * DOM label overlay: one Montserrat Bold span per vehicle, projected to the
 * marker's screen position every frame. Stale spans (engine restarts, vehicle
 * expiry) are removed. pointer-events: none, so map interaction is untouched.
 */
function busPosSyncLabels() {
  const layer = document.getElementById("bus-pos-label-layer");
  if (!layer) return;
  const seen = new Set();
  for (const [id, e] of busPosDisplay) {
    seen.add(id);
    let el = layer.querySelector(`[data-id="${id}"]`);
    if (!el) {
      el = document.createElement("span");
      el.className = "bus-pos-label";
      el.dataset.id = id;
      layer.appendChild(el);
    }
    el.textContent = e.label;
    el.style.color = busPosColor;
    const p = map.project([e.lon, e.lat]);
    el.style.transform = `translate(-50%,-50%) translate(${p.x}px, ${p.y}px)`;
  }
  for (const el of [...layer.children]) {
    if (!seen.has(Number(el.dataset.id))) el.remove();
  }
}

/** Beta toggle UI (mirrors initTrafficMethodUi; saves + syncs the engine). */
function initLiveBusPrefUi() {
  const tgl = document.getElementById("live-bus-toggle");
  if (!tgl) return;
  const moreField = document.getElementById("live-bus-more-field");
  const moreTgl = document.getElementById("live-bus-more-toggle");
  const syncMoreVisibility = () => {
    // Sub-option only makes sense while the engine itself is on.
    if (moreField) moreField.hidden = !loadLiveBusPref();
  };
  tgl.checked = loadLiveBusPref();
  if (moreTgl) moreTgl.checked = loadLiveBusMorePref();
  syncMoreVisibility();
  tgl.addEventListener("change", () => {
    const next = saveLiveBusPref(!!tgl.checked);
    showToast(
      next ? t("Live bus positions enabled") : t("Live bus positions disabled"),
      1600,
    );
    syncMoreVisibility();
    void busPosSyncState();
  });
  moreTgl?.addEventListener("change", () => {
    const next = saveLiveBusMorePref(!!moreTgl.checked);
    showToast(
      next ? t("Fetch more live data enabled") : t("Fetch more live data disabled"),
      1600,
    );
    void busPosSyncState();
  });
}
initLiveBusPrefUi();

// ── Language settings ────────────────────────────────────────────────────────
/** Wire the Language dropdown to the saved preference (initLang applied at boot). */
function initLanguageUi() {
  const sel = document.getElementById("select-app-language");
  if (!(sel instanceof HTMLSelectElement)) return;
  sel.value = getLang();
  sel.addEventListener("change", () => {
    const next = setLang(sel.value);
    showToast(t("Language · {label}", { label: LANG_META[next].label }), 1600);
    void refreshLanguageViews();
    showUpdateDialog({
      title: t("Reload to apply language?"),
      message: t("Reload now to fully apply the new language?"),
      confirmLabel: t("Reload"),
      onConfirm: () => location.reload(),
    });
  });
}

/**
 * Re-render the open view in the new language: static DOM via applyLangToDom,
 * dynamic views re-render so stop names / directions follow the language.
 */
function refreshLanguageViews() {
  applyLangToDom();
  localizeFareTypeSelect();
  syncPinnedRouteToolbar();
  relocalizeMapLabels(map, LANG_META[getLang()].stationMode);
  if (sidebarPage === "eta-route" && etaSelectedForDetails) {
    void relocalizeEtaRouteDetail();
  } else if (sidebarPage === "trip" && tripDetailIdx != null) {
    openTripDetailPage(tripDetailIdx);
  } else if (sidebarPage === "pinned") {
    void renderPinnedRoutePage();
  } else if (sidebarPage === "search" && plans?.length) {
    renderPlans(plans, 0, { bothMtr: !!(origin?.isMtr && destination?.isMtr) });
  }
}

/**
 * Language change on the ETA route detail: localize stop names in place,
 * re-derive circular-visit annotations (copies), repaint map labels, then
 * re-render the body keeping the board stop + scroll position. No re-fetch:
 * raw nameEn/nameTc live on the stop objects.
 */
async function relocalizeEtaRouteDetail() {
  const route = etaSelectedForDetails;
  const ctx = etaDetailCtx;
  if (!route || !ctx || !etaSelectedStops.length) return;
  if (etaRouteKey(ctx.route) !== etaRouteKey(route)) return;
  const gen = etaShapeGen;
  await waitZhMap();
  etaSelectedStops.forEach((s) => localizeStopName(s));
  const named = annotateCircularVisits(
    etaSelectedStops.filter((s) => s.name && !s._polylineOnly),
  );
  // Keep the same board stop (stopId match, else same index)
  const prevId = String(ctx.boardStop?.stopId || ctx.boardStop?.stop_id || "");
  const stopKey = (s) => String(s.stopId || s.stop_id || "");
  let selectedIndex = prevId
    ? named.findIndex((s) => stopKey(s) === prevId)
    : -1;
  if (selectedIndex < 0) {
    selectedIndex = Math.min(
      Math.max(0, ctx.boardIndex || 0),
      Math.max(0, named.length - 1),
    );
  }
  etaDetailStopIndex = selectedIndex;
  try {
    if (etaSelectedStops.length >= 2) {
      await paintEtaRouteOnMap(route, etaSelectedStops, {
        boardIndex: selectedIndex,
        fit: false,
      });
    }
  } catch (e) {
    console.warn("[i18n] eta map relocalize", e);
  }
  if (gen !== etaShapeGen) return;
  await renderEtaRouteDetailBody(route, {
    ...ctx,
    named,
    selectedIndex,
    preserveScroll: true,
  });
}

initLanguageUi();

// ── Settings: onboarding re-run + full device-data wipe ──────────────────────
function initSettingsDangerZone() {
  document.getElementById("btn-rerun-onboarding")?.addEventListener("click", () => {
    void startOnboarding(); // blurred modal sheet over the live app
  });
  document.getElementById("btn-delete-all-data")?.addEventListener("click", () => {
    showUpdateDialog({
      title: t("Delete all data?"),
      message: t("This will delete all cached data, preferences, and onboarded state. Are you sure?"),
      confirmLabel: t("Delete all data"),
      cancelLabel: t("Cancel"),
      onConfirm: deleteAllDeviceData,
    });
  });
}

/** Clear every morgan.* preference + service-worker caches, then restart. */
function deleteAllDeviceData() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("morgan.")) localStorage.removeItem(key);
    }
  } catch {
    /* private mode — nothing to clear */
  }
  const reload = () => location.reload();
  if ("caches" in window) {
    caches
      .keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .then(reload, reload);
  } else {
    reload();
  }
}
initSettingsDangerZone();

// PRD 4.3 loops — all visibility-gated (same pattern as the existing timers).
// 1 s cadence: keep the engine state in sync + advance Kalman interpolation.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (sidebarPage !== "eta-route" && !busPosEngine?.running) return;
  void busPosSyncState();
  busPosEngine?.tick();
}, 1_000);

// Pulse: one poll per minute while a route detail is open (traffic from cache).
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (!busPosEngine?.running) return;
  void busPosEngine.poll();
}, 60_000);

// Baseline: traffic index refresh + poll every 5 minutes.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (!busPosEngine?.running) return;
  void busPosEngine.refreshTraffic();
  void busPosEngine.poll();
}, 300_000);

// Instant Sync: coming back to the app polls immediately.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void busPosSyncState();
  if (busPosEngine?.running) void busPosEngine.poll();
  void refreshEtaRouteDetailEta();
});

// ── Boot splash ─────────────────────────────────────────────────────────────
const BOOT_SPLASH_MIN_MS = 700;
const BOOT_STARTED_AT = Date.now();
// bootSplashDonePromise + resolveBootSplashDone are declared at the top of
// the module so the geolocation gate can chain onto the splash's completion.

/**
 * Paint page + map backgrounds black while the cover is up. On iOS PWA the
 * fixed splash can stop short of the Dynamic Island band, and the near-black
 * glass/map backgrounds (#12161c / #0a0c10) would read as an unpainted strip
 * beside the pure-black cover. Restored once the cover is removed.
 */
const bootBlackened = [
  document.documentElement,
  document.body,
  document.querySelector(".map-stage"),
  document.getElementById("map"),
]
  .filter(Boolean)
  .map((el) => ({ el, bg: el.style.background }));
for (const { el } of bootBlackened) el.style.background = "#000";

function restoreBootBackgrounds() {
  for (const { el, bg } of bootBlackened) el.style.background = bg;
}

/** Bounce + fade the splash mark, fade the cover, then remove it. */
function dismissBootSplash() {
  const splash = document.getElementById("app-splash");
  if (!splash) {
    restoreBootBackgrounds();
    resolveBootSplashDone();
    return;
  }
  if (splash.dataset.done) return;
  splash.dataset.done = "1";
  splash.classList.add("is-dismissing");
  window.setTimeout(() => splash.classList.add("is-fading"), 560);
  window.setTimeout(() => {
    splash.remove();
    restoreBootBackgrounds();
    resolveBootSplashDone();
  }, 1250);
}

Promise.all([
  // Full page (fonts, images) settled
  new Promise((resolve) => {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", resolve, { once: true });
  }),
  // Basemap style painted
  map.loaded()
    ? Promise.resolve()
    : new Promise((resolve) => map.once("load", resolve)),
  // WASM router graph (resolves on success or handled failure)
  routerReadyPromise,
])
  .then(() => {
    const wait = Math.max(0, BOOT_SPLASH_MIN_MS - (Date.now() - BOOT_STARTED_AT));
    window.setTimeout(dismissBootSplash, wait);
  })
  .catch(() => dismissBootSplash());
// Safety net — never leave the cover stuck if a dependency hangs
window.setTimeout(dismissBootSplash, 8000);

export { map, loadManifest, initRouter, planTrip };
