/**
 * Synthetic itineraries for multi-operator / broken GTFS routes.
 *
 * Joint routes such as S1 (Citybus + KMB) often land in community GTFS as
 * `*-NEVER` template trips with stop_times but **no frequencies**, so the
 * wheels RAPTOR graph never boards them. We inject direct plans when OD
 * matches the corridor (Tung Chung Station ↔ Airport / AWE).
 */

/** @typedef {{ name: string, lat: number, lon: number, offsetSec: number, tags: string[], stopId?: string }} ShuttleStop */
/** @typedef {{
 *   id: string,
 *   shortName: string,
 *   longName: string,
 *   agencies: string[],
 *   headsign: string,
 *   mode: string,
 *   headwaySec: number,
 *   color?: string,
 *   stops: ShuttleStop[],
 * }} ShuttleRoute */

/** S1 circular — offsets from CTB GTFS template (seconds since board). */
/** @type {ShuttleRoute[]} */
export const SHUTTLE_ROUTES = [
  {
    id: "S1",
    shortName: "S1",
    longName: "Tung Chung Station ↔ Airport (Circular)",
    agencies: ["CTB", "KMB"],
    headsign: "Airport (Circular)",
    mode: "bus",
    headwaySec: 8 * 60,
    color: "#FFE15F",
    stops: [
      {
        name: "Tung Chung Station",
        lat: 22.289531,
        lon: 113.940503,
        offsetSec: 0,
        tags: ["tuc", "origin"],
        stopId: "CTB-001860",
      },
      {
        name: "Aviation Fuel Tank Farm, Scenic Road",
        lat: 22.293374,
        lon: 113.932102,
        offsetSec: 264,
        tags: [],
        stopId: "CTB-001846",
      },
      {
        name: "CAD Headquarters, Tung Yiu Road",
        lat: 22.304047,
        lon: 113.939581,
        offsetSec: 480,
        tags: [],
        stopId: "CTB-003588",
      },
      {
        name: "Terminal 1 (South), Cheong Tat Road",
        lat: 22.314692,
        lon: 113.936496,
        offsetSec: 846,
        tags: ["airport", "terminal", "air"],
        stopId: "CTB-003395",
      },
      {
        name: "Terminal 1 (North), Cheong Tat Road",
        lat: 22.316528,
        lon: 113.935815,
        offsetSec: 980,
        tags: ["airport", "terminal", "air"],
        stopId: "CTB-001834",
      },
      {
        name: "Regal Airport Hotel, Cheong Tat Road",
        lat: 22.319353,
        lon: 113.933968,
        offsetSec: 1123,
        tags: ["airport"],
        stopId: "CTB-001836",
      },
      {
        name: "AsiaWorld-Expo, Airport Expo Boulevard",
        lat: 22.319383,
        lon: 113.940473,
        offsetSec: 1279,
        tags: ["airport", "awe"],
        stopId: "CTB-002672",
      },
      {
        name: "Hong Kong SkyCity Marriott Hotel",
        lat: 22.317069,
        lon: 113.943116,
        offsetSec: 1412,
        tags: ["airport", "awe"],
        stopId: "CTB-003304",
      },
      {
        name: "CAD Headquarters, Tung Fai Road",
        lat: 22.303668,
        lon: 113.938623,
        offsetSec: 1537,
        tags: [],
        stopId: "CTB-001868",
      },
      {
        name: "Aviation Fuel Tank Farm, Scenic Road",
        lat: 22.293104,
        lon: 113.93218,
        offsetSec: 1729,
        tags: [],
        stopId: "CTB-001847",
      },
      {
        name: "Tung Chung Cable Car Terminal, Tat Tung Road",
        lat: 22.289058,
        lon: 113.938641,
        offsetSec: 1919,
        tags: ["tuc"],
        stopId: "CTB-001858",
      },
      {
        name: "Tung Chung Station",
        lat: 22.289531,
        lon: 113.940503,
        offsetSec: 1958,
        tags: ["tuc", "origin"],
        stopId: "CTB-001860",
      },
    ],
  },
];

const ACCESS_MAX_M = 650;
const WALK_MPS = 1.25;

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {ShuttleStop[]} stops
 * @param {number} maxM
 * @param {(s: ShuttleStop) => boolean} [pred]
 */
function nearestStop(lat, lon, stops, maxM, pred) {
  let best = null;
  let bestD = Infinity;
  for (const s of stops) {
    if (pred && !pred(s)) continue;
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d < bestD && d <= maxM) {
      bestD = d;
      best = { stop: s, distM: d };
    }
  }
  return best;
}

/**
 * @param {ShuttleStop} s
 * @param {number} [seq]
 */
function stopInfo(s, seq = 0) {
  return {
    stop_name: s.name,
    name: s.name,
    address: s.name,
    id: s.stopId || undefined,
    stop_id: s.stopId || undefined,
    location: { lat: s.lat, lon: s.lon },
    lat: s.lat,
    lon: s.lon,
    departure_offset_minutes: Math.round(s.offsetSec / 60),
    arrival_offset_minutes: Math.round(s.offsetSec / 60),
    stop_sequence: seq,
  };
}

/**
 * @param {number} fromLat
 * @param {number} fromLon
 * @param {ShuttleStop} toStop
 * @param {number} distM
 */
function walkLeg(fromLat, fromLon, toStop, distM, reverse = false) {
  const secs = Math.max(45, Math.round(distM / WALK_MPS));
  const from = reverse
    ? {
        stop_name: toStop.name,
        location: { lat: toStop.lat, lon: toStop.lon },
      }
    : {
        stop_name: "START",
        location: { lat: fromLat, lon: fromLon },
      };
  const to = reverse
    ? {
        stop_name: "END",
        location: { lat: fromLat, lon: fromLon },
      }
    : {
        stop_name: toStop.name,
        location: { lat: toStop.lat, lon: toStop.lon },
      };
  return {
    type: "walk",
    walk_type: reverse ? "egress" : "access",
    distance_meters: Math.round(distM),
    duration_seconds: secs,
    from,
    to,
  };
}

/**
 * Build one S1-style plan boarding at boardIdx, alighting at alightIdx (alight > board).
 * @param {ShuttleRoute} route
 * @param {number} boardIdx
 * @param {number} alightIdx
 * @param {{ lat: number, lon: number }} origin
 * @param {{ lat: number, lon: number }} dest
 * @param {string} departIso service-day clock ISO
 */
function buildPlan(route, boardIdx, alightIdx, origin, dest, departIso) {
  if (alightIdx <= boardIdx) return null;
  const board = route.stops[boardIdx];
  const alight = route.stops[alightIdx];
  const rideSec = alight.offsetSec - board.offsetSec;
  if (rideSec < 60) return null;

  const accessD = haversineM(origin.lat, origin.lon, board.lat, board.lon);
  const egressD = haversineM(dest.lat, dest.lon, alight.lat, alight.lon);
  if (accessD > ACCESS_MAX_M || egressD > ACCESS_MAX_M) return null;

  /** @type {object[]} */
  const legs = [];
  let total = 0;
  if (accessD > 40) {
    const w = walkLeg(origin.lat, origin.lon, board, accessD, false);
    legs.push(w);
    total += w.duration_seconds;
  }

  const segmentStops = route.stops
    .slice(boardIdx, alightIdx + 1)
    .map((s, i) => {
      const info = stopInfo(s, i);
      // offsets relative to board
      const relMin = Math.round((s.offsetSec - board.offsetSec) / 60);
      info.departure_offset_minutes = relMin;
      info.arrival_offset_minutes = relMin;
      return info;
    });

  const agencyLabel =
    route.agencies.length > 1
      ? `${route.agencies.join(" / ")} (joint)`
      : route.agencies[0] || "Bus";

  legs.push({
    type: "transit",
    duration_seconds: rideSec,
    route_options: [
      {
        route_id: `${route.agencies[0] || "BUS"}-${route.shortName}`,
        route_short_name: route.shortName,
        route_long_name: route.longName,
        route_name: route.shortName,
        headsign: route.headsign,
        mode: route.mode,
        color: route.color,
        agency: {
          id: route.agencies[0] || "BUS",
          name: agencyLabel,
        },
        // Multi-operator for filters / ETA
        agencies: route.agencies,
        from: stopInfo(board, 0),
        to: stopInfo(alight, segmentStops.length - 1),
        stops: segmentStops,
        // Hint for live ETA (try CTB then KMB)
        eta_operators: route.agencies.map((a) => a.toLowerCase()),
      },
    ],
  });
  total += rideSec;

  if (egressD > 40) {
    const w = walkLeg(dest.lat, dest.lon, alight, egressD, true);
    legs.push(w);
    total += w.duration_seconds;
  }

  // Align start_time to next headway after depart (service clock face)
  const start = nextHeadwayStart(departIso, route.headwaySec);

  return {
    duration_seconds: total,
    start_time: start,
    legs,
    walk_meters: Math.round(
      (accessD > 40 ? accessD : 0) + (egressD > 40 ? egressD : 0),
    ),
    transfer_count: 0,
    bus_transfer_count: 0,
    mtr_transfer_count: 0,
    mtr_only: false,
    shuttle_injected: true,
    shuttle_id: route.id,
    human_score: total * 0.85, // slight preference vs multi-leg detours
  };
}

/**
 * @param {string} departIso
 * @param {number} headwaySec
 */
function nextHeadwayStart(departIso, headwaySec) {
  // Keep service-day face; snap minutes to headway grid if possible
  try {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(departIso || "");
    if (!m) return departIso || new Date().toISOString();
    const date = m[1];
    let mins = Number(m[2]) * 60 + Number(m[3]);
    const step = Math.max(1, Math.round(headwaySec / 60));
    // Next departure within headway (assume vehicles every `step` min)
    const rem = mins % step;
    if (rem !== 0) mins += step - rem;
    const hh = String(Math.floor(mins / 60) % 24).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    return `${date}T${hh}:${mm}:00Z`;
  } catch {
    return departIso;
  }
}

/**
 * @param {ShuttleRoute} route
 * @param {{ lat: number, lon: number }} origin
 * @param {{ lat: number, lon: number }} dest
 * @param {string} departIso
 */
function plansForShuttle(route, origin, dest, departIso) {
  const oTuc = nearestStop(origin.lat, origin.lon, route.stops, ACCESS_MAX_M, (s) =>
    s.tags.includes("tuc"),
  );
  const oAir = nearestStop(origin.lat, origin.lon, route.stops, ACCESS_MAX_M, (s) =>
    s.tags.includes("airport") || s.tags.includes("awe") || s.tags.includes("air"),
  );
  const dTuc = nearestStop(dest.lat, dest.lon, route.stops, ACCESS_MAX_M, (s) =>
    s.tags.includes("tuc"),
  );
  const dAir = nearestStop(dest.lat, dest.lon, route.stops, ACCESS_MAX_M, (s) =>
    s.tags.includes("airport") || s.tags.includes("awe") || s.tags.includes("air"),
  );

  /** @type {object[]} */
  const out = [];

  // Tung Chung → Airport / AWE (forward on circular)
  if (oTuc && dAir) {
    const boardIdx = route.stops.indexOf(oTuc.stop);
    // Prefer earliest airport/awe stop after board
    let alightIdx = -1;
    let best = Infinity;
    for (let i = boardIdx + 1; i < route.stops.length; i++) {
      const s = route.stops[i];
      if (!(s.tags.includes("airport") || s.tags.includes("awe") || s.tags.includes("air"))) {
        continue;
      }
      const d = haversineM(dest.lat, dest.lon, s.lat, s.lon);
      if (d < best && d <= ACCESS_MAX_M) {
        best = d;
        alightIdx = i;
      }
    }
    if (alightIdx > boardIdx) {
      const p = buildPlan(route, boardIdx, alightIdx, origin, dest, departIso);
      if (p) out.push(p);
    }
  }

  // Airport / AWE → Tung Chung (continue circular to last TUC)
  if (oAir && dTuc) {
    const boardIdx = route.stops.indexOf(oAir.stop);
    // Last Tung Chung stop after board
    let alightIdx = -1;
    for (let i = route.stops.length - 1; i > boardIdx; i--) {
      if (route.stops[i].tags.includes("tuc")) {
        alightIdx = i;
        break;
      }
    }
    if (alightIdx > boardIdx) {
      const p = buildPlan(route, boardIdx, alightIdx, origin, dest, departIso);
      if (p) out.push(p);
    }
  }

  return out;
}

/**
 * Inject missing multi-operator / NEVER-template shuttles into a plan pool.
 *
 * @param {object} query RouteQuery-like
 * @param {object[]} existingPlans
 * @returns {object[]} plans to merge (may be empty)
 */
export function injectShuttlePlans(query, existingPlans = []) {
  const oLat = query.origin?.[0];
  const oLon = query.origin?.[1];
  const dLat = query.destination?.[0];
  const dLon = query.destination?.[1];
  if (
    !Number.isFinite(oLat) ||
    !Number.isFinite(oLon) ||
    !Number.isFinite(dLat) ||
    !Number.isFinite(dLon)
  ) {
    return [];
  }

  // Skip if S1 already present from RAPTOR (future graph fix)
  const hasS1 = (existingPlans || []).some((p) =>
    (p.legs || []).some((l) => {
      if (l.type !== "transit") return false;
      const n = String(l.route_options?.[0]?.route_short_name || "").toUpperCase();
      return n === "S1";
    }),
  );
  if (hasS1) return [];

  const origin = { lat: oLat, lon: oLon };
  const dest = { lat: dLat, lon: dLon };
  const depart = query.departAt || new Date().toISOString();

  /** @type {object[]} */
  const injected = [];
  for (const route of SHUTTLE_ROUTES) {
    injected.push(...plansForShuttle(route, origin, dest, depart));
  }

  if (injected.length) {
    console.info(
      "[shuttle] injected",
      injected.map((p) => p.shuttle_id).join(","),
      "for OD",
    );
  }
  return injected;
}

/**
 * Companies present on a route option (joint ops).
 * @param {object} [opt]
 * @returns {string[]} preference ids: ctb | kmb_lwb | nlb | gmb | mtr_bus | rbs
 */
export function routeOptionCompanyIds(opt) {
  /** @type {Set<string>} */
  const out = new Set();
  // Residents' Bus Services are one route-level class even when operated by
  // CTB (NR61/NR88) — never split them by agency.
  if (/^(NR|DB)\d/i.test(String(opt?.route_short_name || ""))) return ["rbs"];
  const agencies = [
    ...(Array.isArray(opt?.agencies) ? opt.agencies : []),
    opt?.agency?.id,
    opt?.agency?.name,
  ];
  for (const a of agencies) {
    const b = String(a || "").toLowerCase();
    if (!b) continue;
    if (/\bctb\b|citybus|nwfb/.test(b)) out.add("ctb");
    if (/\bkmb\b|lwb|long\s*win|kowloon\s*motor/.test(b)) out.add("kmb_lwb");
    if (/\bnlb\b|new\s*lanto/.test(b)) out.add("nlb");
    if (/gmb|minibus|專線/.test(b)) out.add("gmb");
    if (/\bmtrb\b|mtr\s*bus/.test(b)) out.add("mtr_bus");
  }
  // "CTB / KMB (joint)" style name
  const blob = `${opt?.agency?.name || ""} ${opt?.route_long_name || ""}`;
  if (/joint|聯營|共營/i.test(blob)) {
    if (/ctb|citybus/i.test(blob)) out.add("ctb");
    if (/kmb|lwb/i.test(blob)) out.add("kmb_lwb");
  }
  return [...out];
}
