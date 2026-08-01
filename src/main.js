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
import { createPathContributor } from "./contributePath.js";
import { applyLrtStopOverrides } from "./lrtStops.js";
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
  isDepartTimeHm,
  parseDepartTimeHm,
  hongKongHmString,
} from "./preferences.js";
import { resolveRouteColor } from "./mtrColors.js";
import {
  initFares,
  estimatePlanFare,
  formatPlanFare,
  formatFarePartAmount,
  loadFareType,
  setFareType,
  getFareType,
  formatFareTypeLabel,
  isFareType,
  loadEalFirstClass,
  setEalFirstClass,
  getEalFirstClass,
  getFarePack,
} from "./fares.js";
import {
  searchMtrStationsLocal,
  snapToMtrStation,
  mergeStationDirectory,
  MTR_STATIONS,
} from "./mtrStations.js";
import { LRT_STOPS, matchLrtStop, lrtStopToHit } from "./lrtStops.js";
import {
  loadMtrGeo,
  addMtrLayers,
  featurePopupHtml,
  setRouteStationCodes,
  stationCodeFromName,
  resolvePlatformForStop,
  stationsFromGeoJson,
} from "./mtrLayer.js";
import { buildTransitPolyline, projectStops } from "./routeSnapper.js";
import {
  matchBusShapeOverride,
  applyVisualStopsFromShape,
} from "./busShapes.js";
import {
  isIndoorMtrInterchangeWalk,
  isFreeMtrInterchangeWalk,
  isSameMtrStation,
  isCrossStationInterchange,
} from "./mtrInterchange.js";
import {
  fetchPlanBoardEtas,
  buildPlanStopTimes,
  formatEtaCardLine,
  formatHkClock,
  formatLiveStatusHead,
  stationNameWithPlatforms,
  stationBaseName,
} from "./eta.js";
import {
  mergeStopSequence,
  extractPublicStopCode,
  stopLabelWithPublicId,
} from "./stopMerge.js";
import "./style.css";

// Sayram acrylic cursor lighting (Morgandev design system)
initAcrylic();

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
  btnPickOrigin: document.getElementById("btn-pick-origin"),
  btnPickDest: document.getElementById("btn-pick-dest"),
  mapPickHint: document.getElementById("map-pick-hint"),
  btnPlan: document.getElementById("btn-plan"),
  planResults: document.getElementById("plan-results"),
  // Shell: toolbar + detail + sheets
  mainToolbar: document.getElementById("main-toolbar"),

  btnDetailOpen: document.getElementById("btn-detail-open"),
  btnDetailClose: document.getElementById("btn-detail-close"),
  detailTitle: document.getElementById("detail-title"),
  btnSettings: document.getElementById("btn-settings"),
  btnInfo: document.getElementById("btn-info"),
  settingsSheet: document.getElementById("settings-sheet"),
  infoSheet: document.getElementById("info-sheet"),
  sidebarPageSearch: document.getElementById("sidebar-page-search"),
  sidebarPageTrip: document.getElementById("sidebar-page-trip"),
  btnTripBack: document.getElementById("btn-trip-back"),
  tripDetailHead: document.getElementById("trip-detail-head"),
  tripDetailTimeline: document.getElementById("trip-detail-timeline"),
  inputEtaRoute: document.getElementById("input-eta-route"),
  etaRouteSuggest: document.getElementById("eta-route-suggest"),
  etaRouteDropdown: document.getElementById("eta-route-dropdown"),
  etaRouteHint: document.getElementById("eta-route-hint"),
  toolbarEtaSearch: document.getElementById("toolbar-eta-search"),
  modeButtons: () =>
    Array.from(document.querySelectorAll(".toolbar-mode-btn[data-ui-mode]")),
};

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
/** ETA-only traffic filter (not trip-plan prefs). */
/** @type {"all"|"mtr"|"lrt"|"bus"} */
let etaTrafficMode = "all";
/** @type {{ lat: number, lon: number, at: number } | null} */
let etaUserGeo = null;
/** @type {Promise<{ lat: number, lon: number } | null> | null} */
let etaGeoPromise = null;
/** @type {Map<string, string[]> | null} station name_en lower → line codes */
let mtrStationLinesMap = null;

/** Sidebar stack: "search" | "trip" */
let sidebarPage = "search";
/** Plan index open on the trip detail page */
let tripDetailIdx = null;
/** @type {Map<number, import("./eta.js").LegEtaResult> | null} */
let tripDetailEtas = null;
/** @type {ReturnType<typeof setInterval> | null} */
let tripEtaPollTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let tripEtaAgeTimer = null;
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
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
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

// Map tools + always-visible © at bottom-right (© is out of flex flow so it
// never reflows the nav/geolocate stack; BR offset ignores dock expand)
map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(
  new GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  }),
  "bottom-right",
);
// compact: false → always expanded OSM / Protomaps attribution
map.addControl(new AttributionControl({ compact: false }), "bottom-right");

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
  showToast("Map ready · streaming hongkong.pmtiles");
  map.resize();
  // Brief scale flash on first paint, then fade
  showMapScale();
  scheduleMapScaleFade(2200);
  ensureRouteLayers();
  // MTR stations / exits / platforms (wheelstransit crawler GeoJSON)
  bootstrapMtrLayers().catch((err) => {
    console.warn("[mtrLayer]", err);
  });
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
    (typeof err === "string" ? err : "Map failed to load tiles");
  // COEP noise is common for glyph/sprite hosts without CORP — don't spam toast
  if (String(msg).includes("Failed to fetch") && !map.isStyleLoaded()) {
    showToast(`Map error: ${msg}`, 6000);
  }
});

map.once("idle", () => {
  console.info("[map] idle — style + visible tiles settled");
});

window.addEventListener("resize", () => map.resize());

// ── Trip planning state ──────────────────────────────────────────────────────
/** Secondary pick mode: map tap sets origin or destination */
let pickMode = "destination"; // origin | destination
let mapPickArmed = false; // true while user chose "tap map" for a field
let origin = null; // { lat, lon, label? }
let destination = null;
let originMarker = null;
let destMarker = null;
let plans = [];
let searchTimers = { origin: null, destination: null };
let searchAbort = { origin: null, destination: null };

function setPickMode(mode, { armMap = true } = {}) {
  pickMode = mode;
  mapPickArmed = armMap;
  els.btnPickOrigin?.classList.toggle("active", mode === "origin");
  els.btnPickDest?.classList.toggle("active", mode === "destination");
  els.mapPickHint?.classList.toggle("is-picking", mapPickArmed);
  if (mapPickArmed) {
    showToast(
      mode === "origin"
        ? "Tap the map to set origin"
        : "Tap the map to set destination",
      2200,
    );
  }
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
        showToast("Select at least one preference", 1600);
      }
      routePreferences = saveRoutePreferences(selected);
      syncPrefCheckboxes(routePreferences);
      showToast(`Prefer ${formatPreferencesLabel(routePreferences)}`, 1800);
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
        showToast("Select at least one bus company", 1600);
      }
      busCompanies = saveBusCompanies(selected);
      syncNamedCheckboxes("bus-company", busCompanies);
      showToast(`Bus · ${formatBusCompaniesLabel(busCompanies)}`, 1600);
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
        showToast("Select at least one traffic method", 1600);
      }
      trafficMethods = saveTrafficMethods(selected);
      syncNamedCheckboxes("traffic-method", trafficMethods);
      showToast(`Modes · ${formatTrafficMethodsLabel(trafficMethods)}`, 1600);
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
      showToast(`Mode · ${formatServiceDayLabel(serviceDay)}`, 1600);
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
      ? `Default: <strong>Now</strong> (Hong Kong time, UTC+8). Live clock.`
      : `Fixed time <strong>${escapeHtml(String(parseDepartTimeHm(departTime) || departTime))}</strong> (UTC+8). Reset returns to Now.`;
  }
}

/**
 * Source of truth for planning: fixed HH:MM from the input if set, else Now.
 * Always re-reads the DOM so Plan trip never uses a stale "now".
 * @returns {import("./preferences.js").DepartTimeValue}
 */
function resolveDepartTimeForPlan() {
  const input = document.getElementById("input-depart-time");
  const row = document.querySelector(".depart-time-row");
  const usingNow =
    departTime === "now" &&
    (!row || row.classList.contains("is-now"));
  if (!usingNow && input instanceof HTMLInputElement) {
    const hm = parseDepartTimeHm(input.value);
    if (hm) {
      departTime = saveDepartTime(hm);
      return hm;
    }
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
    showToast("Departure · Now (UTC+8)", 1400);
    if (origin && destination && isRouterReady()) runPlan();
  });

  if (input instanceof HTMLInputElement) {
    const applyFixed = () => {
      const hm = parseDepartTimeHm(input.value);
      if (!hm) return;
      departTime = saveDepartTime(hm);
      syncDepartTimeUi();
      showToast(`Departure · ${formatDepartTimeLabel(departTime)}`, 1400);
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
  // Preserve ms label if present in results header — re-render with 0 ms delta
  const meta = els.planResults?.querySelector?.(".result-meta");
  const msMatch = meta?.textContent?.match(/(\d+)\s*ms/);
  const ms = msMatch ? Number(msMatch[1]) : 0;
  renderPlans(plans, ms, { bothMtr: !!(origin?.isMtr && destination?.isMtr) });
  return true;
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
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (!isFareType(v)) return;
    fareType = setFareType(v);
    showToast(`Fare · ${formatFareTypeLabel(fareType)}`, 1800);
    // Always re-estimate visible plans with the new ticket type
    if (repricePlansForFareType()) return;
    if (origin && destination && isRouterReady()) {
      runPlan();
    }
  });
}
initFareTypeUi();

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

function updatePlanButton() {
  if (!els.btnPlan) return;
  els.btnPlan.disabled = !(isRouterReady() && origin && destination);
}

/**
 * @param {"origin"|"destination"} kind
 * @param {number} lat
 * @param {number} lon
 * @param {string} [label]
 * @param {{ isMtr?: boolean, isLrt?: boolean, category?: string, type?: string }} [meta]
 */
function setPoint(kind, lat, lon, label, meta = {}) {
  const el = document.createElement("div");
  el.className = `map-pin map-pin-${kind}`;
  el.title = kind === "origin" ? "Origin" : "Destination";

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

// Map click is secondary — only applies when user armed pick via hint links
// or when a field is still empty (soft assist).
// Path contribute mode owns map clicks while open.
map.on("click", (e) => {
  if (pathContributor?.isOpen()) return;
  if (!mapPickArmed) {
    if (!origin) {
      pickMode = "origin";
    } else if (!destination) {
      pickMode = "destination";
    } else {
      return; // both set — ignore map clicks unless armed via hint
    }
  }
  const kind = pickMode;
  const { lng, lat } = e.lngLat;
  setPoint(kind, lat, lng, fmtCoord(lat, lng));
  // Reverse-geocode in background for a nicer label
  reverseGeocode(lat, lng).then((label) => {
    const cur = kind === "origin" ? origin : destination;
    if (cur && Math.abs(cur.lat - lat) < 1e-8 && Math.abs(cur.lon - lng) < 1e-8) {
      setPoint(kind, lat, lng, label, {
        isMtr: looksLikeMtrStation(label),
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
/** @type {{ origin: Array|null, destination: Array|null }} */
const lastResults = { origin: null, destination: null };

function suggestList(which) {
  return which === "origin" ? els.suggestOrigin : els.suggestDest;
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
  const field = which === "origin" ? "origin" : "destination";
  return `<li role="option">
    <button type="button" class="loc-suggest-item loc-suggest-map" data-action="map-pick" data-field="${field}">
      <span class="material-symbols-outlined s-icon" aria-hidden="true">touch_app</span>
      <span class="s-text">
        <span class="s-name">Tap the map to set</span>
        <span class="s-label">Click anywhere on the map for ${field}</span>
      </span>
    </button>
  </li>`;
}

function wireMapPickSuggest(list, which) {
  list.querySelectorAll('button[data-action="map-pick"]').forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      hideSuggest(which);
      setPickMode(which === "origin" ? "origin" : "destination", { armMap: true });
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

  setPoint(which === "origin" ? "origin" : "destination", lat, lon, label, {
    // Keep LRT distinct from heavy-rail MTR so runPlan does not snap to TML
    isMtr: isMtr && !isLrt,
    isLrt,
    category: isMtr || isLrt ? "railway" : r.category,
    type: isLrt ? "halt" : isMtr ? "station" : r.type,
  });
  map.flyTo({
    center: [lon, lat],
    zoom: Math.max(map.getZoom(), 15),
    duration: 800,
  });
  hideSuggest(which);
  if (which === "origin" && !destination) {
    els.inputDest?.focus();
  }
}

function wantsStationQuery(s) {
  return /\bstation\b|\bstn\b|\bmtr\b|站/i.test(String(s || ""));
}

function modeBadgeHtml(r) {
  const mode = String(r.mode || "").toLowerCase();
  if (mode === "lrt" || r.isLrt || r.source === "lrt-local") {
    return `<span class="s-badge s-badge-lrt">LRT</span>`;
  }
  if (mode === "bus") {
    return `<span class="s-badge s-badge-bus">Bus</span>`;
  }
  // Never badge LRT-looking names as MTR if they match the LRT directory
  if (matchLrtStop(r.name || r.label, r.lat, r.lon, 120)) {
    return `<span class="s-badge s-badge-lrt">LRT</span>`;
  }
  const isRail =
    r.isMtr ||
    mode === "mtr" ||
    String(r.category || r.class || "").toLowerCase() === "railway" ||
    String(r.type || "").toLowerCase() === "station";
  if (isRail) return `<span class="s-badge">MTR</span>`;
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
    ? `<li class="loc-suggest-msg loc-suggest-filter" role="status">Showing <strong>@${String(meta.mode).toUpperCase()}</strong> stops</li>`
    : "";

  if (!results.length) {
    list.innerHTML =
      mapPickSuggestItemHtml(which) +
      filterNote +
      `<li class="loc-suggest-msg loc-suggest-msg-empty" role="status">${escapeHtml(
        meta.mode
          ? `No ${String(meta.mode).toUpperCase()} stops matched — try another name`
          : "No places found — try “Yuen Long Station”, @MTR, or tap the map",
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
          ? "Search unavailable — run npm run dev (needs /geocode proxy), or tap the map"
          : err.message || "Search failed";
      showSuggestMessage(which, hint, "error");
      showToast(hint, 4500);
    }
  }, 280);
}

function wireSearchInput(input, which) {
  if (!input) return;

  input.addEventListener("input", (e) => {
    if (which === "origin") origin = null;
    else destination = null;
    updatePlanButton();
    scheduleSearch(which, e.target.value);
  });

  input.addEventListener("focus", () => {
    setPickMode(which === "origin" ? "origin" : "destination", { armMap: false });
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

// Hide suggestions when clicking outside the field
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest?.(".loc-field")) {
    hideSuggest("origin");
    hideSuggest("destination");
  }
});

// ── Current location ─────────────────────────────────────────────────────────
els.btnUseLocation?.addEventListener("click", async () => {
  const btn = els.btnUseLocation;
  btn.classList.add("is-loading");
  btn.disabled = true;
  showToast("Getting your location…");
  try {
    const pos = await getCurrentPosition();
    let label = "Current location";
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
    });
    showToast("Origin set to current location");
    if (!destination) els.inputDest?.focus();
  } catch (err) {
    console.warn("[geo]", err);
    showToast(err.message || "Could not get location", 4000);
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

  updatePlanButton();
});

els.btnPlan?.addEventListener("click", () => {
  if (!origin || !destination || !isRouterReady()) return;
  runPlan();
});

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
          ["coalesce", ["get", "color"], "#c0aefc"],
        ],
        "line-width": [
          "case",
          ["==", ["get", "walk_style"], "indoor"],
          3.5,
          ["==", ["get", "walk_style"], "free"],
          3.5,
          4,
        ],
        "line-opacity": 0.95,
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

  // Stop markers — always above route lines (and re-promoted after MTR layers)
  if (!map.getLayer("route-stops-circle")) {
    map.addLayer({
      id: "route-stops-circle",
      type: "circle",
      source: "route-stops",
      paint: {
        // Keep paint expressions simple — nested match/interpolate has
        // failed silently on some MapLibre builds.
        "circle-radius": [
          "match",
          ["get", "role"],
          "board",
          9,
          "alight",
          9,
          "transfer",
          8,
          6,
        ],
        "circle-color": [
          "coalesce",
          ["get", "color"],
          "#c0aefc",
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
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
        "text-size": [
          "match",
          ["get", "role"],
          "via",
          10,
          12,
        ],
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
    if (map.getLayer("route-stops-circle")) {
      map.setPaintProperty("route-stops-circle", "circle-radius", [
        "match",
        ["get", "role"],
        "board",
        9,
        "alight",
        9,
        "transfer",
        8,
        6,
      ]);
      map.setPaintProperty("route-stops-circle", "circle-color", [
        "coalesce",
        ["get", "color"],
        "#c0aefc",
      ]);
      map.setPaintProperty("route-stops-circle", "circle-stroke-color", "#ffffff");
      map.setPaintProperty("route-stops-circle", "circle-stroke-width", 2);
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

function clearRouteGeometry() {
  const src = map.getSource("route-line");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
  const stops = map.getSource("route-stops");
  if (stops) stops.setData({ type: "FeatureCollection", features: [] });
  setRouteStationCodes(map, []);
  if (mtrPopup) {
    mtrPopup.remove();
    mtrPopup = null;
  }
}

/**
 * Blur the map and show a loading card while densified path is calculated.
 * Route geometry is only painted after densify finishes (no skeleton flash).
 * @param {boolean} on
 * @param {string} [message]
 */
function setMapRouteLoading(on, message = "Drawing route…") {
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

function runPlan() {
  if (els.btnPlan) els.btnPlan.disabled = true;
  els.planResults.hidden = false;
  els.planResults.innerHTML = `<p class="hint">Planning…</p>`;
  // Hide any previous path; blur until densified geometry is ready
  clearRouteGeometry();
  setMapRouteLoading(true, "Planning…");
  const t0 = performance.now();
  try {
    // Snap OD: LRT pins stay on Light Rail; heavy-rail may snap to station centroids
    let oLat = origin.lat;
    let oLon = origin.lon;
    let dLat = destination.lat;
    let dLon = destination.lon;
    let oLrt = !!origin.isLrt;
    let dLrt = !!destination.isLrt;
    let oMtr = !!origin.isMtr && !oLrt;
    let dMtr = !!destination.isMtr && !dLrt;

    // Prefer explicit LRT directory pins (Tuen Mun Hospital / Ferry Pier ≠ Tuen Mun MTR)
    const pinLrt = (label, lat, lon) => {
      const hit = matchLrtStop(label, lat, lon, 350);
      if (!hit) return null;
      // Don't remap bare dual-hub labels that were intentionally set as MTR
      return hit;
    };
    if (oLrt || matchLrtStop(origin.label, null, null, 0)) {
      const hit = pinLrt(origin.label, oLat, oLon);
      if (hit) {
        // For LRT-only names (Hospital / Ferry Pier) always use LRT coords.
        // For dual hubs, keep LRT coords only when already flagged isLrt.
        const dualHub = /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
          String(hit.name_en || "").trim(),
        );
        const lrtSpecific = !dualHub || oLrt || /light\s*rail|輕鐵/i.test(origin.label || "");
        if (lrtSpecific) {
          oLat = hit.lat;
          oLon = hit.lon;
          oLrt = true;
          oMtr = false;
        }
      }
    }
    if (dLrt || matchLrtStop(destination.label, null, null, 0)) {
      const hit = pinLrt(destination.label, dLat, dLon);
      if (hit) {
        const dualHub = /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
          String(hit.name_en || "").trim(),
        );
        const lrtSpecific = !dualHub || dLrt || /light\s*rail|輕鐵/i.test(destination.label || "");
        if (lrtSpecific) {
          dLat = hit.lat;
          dLon = hit.lon;
          dLrt = true;
          dMtr = false;
        }
      }
    }

    // Heavy-rail centroid snap only when not LRT
    if (!oLrt) {
      const oSnap = snapToMtrStation(oLat, oLon, origin.label, oMtr ? 500 : 200);
      if (oSnap && (oMtr || wantsStationQuery(origin.label))) {
        // Block if label is an LRT-specific stop
        const lrtOnly = matchLrtStop(origin.label, null, null, 0);
        const dualHub = lrtOnly && /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
          String(lrtOnly.name_en || "").trim(),
        );
        if (!lrtOnly || dualHub) {
          oLat = oSnap.lat;
          oLon = oSnap.lon;
          oMtr = true;
        }
      }
    }
    if (!dLrt) {
      const dSnap = snapToMtrStation(dLat, dLon, destination.label, dMtr ? 500 : 200);
      if (dSnap && (dMtr || wantsStationQuery(destination.label))) {
        const lrtOnly = matchLrtStop(destination.label, null, null, 0);
        const dualHub = lrtOnly && /^(tin shui wai|yuen long|tuen mun|siu hong)$/i.test(
          String(lrtOnly.name_en || "").trim(),
        );
        if (!lrtOnly || dualHub) {
          dLat = dSnap.lat;
          dLon = dSnap.lon;
          dMtr = true;
        }
      }
    }

    const bothMtr = oMtr && dMtr && !oLrt && !dLrt;
    // Access-to-station only. Keep under ~1.5 km so RAPTOR cannot treat a
    // Victoria Harbour crossing as a single walk (Central↔Austin ≈ 2.5 km).
    // planTrip() also retries with tighter walk + more transfers for bothMtr.
    const maxWalk = bothMtr ? 1000 : oMtr || dMtr ? 1400 : 1200;

    // Re-read departure from the time input (fixed HH:MM or Now)
    const departTimeResolved = resolveDepartTimeForPlan();
    const departAtIso = departAtForServiceDay(
      serviceDay,
      new Date(),
      departTimeResolved,
    );
    console.info(
      "[plan] depart",
      departTimeResolved,
      serviceDay,
      departAtIso,
    );

    function runQuery(walkM, speed, transfers) {
      return planTrip({
        origin: [oLat, oLon],
        destination: [dLat, dLon],
        // Usual/Holiday calendar day + Now or fixed Hong Kong clock time
        departAt: departAtIso,
        maxResults: bothMtr ? 8 : 5,
        maxTransfers: transfers ?? (bothMtr ? 5 : 3),
        maxWalkDistance: walkM,
        walkingSpeed: speed,
        originIsMtr: oMtr,
        destIsMtr: dMtr,
        // Stop/station OD: Walk-off still keeps plans (no “walk to destination” reject)
        originIsStation: !!(oMtr || oLrt || origin?.isMtr || origin?.isLrt),
        destIsStation: !!(dMtr || dLrt || destination?.isMtr || destination?.isLrt),
        // Dual-access: also plan from Hong Kong when origin is Central (and vice versa)
        originLabel: origin.label || origin.name || "",
        destLabel: destination.label || destination.name || "",
        preferences: routePreferences,
        trafficMethods,
        busCompanies,
        modes: routerModesFromTrafficMethods(trafficMethods, ROUTER_MODES),
        fareEstimator: (p) => {
          try {
            const f = estimatePlanFare(p, getFareType());
            // Least fare: incomplete/unsure totals do not count as a known fare
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
    // Looser access only for walk-graph gaps — never large enough for harbour
    if (!result.plans?.length) {
      result = runQuery(bothMtr ? 1200 : Math.max(maxWalk, 1800), "normal");
    }
    if (!result.plans?.length && (oMtr || dMtr)) {
      result = runQuery(bothMtr ? 1400 : 2000, "normal", bothMtr ? 6 : 4);
    }

    const ms = Math.round(performance.now() - t0);
    const ticket = getFareType();
    const leastFareOn = routePreferences.includes("cheapest");
    plans = (result.plans || []).map((p) => {
      const fare = estimatePlanFare(p, ticket);
      return { ...p, fare };
    });
    // Least fare: promote plans with complete fares; demote unsure to the end
    if (leastFareOn && plans.length > 1) {
      plans = prioritizeCompleteFares(plans);
    }
    renderPlans(plans, ms, { bothMtr, leastFareOn });
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
        ? " · MTR preferred"
        : " · MTR ends"
      : "";
    showToast(
      plans.length
        ? `${plans.length} plan(s) · ${ms} ms${fareHint}${hint}`
        : "No routes found — try other points",
    );
  } catch (err) {
    console.error("[plan]", err);
    clearRouteGeometry();
    setMapRouteLoading(false);
    els.planResults.innerHTML = `<p class="hint plan-error">${escapeHtml(err.message || String(err))}</p>`;
    showToast(`Plan failed: ${err.message || err}`, 5000);
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
  const name = (stop.stop_name || stop.address || "").trim();
  const platform = (stop.platform || "").trim();
  if (!name) {
    return platform ? `Platform ${platform}` : "";
  }
  // Already enriched by WASM (e.g. "Tung Chung (Platform 1)")
  if (/\(Platform\s+/i.test(name) || /月台/.test(name)) return name;
  // Bare platform label without station — still show what we have
  if (/^platform\s*\d+/i.test(name) && platform) {
    return `Platform ${platform}`;
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
  let name = (stop.stop_name || stop.address || "").trim();
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
    if (platform) return `Platform ${platform}`;
    if (publicCode) return publicCode;
    return "";
  }
  if (platform && !/^platform\b/i.test(platform)) {
    name = `${name} - Platform ${platform}`;
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
      return `Walk to ${dest}${time}`;
    }
    return `Walk to destination${time}`;
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
        ? `Change platforms at ${station}${time}`
        : `Change platforms${time}`;
    }
    if (cls?.kind === "indoor" || cls?.kind === "free") {
      return place
        ? `Walk the free link to ${place}${time}`
        : `Free MTR link${time}`;
    }
    // Walk to station (access / transfer) — show station + time
    if (cls?.kind === "access" || cls?.kind === "transfer" || cls?.kind === "walk") {
      if (station && isRailOption(opt)) {
        return `Walk to ${station}${time}`;
      }
      if (station && !isRailOption(opt)) {
        return `Please get on the ${noun} at ${place || station}`;
      }
    }
    if (place) {
      return `Please get on the ${noun} at ${place}`;
    }
  }

  if (cls?.kind === "indoor") {
    return `Indoor interchange${time}: ${cleanStopLabel(cls.from)} → ${cleanStopLabel(cls.to)}`;
  }
  if (cls?.kind === "free") {
    return `Free MTR link${time}: ${cleanStopLabel(cls.from)} → ${cleanStopLabel(cls.to)}`;
  }
  if (cls?.kind === "in_station") {
    const place = cleanStopLabel(cls.from || cls.to);
    return place ? `In-station interchange at ${place}${time}` : `In-station interchange${time}`;
  }
  if (cls?.kind === "transfer") {
    const to = cleanStopLabel(cls.to || formatStopName(leg.to));
    return to ? `Walk to ${to}${time}` : `Transfer walk${time}`;
  }
  if (cls?.kind === "access") {
    const to =
      cleanStopLabel(formatStopName(leg.to)) || cleanStopLabel(cls?.to);
    return to ? `Walk to ${to}${time}` : `Walk to station${time}`;
  }
  return time ? `Walk${time}` : "Walk";
}

/**
 * Route chip label: short number / line id.
 * @param {object} [opt]
 */
function transitRouteLabel(opt) {
  if (!opt) return "Transit";
  const short = (opt.route_short_name || "").trim();
  if (short) return short;
  return routeDisplayName(opt);
}

/**
 * "To {headsign|destination}" for transit header.
 * @param {object} [opt]
 */
function transitDirectionLabel(opt) {
  if (!opt) return "";
  const head = String(opt.headsign || "").trim();
  if (head) {
    return /^to\s+/i.test(head) ? head : `To ${head}`;
  }
  const to = cleanStopLabel(formatStopName(opt.to));
  return to ? `To ${to}` : "";
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

/**
 * One timeline row: left rail (icon/dot + vertical line) + body.
 * @param {{ kind: string, line: 'solid'|'dotted'|'none', color?: string, icon?: string, bodyHtml: string, last?: boolean, extraClass?: string }} row
 */
function routeLineRowHtml(row) {
  const color = row.color || "";
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
    marker = `<span class="rt-marker rt-marker-mode material-symbols-outlined" aria-hidden="true">${row.icon || "directions_bus"}</span>`;
  } else if (row.kind === "via") {
    // Smaller hollow circle — intermediate “Ride N stops”
    marker = `<span class="rt-marker rt-marker-via" aria-hidden="true"></span>`;
  } else {
    // stop (board / alight)
    marker = `<span class="rt-marker rt-marker-dot" aria-hidden="true"></span>`;
  }
  const extra = row.extraClass ? ` ${row.extraClass}` : "";
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

    if (leg.type === "transit") {
      const opt = leg.route_options?.[0];
      const color = routeColorCss(opt) || "#c0aefc";
      const icon = transitModeIcon(opt);
      const route = transitRouteLabel(opt);
      const dir = transitDirectionLabel(opt);
      const stops = transitStopSequence(opt, { full: fullStops });
      // Ride N for all modes (bus / LRT / MTR / ferry…) — not MTR-only
      const rideN = rideStopCount(opt);

      rows.push({
        kind: "transit",
        line: "solid",
        color,
        icon,
        bodyHtml: `<div class="rt-transit-head">
          <span class="rt-route-id">${escapeHtml(route)}</span>
          ${dir ? `<span class="rt-route-to">${escapeHtml(dir)}</span>` : ""}
        </div>`,
      });

      if (!stops.length) {
        rows.push({
          kind: "stop",
          line: next ? "dotted" : "none",
          color,
          bodyHtml: `<span class="rt-stop-name">Transit</span>`,
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
          bodyHtml: `<span class="rt-stop-name">${escapeHtml(stopLineLabel(board) || "Board")}</span>`,
        });
        if (hasVia) {
          rows.push({
            kind: "via",
            line: "solid",
            color,
            bodyHtml: `<span class="rt-via-text">Ride ${rideN} stop${rideN === 1 ? "" : "s"}</span>`,
          });
        }
        rows.push({
          kind: "stop",
          line: next ? "dotted" : "none",
          color,
          extraClass: hasVia ? "rt-stop-alight-compact" : "",
          bodyHtml: `<span class="rt-stop-name">${escapeHtml(stopLineLabel(alight) || "Alight")}</span>`,
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
          const label = stopLineLabel(stops[s]) || "Stop";
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
              ? `<div class="rt-eta-card" data-eta-card-leg="${origIndex}" aria-live="polite" aria-label="Live status">
                  <div class="rt-eta-card-head" data-eta-card-head>Live Status (Last Update: —)</div>
                  <ul class="rt-eta-card-list">
                    <li class="rt-eta-card-row is-loading">Loading…</li>
                  </ul>
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
    els.planResults.innerHTML = `<p class="hint">No routes found.<br>Try different locations or a later departure.</p>`;
    els.planResults.hidden = false;
    return;
  }
  const leastFareOn =
    opts.leastFareOn || routePreferences.includes("cheapest");
  const prefLabel = formatPreferencesLabel(routePreferences);
  const fareLabel = formatFareTypeLabel(getFareType());
  const modeLabel = formatTrafficMethodsLabel(trafficMethods);
  const coLabel = formatBusCompaniesLabel(busCompanies);
  const dayLabel = formatServiceDayLabel(serviceDay);
  const timeLabel = formatDepartTimeLabel(
    parseDepartTimeHm(departTime) || departTime,
  );
  const policy = `Prefer ${prefLabel} · ${dayLabel} · ${timeLabel} · ${modeLabel} · ${coLabel} · ${fareLabel}`;
  const meta = `<p class="result-meta">${list.length} plan${list.length > 1 ? "s" : ""} · ${ms} ms · ${policy}</p>`;
  const cards = list
    .map((p, idx) => {
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
      if (p.is_recommended || idx === 0) {
        badges.push(`<span class="plan-badge">Recommended</span>`);
      }
      // Cross-station free links only (not same-station platform changes)
      if ((p.free_mtr_interchange_walks || 0) > 0) {
        badges.push(
          `<span class="plan-badge plan-badge-indoor" title="Cross-station free walkway (Central↔Hong Kong, TST↔East TST, …)">Free MTR link</span>`,
        );
      }
      if (p.mtr_only) {
        badges.push(`<span class="plan-badge plan-badge-mtr">MTR</span>`);
      }
      const aelPromo = aelPromoForPlan(p, origin, destination);
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
      return `<article class="plan-card${idx === 0 ? " active" : ""}" data-idx="${idx}" role="button" tabindex="0" aria-label="Select plan ${idx + 1}">
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
        <button type="button" class="plan-detail-btn" data-detail-idx="${idx}">
          <span class="material-symbols-outlined" aria-hidden="true">list_alt</span>
          Show detail
        </button>
      </article>`;
    })
    .join("");
  els.planResults.innerHTML = meta + cards;
  els.planResults.hidden = false;
  els.planResults.querySelectorAll(".plan-card").forEach((card) => {
    const idx = Number(card.dataset.idx);
    card.addEventListener("click", (e) => {
      if (e.target.closest(".plan-detail-btn")) return;
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
}

/**
 * Sidebar navigation: search (planner list) ↔ trip detail (full stops).
 * @param {"search"|"trip"} page
 */
function setSidebarPage(page) {
  sidebarPage = page === "trip" ? "trip" : "search";
  if (els.sidebarPageSearch) {
    els.sidebarPageSearch.hidden = sidebarPage !== "search";
  }
  if (els.sidebarPageTrip) {
    els.sidebarPageTrip.hidden = sidebarPage !== "trip";
  }
  if (els.detailTitle) {
    if (sidebarPage === "trip") {
      els.detailTitle.textContent = "Trip detail";
    } else {
      const mode = getUiMode();
      els.detailTitle.textContent =
        mode === "eta" ? "ETA search" : "Route planner";
    }
  }
  // Ensure expanded dock when viewing either page with content
  if (sidebarPage === "trip") {
    setDetailOpen(true);
  }
  // Scroll trip page to top
  if (sidebarPage === "trip" && els.panel) {
    const body = els.panel.querySelector(".detail-sidebar-body");
    if (body) body.scrollTop = 0;
  }
}

/**
 * Build trip-detail header HTML (OD, duration, live arrive, fare).
 * @param {object} plan
 * @param {{ arriveMs?: number | null, usedLive?: boolean }} [live]
 */
function tripDetailHeadHtml(plan, live = {}) {
  const from =
    origin?.label || origin?.name || (origin ? fmtCoord(origin.lat, origin.lon) : "Origin");
  const to =
    destination?.label ||
    destination?.name ||
    (destination ? fmtCoord(destination.lat, destination.lon) : "Destination");
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
      }`;
}

/**
 * Refresh "Live Status (Last Update: N seconds ago)" on all ETA cards.
 * @param {Map<number, import("./eta.js").LegEtaResult> | null} [etaMap]
 */
function paintTripEtaCardHeads(etaMap = tripDetailEtas) {
  const root = els.tripDetailTimeline;
  if (!root) return;
  const now = Date.now();
  root.querySelectorAll("[data-eta-card-leg]").forEach((card) => {
    const legIdx = Number(card.getAttribute("data-eta-card-leg"));
    const eta = etaMap?.get(legIdx);
    const head = card.querySelector("[data-eta-card-head], .rt-eta-card-head");
    if (!head) return;
    head.textContent = formatLiveStatusHead(eta?.fetchedAt, now);
  });
}

/**
 * Paint BOARD/PASS BY/ALIGHT clocks + live ETA cards from open-data.
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

  // Board stop title: "Tung Chung - Platform 1/2" when both serve destination
  root.querySelectorAll("[data-eta-board-name-leg]").forEach((el) => {
    const legIdx = Number(el.getAttribute("data-eta-board-name-leg"));
    const base =
      el.getAttribute("data-eta-board-base") ||
      stationBaseName(el.textContent || "") ||
      el.textContent ||
      "";
    const eta = etaMap?.get(legIdx);
    const plats = eta?.servingPlatforms || [];
    if (plats.length) {
      el.textContent = stationNameWithPlatforms(base, plats);
      el.title =
        plats.length > 1
          ? `Platforms ${plats.join(" & ")} serve this direction`
          : `Platform ${plats[0]}`;
    }
  });

  // Board ETA card — vertical list of up to 3 buses/trains
  root.querySelectorAll("[data-eta-card-leg]").forEach((card) => {
    const legIdx = Number(card.getAttribute("data-eta-card-leg"));
    const eta = etaMap?.get(legIdx);
    const list = card.querySelector(".rt-eta-card-list");
    const head = card.querySelector("[data-eta-card-head], .rt-eta-card-head");
    if (!list) return;

    card.classList.remove("is-live", "is-empty", "is-loading");

    if (head) {
      head.textContent = formatLiveStatusHead(eta?.fetchedAt);
    }

    if (!eta) {
      card.classList.add("is-empty");
      list.innerHTML = `<li class="rt-eta-card-row is-empty">No ETA</li>`;
      return;
    }
    if (eta.unsupported) {
      card.classList.add("is-empty");
      list.innerHTML = `<li class="rt-eta-card-row is-empty">ETA N/A</li>`;
      card.title = eta.error || "Live ETA not available for this operator";
      return;
    }

    const slots = Array.isArray(eta.etas) ? eta.etas.slice(0, 3) : [];
    if (!slots.length) {
      card.classList.add("is-empty");
      list.innerHTML = `<li class="rt-eta-card-row is-empty">${escapeHtml(eta.error || "No departures")}</li>`;
      return;
    }

    list.innerHTML = slots
      .map((slot, i) => {
        const line = formatEtaCardLine(slot);
        const nowArrived = slot.waitMins != null && slot.waitMins <= 0;
        const dest = slot.dest
          ? ` title="${escapeHtml(`To ${slot.dest}${slot.remark ? ` · ${slot.remark}` : ""}`)}"`
          : slot.remark
            ? ` title="${escapeHtml(slot.remark)}"`
            : "";
        return `<li class="rt-eta-card-row${nowArrived ? " is-due is-now" : ""}${i === 0 ? " is-next" : ""}"${dest}><span class="rt-eta-card-line">${escapeHtml(line)}</span></li>`;
      })
      .join("");
    card.classList.add("is-live");
  });
}

function stopTripEtaPolling() {
  if (tripEtaPollTimer != null) {
    clearInterval(tripEtaPollTimer);
    tripEtaPollTimer = null;
  }
  if (tripEtaAgeTimer != null) {
    clearInterval(tripEtaAgeTimer);
    tripEtaAgeTimer = null;
  }
}

/**
 * Fetch board ETAs + update arrive estimate. Safe to call repeatedly.
 * @param {number} [gen]
 */
async function refreshTripDetailEtas(gen) {
  const idx = tripDetailIdx;
  if (idx == null || sidebarPage !== "trip") return;
  const plan = plans[idx];
  if (!plan) return;
  const myGen = gen ?? tripEtaGen;
  const statusEl = els.tripDetailHead?.querySelector?.("[data-eta-status]");

  try {
    if (document.visibilityState === "hidden") return;
    const etaMap = await fetchPlanBoardEtas(plan);
    if (myGen !== tripEtaGen || tripDetailIdx !== idx) return;
    tripDetailEtas = etaMap;
    applyTripDetailEtaDom(plan, etaMap);

    const { arriveMs, usedLive } = buildPlanStopTimes(plan, etaMap);
    if (els.tripDetailHead) {
      // Update only arrive chip + status to avoid wiping fare promo mid-click
      let arriveEl = els.tripDetailHead.querySelector(".trip-arrive");
      const clock = formatHkClock(arriveMs);
      const tag = usedLive ? "Live est." : "Est.";
      const html = `<span class="trip-arrive-label">${tag} arrive</span> <strong>${escapeHtml(clock)}</strong>`;
      if (arriveEl) {
        arriveEl.innerHTML = html;
        arriveEl.title = "Estimated arrival (Hong Kong time)";
      } else {
        const meta = els.tripDetailHead.querySelector(".trip-detail-meta");
        if (meta) {
          const span = document.createElement("span");
          span.className = "trip-arrive";
          span.title = "Estimated arrival (Hong Kong time)";
          span.innerHTML = html;
          const dur = meta.querySelector(".duration");
          if (dur?.nextSibling) meta.insertBefore(span, dur.nextSibling);
          else meta.appendChild(span);
        }
      }
    }
    if (statusEl) {
      const n = [...etaMap.values()].filter((e) => e.waitMins != null).length;
      const total = etaMap.size;
      const t = formatHkClock(Date.now());
      statusEl.textContent =
        total === 0
          ? "No transit legs for live ETA"
          : n > 0
            ? `Live ETAs · ${n}/${total} routes · ${t} · refreshes every 1 min`
            : `Live ETAs unavailable · checked ${t}`;
    }
  } catch (err) {
    console.warn("[eta] trip detail", err);
    if (statusEl && myGen === tripEtaGen) {
      statusEl.textContent = "Live ETAs failed — will retry";
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
  // Tick "Last Update: N seconds ago" every second
  tripEtaAgeTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (sidebarPage !== "trip" || tripDetailIdx == null) return;
    paintTripEtaCardHeads();
  }, 1_000);
}

/**
 * Open full stop-by-stop itinerary as a sidebar page.
 * @param {number} idx
 */
function openTripDetailPage(idx) {
  const plan = plans[idx];
  if (!plan) return;
  tripDetailIdx = idx;
  tripDetailEtas = null;
  selectPlan(idx);

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
  setSidebarPage("trip");
  startTripEtaPolling();
}

function closeTripDetailPage() {
  stopTripEtaPolling();
  tripDetailIdx = null;
  tripDetailEtas = null;
  tripEtaGen += 1;
  setSidebarPage("search");
}

/** Abort in-flight geometry densify when user picks another plan. */
let selectPlanAbort = null;
let selectPlanGen = 0;
/** Last painted route GeoJSON (for contribute-path “From plan”). */
let lastRouteGeo = null;

async function selectPlan(idx) {
  const plan = plans[idx];
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
    map.fitBounds(bounds, { padding: 72, maxZoom: 15, duration: 600 });
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
    els.routerStatus.textContent = stats
      ? `Ready · ${stats.stops.toLocaleString()} stops · ${stats.routes.toLocaleString()} routes`
      : "Router ready";
    showToast("WASM router ready");
    updatePlanButton();
  } catch (err) {
    console.error("[router]", err);
    if (els.routerStatus) {
      els.routerStatus.textContent = `Router failed: ${err.message || err}`;
    }
    showToast("Router graph failed to load", 5000);
  }
}

bootstrapRouter();

// Multi-type MTR fare tables (adult / student / child / QR / contactless)
initFares()
  .then(() => {
    buildEtaRouteCatalog();
    // Re-price any results that were planned before tables finished loading
    if (plans?.length) repricePlansForFareType();
  })
  .catch((err) => {
    console.warn("[fares]", err);
    buildEtaRouteCatalog(); // MTR/LRT hardcodes still available
    showToast("Fare tables unavailable — times still work", 4000);
  });

// ── Metadata manifest ────────────────────────────────────────────────────────
async function loadManifest() {
  els.metaStatus.textContent = "Checking edge metadata…";

  try {
    const res = await fetch(METADATA_URL, { cache: "no-cache" });
    if (res.ok) {
      const meta = await res.json();
      applyManifest(meta, "metadata.json");
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

function dockPadPx() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--dock-pad")
    .trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

/**
 * Lock dock width to chrome content × scale (collapsed + expanded).
 * Always caps to viewport. Use force:true on resize / detail toggle.
 * Without force, never shrink (avoids mid-slot flex shrink loops on mode switch).
 */
function syncDockChromeWidth({ force = false } = {}) {
  const dock = els.mainToolbar;
  if (!dock || dock.offsetParent === null) return;
  const inner = dock.querySelector(".toolbar-inner");
  if (!inner) return;

  const prevW =
    parseFloat(dock.style.getPropertyValue("--dock-chrome-w").trim()) || 0;
  const pad = dockPadPx();
  const maxW = Math.max(200, Math.floor(window.innerWidth - 2 * pad));

  const mid = dock.querySelector(".toolbar-mid-slot");
  const prevTransition = dock.style.transition;
  const prevInlineWidth = dock.style.width;
  const midPrev = mid
    ? {
        flex: mid.style.flex,
        width: mid.style.width,
        minWidth: mid.style.minWidth,
        maxWidth: mid.style.maxWidth,
      }
    : null;

  // Pause transitions so measure isn't mid-animation
  dock.style.transition = "none";
  dock.style.removeProperty("--dock-chrome-w");
  // Measure chrome only: mid slot at its min footprint (not flex-grown)
  dock.style.width = "max-content";
  if (mid) {
    mid.style.flex = "0 0 auto";
    mid.style.width = "7.5rem";
    mid.style.minWidth = "7.5rem";
    mid.style.maxWidth = "7.5rem";
  }

  // Force layout
  void dock.offsetWidth;
  const natural = Math.ceil(
    Math.max(inner.scrollWidth, inner.getBoundingClientRect().width, 1),
  );

  // Restore mid-slot + temporary width
  if (mid && midPrev) {
    mid.style.flex = midPrev.flex;
    mid.style.width = midPrev.width;
    mid.style.minWidth = midPrev.minWidth;
    mid.style.maxWidth = midPrev.maxWidth;
  }
  dock.style.width = prevInlineWidth || "";

  if (natural <= 40) {
    if (prevW > 40) {
      dock.style.setProperty(
        "--dock-chrome-w",
        `${Math.min(prevW, maxW)}px`,
      );
    }
    dock.style.transition = prevTransition;
    return;
  }

  const boosted = Math.ceil(natural * DOCK_WIDTH_SCALE);
  // Hard cap to viewport (previous Math.max(maxW, natural) could overflow)
  let next = Math.min(boosted, maxW);
  if (!force && prevW > 40) {
    next = Math.max(prevW, next);
  }
  next = Math.min(next, maxW);

  dock.style.setProperty("--dock-chrome-w", `${next}px`);

  // Keep map-tool offset in sync with real chrome height
  const chromeH = Math.ceil(inner.getBoundingClientRect().height);
  if (chromeH >= 40 && chromeH <= 80) {
    document.documentElement.style.setProperty("--toolbar-h", `${chromeH}px`);
  }

  // Re-enable transitions after layout settles
  requestAnimationFrame(() => {
    dock.style.transition = prevTransition;
  });
}

// Viewport / visualViewport resize: debounced full remeasure + map resize
let dockResizeTimer = null;
function onViewportChromeResize() {
  clearTimeout(dockResizeTimer);
  dockResizeTimer = setTimeout(() => {
    syncDockChromeWidth({ force: true });
    resizeMapSoon();
  }, 80);
}
window.addEventListener("resize", onViewportChromeResize);
try {
  window.visualViewport?.addEventListener("resize", onViewportChromeResize);
} catch {
  /* ignore */
}

function setDetailOpen(open) {
  if (!els.app) return;
  // Always keep +20% width lock (collapsed and expanded)
  syncDockChromeWidth({ force: true });
  els.app.dataset.detail = open ? "open" : "closed";
  // Keep --dock-chrome-w when collapsing so compact dock also stays +20%
  if (els.panel) {
    els.panel.setAttribute("aria-hidden", open ? "false" : "true");
    els.panel.classList.toggle("collapsed", !open);
  }
  if (els.btnDetailOpen) {
    els.btnDetailOpen.setAttribute("aria-expanded", String(open));
    els.btnDetailOpen.classList.toggle("is-active", open);
    els.btnDetailOpen.title = open ? "Collapse trip details" : "Expand trip details";
    els.btnDetailOpen.setAttribute(
      "aria-label",
      open ? "Collapse trip details" : "Expand trip details",
    );
  }
  const icon = document.getElementById("btn-detail-open-icon");
  if (icon) icon.textContent = open ? "expand_more" : "expand_less";
  // Map tools / © do not move when detail expands — only map canvas may need resize
  resizeMapSoon();
  setTimeout(() => resizeMapSoon(), 400);
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
  const next = mode === "route" ? "route" : "eta";
  if (els.app) els.app.dataset.uiMode = next;
  els.modeButtons().forEach((btn) => {
    const active = btn.dataset.uiMode === next;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  if (els.detailTitle && sidebarPage !== "trip") {
    els.detailTitle.textContent =
      next === "eta" ? "ETA · route search" : "Trip Plan";
  }
  // Hide ETA suggestions when leaving ETA mode
  if (next !== "eta") hideEtaRouteSuggest();
  // Do NOT re-measure dock width on mode switch — mid slot is fixed size;
  // re-measuring while locked was shrinking the sidebar each toggle.
  if (next === "eta") {
    // Warm nearby/browse data
    void ensureMtrStationLinesMap();
  }
}

// ── ETA mode: bus / MTR / LRT route search ──────────────────────────────────

const MTR_ETA_LINES = [
  { id: "AEL", label: "Airport Express", aliases: ["機場快線", "機場快綫", "ael"] },
  { id: "TCL", label: "Tung Chung Line", aliases: ["東涌綫", "東涌線", "tung chung"] },
  { id: "TWL", label: "Tsuen Wan Line", aliases: ["荃灣綫", "荃灣線", "tsuen wan"] },
  { id: "ISL", label: "Island Line", aliases: ["港島綫", "港島線", "island"] },
  { id: "KTL", label: "Kwun Tong Line", aliases: ["觀塘綫", "觀塘線", "kwun tong"] },
  { id: "TKL", label: "Tseung Kwan O Line", aliases: ["將軍澳綫", "將軍澳線", "tseung kwan o", "tko"] },
  { id: "EAL", label: "East Rail Line", aliases: ["東鐵綫", "東鐵線", "east rail"] },
  { id: "TML", label: "Tuen Ma Line", aliases: ["屯馬綫", "屯馬線", "tuen ma"] },
  { id: "SIL", label: "South Island Line", aliases: ["南港島綫", "南港島線", "south island"] },
  { id: "DRL", label: "Disneyland Resort Line", aliases: ["迪士尼綫", "迪士尼線", "disneyland"] },
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
    const key = `${e.kind}|${e.id}|${e.co || ""}`;
    if (!map.has(key)) map.set(key, e);
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

/** @param {EtaRouteEntry} r */
function etaKindMatchesFilter(r) {
  if (etaTrafficMode === "all") return true;
  if (etaTrafficMode === "mtr") return r.kind === "mtr";
  if (etaTrafficMode === "lrt") return r.kind === "lrt";
  if (etaTrafficMode === "bus") return r.kind === "bus" || r.kind === "mtr_bus";
  return true;
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
 * Empty query browse list.
 * With location: nearby MTR lines + LRT (if near NT West) + bus from “1…”.
 * Without: LRT + bus starting at route 1 (numeric).
 * @param {number} [limit]
 * @returns {Promise<{ hits: EtaRouteEntry[], hint: string }>}
 */
async function browseEtaRoutes(limit = 16) {
  if (!etaRouteCatalog.length) buildEtaRouteCatalog();
  await ensureMtrStationLinesMap();
  const geo = await ensureEtaUserGeo();
  const filtered = etaRouteCatalog.filter(etaKindMatchesFilter);

  if (!geo) {
    // LRT + Bus from “1” upward (no MTR dump when location off, unless filter=MTR)
    let pool = filtered;
    if (etaTrafficMode === "all") {
      pool = filtered.filter((r) => r.kind !== "mtr");
    }
    const hits = [...pool]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .slice(0, limit);
    return {
      hits,
      hint:
        etaTrafficMode === "mtr"
          ? "MTR lines · allow location for nearby stations"
          : "LRT / Bus from route 1 · allow location for nearby MTR",
    };
  }

  // ── Nearby MTR lines via nearest stations ──
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
        lineNear.set(c, { dist: d, station: st.name_en });
      }
    }
  }

  /** @type {EtaRouteEntry[]} */
  const out = [];
  const seen = new Set();
  const push = (r, hint) => {
    if (!r || !etaKindMatchesFilter(r)) return;
    const k = `${r.kind}|${r.id}|${r.co || ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...r, nearbyHint: hint || r.nearbyHint });
  };

  if (etaTrafficMode === "all" || etaTrafficMode === "mtr") {
    const ranked = [...lineNear.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (const [code, info] of ranked) {
      const entry = filtered.find((r) => r.kind === "mtr" && r.id === code);
      if (entry) {
        push(
          entry,
          `~${Math.round(info.dist)} m · ${info.station}`,
        );
      }
      if (out.length >= limit) break;
    }
    // Fallback: all MTR lines if none nearby
    if (etaTrafficMode === "mtr" && !out.length) {
      for (const r of filtered.filter((x) => x.kind === "mtr")) {
        push(r);
        if (out.length >= limit) break;
      }
    }
  }

  // LRT if near any LRT stop (NT West)
  let nearLrt = false;
  if (etaTrafficMode === "all" || etaTrafficMode === "lrt") {
    for (const st of LRT_STOPS) {
      if (!Number.isFinite(st.lat)) continue;
      if (haversineMEta(geo.lat, geo.lon, st.lat, st.lon) <= 4000) {
        nearLrt = true;
        break;
      }
    }
    if (nearLrt || etaTrafficMode === "lrt") {
      for (const r of filtered.filter((x) => x.kind === "lrt")) {
        push(r, nearLrt ? "Near Light Rail" : undefined);
        if (out.length >= limit) break;
      }
    }
  }

  // Bus / MTR Bus — list from “1” (no stop-level geo in catalog)
  if (etaTrafficMode === "all" || etaTrafficMode === "bus") {
    const buses = filtered
      .filter((r) => r.kind === "bus" || r.kind === "mtr_bus")
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const r of buses) {
      push(r);
      if (out.length >= limit) break;
    }
  }

  const stName = [...lineNear.values()].sort((a, b) => a.dist - b.dist)[0]
    ?.station;
  return {
    hits: out.slice(0, limit),
    hint: stName
      ? `Near ${stName}` + (nearLrt ? " · LRT area" : "")
      : nearLrt
        ? "Near Light Rail · bus from route 1"
        : "Nearby · bus from route 1",
  };
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

  const scored = [];
  for (const r of etaRouteCatalog) {
    if (!etaKindMatchesFilter(r)) continue;
    const id = r.id.toLowerCase();
    const label = r.label.toLowerCase();
    const aliases = (r.aliases || []).map((a) => String(a).toLowerCase());
    let score = 0;

    if (r.kind === "mtr") {
      // MTR: route id AND line name / aliases
      if (id === q) score = 1000;
      else if (id.startsWith(q)) score = 900;
      else if (id.includes(q)) score = 700;
      else if (label === q) score = 950;
      else if (label.startsWith(q)) score = 850;
      else if (label.includes(q)) score = 600;
      else if (aliases.some((a) => a === q)) score = 920;
      else if (aliases.some((a) => a.startsWith(q))) score = 820;
      else if (aliases.some((a) => a.includes(q))) score = 550;
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

function hideEtaRouteSuggest() {
  if (els.etaRouteDropdown) {
    els.etaRouteDropdown.hidden = true;
  }
  if (els.etaRouteSuggest) els.etaRouteSuggest.innerHTML = "";
  if (els.etaRouteHint) {
    els.etaRouteHint.hidden = true;
    els.etaRouteHint.textContent = "";
  }
  etaRouteHits = [];
  etaRouteActive = -1;
}

function showEtaRouteDropdown() {
  if (els.etaRouteDropdown) els.etaRouteDropdown.hidden = false;
}

/**
 * @param {EtaRouteEntry[]} hits
 * @param {string} [hint]
 */
function renderEtaRouteSuggest(hits, hint = "") {
  const list = els.etaRouteSuggest;
  if (!list) return;
  showEtaRouteDropdown();
  if (els.etaRouteHint) {
    if (hint) {
      els.etaRouteHint.hidden = false;
      els.etaRouteHint.textContent = hint;
    } else {
      els.etaRouteHint.hidden = true;
      els.etaRouteHint.textContent = "";
    }
  }
  etaRouteHits = hits;
  etaRouteActive = hits.length ? 0 : -1;
  if (!hits.length) {
    list.innerHTML = `<li class="eta-route-empty" role="presentation">No matching routes</li>`;
    return;
  }
  list.innerHTML = hits
    .map((r, i) => {
      const badge =
        r.kind === "mtr" ? "mtr" : r.kind === "lrt" ? "lrt" : "bus";
      const badgeLabel =
        r.kind === "mtr"
          ? "MTR"
          : r.kind === "lrt"
            ? "LRT"
            : r.kind === "mtr_bus"
              ? "MTR Bus"
              : "Bus";
      const meta = r.nearbyHint
        ? `${r.label} · ${r.nearbyHint}`
        : r.label;
      return `<li role="option" data-idx="${i}" class="${i === 0 ? "is-active" : ""}" aria-selected="${i === 0}">
        <span class="eta-route-id">${escapeHtml(r.id)}</span>
        <span class="eta-route-meta">${escapeHtml(meta)}</span>
        <span class="eta-route-badge eta-route-badge-${badge}">${badgeLabel}</span>
      </li>`;
    })
    .join("");
  list.querySelectorAll("li[data-idx]").forEach((li) => {
    li.addEventListener("mousedown", (e) => e.preventDefault());
    li.addEventListener("click", () => {
      const idx = Number(li.getAttribute("data-idx"));
      selectEtaRoute(etaRouteHits[idx]);
    });
  });
}

/** Refresh list from current input + filter (async for empty browse). */
async function refreshEtaRouteSuggest() {
  if (getUiMode() !== "eta") return;
  const q = String(els.inputEtaRoute?.value || "").trim();
  if (q.length >= 1) {
    renderEtaRouteSuggest(searchEtaRoutes(q));
    return;
  }
  renderEtaRouteSuggest([], "Loading…");
  const { hits, hint } = await browseEtaRoutes();
  // Still empty query?
  if (String(els.inputEtaRoute?.value || "").trim().length >= 1) return;
  renderEtaRouteSuggest(hits, hint);
}

/**
 * @param {EtaRouteEntry | undefined} route
 */
function selectEtaRoute(route) {
  if (!route) return;
  hideEtaRouteSuggest();
  if (els.inputEtaRoute) els.inputEtaRoute.value = route.id;
  const kindLabel =
    route.kind === "mtr"
      ? "MTR"
      : route.kind === "lrt"
        ? "LRT"
        : route.kind === "mtr_bus"
          ? "MTR Bus"
          : "Bus";
  showToast(`${kindLabel} ${route.id} · ${route.label}`, 2800);
  setDetailOpen(true);
  setSidebarPage("search");
  if (els.planResults) {
    els.planResults.hidden = false;
    els.planResults.innerHTML = `
      <p class="result-meta">ETA · route selected</p>
      <article class="plan-card active" style="cursor:default">
        <div class="plan-head">
          <span class="duration">${escapeHtml(route.id)}</span>
          <span class="plan-fare">${escapeHtml(kindLabel)}</span>
        </div>
        <p class="hint" style="margin:8px 0 0;text-transform:none;letter-spacing:0">
          ${escapeHtml(route.label)}${route.nearbyHint ? ` · ${escapeHtml(route.nearbyHint)}` : ""}.
          Live stop ETA for this route is next.
        </p>
      </article>`;
  }
}

function syncEtaModeChips() {
  document.querySelectorAll(".eta-mode-chip[data-eta-mode]").forEach((btn) => {
    const on = btn.getAttribute("data-eta-mode") === etaTrafficMode;
    btn.classList.toggle("is-active", on);
  });
}

function initEtaRouteSearchUi() {
  const input = els.inputEtaRoute;
  if (!input) return;

  document.querySelectorAll(".eta-mode-chip[data-eta-mode]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-eta-mode") || "all";
      etaTrafficMode =
        mode === "mtr" || mode === "lrt" || mode === "bus" ? mode : "all";
      syncEtaModeChips();
      void refreshEtaRouteSuggest();
    });
  });
  syncEtaModeChips();

  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (getUiMode() !== "eta") return;
      void refreshEtaRouteSuggest();
    }, 120);
  });

  input.addEventListener("keydown", (e) => {
    if (els.etaRouteDropdown?.hidden) {
      if (e.key === "Escape") input.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      etaRouteActive = Math.min(etaRouteActive + 1, etaRouteHits.length - 1);
      syncEtaActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      etaRouteActive = Math.max(etaRouteActive - 1, 0);
      syncEtaActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (etaRouteActive >= 0) selectEtaRoute(etaRouteHits[etaRouteActive]);
    } else if (e.key === "Escape") {
      hideEtaRouteSuggest();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      // Keep open if focus moved to filter chips inside dropdown
      const ae = document.activeElement;
      if (ae && els.etaRouteDropdown?.contains(ae)) return;
      hideEtaRouteSuggest();
    }, 160);
  });

  input.addEventListener("focus", () => {
    void refreshEtaRouteSuggest();
  });

  // Warm catalog + station lines
  void ensureMtrStationLinesMap();
}

function syncEtaActive() {
  const list = els.etaRouteSuggest;
  if (!list) return;
  list.querySelectorAll("li[data-idx]").forEach((li) => {
    const i = Number(li.getAttribute("data-idx"));
    const on = i === etaRouteActive;
    li.classList.toggle("is-active", on);
    li.setAttribute("aria-selected", String(on));
    if (on) li.scrollIntoView({ block: "nearest" });
  });
}

initEtaRouteSearchUi();

// Keep toolbar open (close control removed from chrome)
setToolbarOpen(true);
// Initial +20% dock width from chrome
requestAnimationFrame(() => syncDockChromeWidth({ force: true }));

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
els.btnTripBack?.addEventListener("click", () => closeTripDetailPage());

// Instant sync when returning to the tab (PRD dual-loop: Instant Sync)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (sidebarPage === "trip" && tripDetailIdx != null) {
    void refreshTripDetailEtas(tripEtaGen);
  }
});

// Mode switch
els.modeButtons().forEach((btn) => {
  btn.addEventListener("click", () => setUiMode(btn.dataset.uiMode || "eta"));
});
setUiMode(getUiMode());

// Settings / Info sheets
wireSheet(els.settingsSheet);
wireSheet(els.infoSheet);
els.btnSettings?.addEventListener("click", () => openSheet(els.settingsSheet));
els.btnInfo?.addEventListener("click", () => openSheet(els.infoSheet));

/** Contributor path editor (About → Contribute route path) */
const pathContributor = createPathContributor({
  map,
  showToast,
  getSelectedPlanRoute: () => {
    if (tripDetailIdx == null && (!plans?.length)) return null;
    const idx = tripDetailIdx != null ? tripDetailIdx : 0;
    const plan = plans?.[idx];
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
  els.metaStatus.textContent = "Could not reach data edge.";
  showToast("Metadata unavailable — map may still load from PMTiles URL");
});

// PWA: register service worker only in production builds.
// Dev + COEP require-corp: a SW can break large graph fetches.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* optional */
    });
  });
} else if ("serviceWorker" in navigator) {
  // Clear any previous SW that may block local graph loads
  navigator.serviceWorker.getRegistrations?.().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
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
    selectPlan,
    runPlan,
  };
}

export { map, loadManifest, initRouter, planTrip };
