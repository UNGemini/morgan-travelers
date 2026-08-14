/**
 * Synthesize MTR heavy-rail itineraries when the RAPTOR graph cannot board
 * them. Community GTFS lists MTR stop_times on location_type=1 station ids
 * with empty coordinates, so wheels-router never places those stops.
 *
 * Patterns + headways come from frequencies.txt / template stop_times;
 * station pins come from MTR_STATIONS.
 */

import { MTR_STATIONS } from "./mtrStations.js";
import { MTR_LINE_COLORS } from "./mtrColors.js";
import { MTR_LINE_NAMES, MTR_LINE_ORDER } from "./mtrLineOrder.js";
import { MTR_PATTERNS } from "./data/mtrRuntime.js";

const ACCESS_MAX_M = 900;
const WALK_MPS = 1.25;
const XFER_SEC = 150;
/** Paid-area / indoor links that RAPTOR also treats as free MTR walks. */
const LINK_PAIRS = [
  ["CEN", "HOK", 240],
  ["TST", "ETS", 180],
  ["MOK", "MKK", 300],
];

const stationByCode = new Map(
  (MTR_STATIONS || []).filter((s) => s.code).map((s) => [s.code, s]),
);

/** GTFS templates omit some termini — grow each pattern using official order. */
function completePattern(pat) {
  const order = MTR_LINE_ORDER[pat.line];
  if (!order?.length) return pat;
  const codes = [...pat.codes];
  const offs = [...pat.offs];
  const hops = [];
  for (let i = 1; i < offs.length; i++) hops.push(offs[i] - offs[i - 1]);
  const hop = hops.length
    ? Math.max(60, Math.round(hops.reduce((a, b) => a + b, 0) / hops.length))
    : 120;
  const i0 = order.indexOf(codes[0]);
  const i1 = order.indexOf(codes[1] || codes[0]);
  const fwd = i0 >= 0 && i1 >= 0 ? i1 >= i0 : true;
  const seq = fwd ? order : [...order].reverse();

  const sIdx = seq.indexOf(codes[0]);
  if (sIdx > 0) {
    const missing = seq.slice(0, sIdx);
    const shift = missing.length * hop;
    for (let i = 0; i < offs.length; i++) offs[i] += shift;
    for (let i = missing.length - 1; i >= 0; i--) {
      codes.unshift(missing[i]);
      offs.unshift(shift - (missing.length - i) * hop);
    }
  }
  const eIdx = seq.indexOf(codes[codes.length - 1]);
  if (eIdx >= 0 && eIdx < seq.length - 1) {
    let t = offs[offs.length - 1];
    for (const c of seq.slice(eIdx + 1)) {
      t += hop;
      codes.push(c);
      offs.push(t);
    }
  }
  return { ...pat, codes, offs };
}

const COMPLETED_PATTERNS = MTR_PATTERNS.map(completePattern);
/** Full network — built once. Filtered graphs are derived on demand. */
const FULL_GRAPH = buildGraphFrom(null);
/** @type {Map<string, ReturnType<typeof buildGraphFrom>>} */
const graphCache = new Map();

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hmToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseDepartMins(iso) {
  const m = /T(\d{1,2}):(\d{2})/.exec(String(iso || ""));
  if (!m) return 12 * 60;
  let h = Number(m[1]);
  if (h === 24) h = 0;
  return h * 60 + Number(m[2]);
}

function parseDepartDate(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ""));
  return m ? m[1] : "2026-01-01";
}

function formatIso(date, mins) {
  const wrap = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(wrap / 60)).padStart(2, "0");
  const mm = String(wrap % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00Z`;
}

function headwayAt(bands, mins) {
  if (!bands?.length) return 300;
  for (const b of bands) {
    const a = hmToMin(b.start);
    let z = hmToMin(b.end);
    if (a == null || z == null) continue;
    if (z <= a) z += 24 * 60;
    let t = mins;
    if (t < 3 * 60) t += 24 * 60; // 00–03 = previous service evening
    if (t >= a && t < z) return Math.max(60, Number(b.hw) || 300);
  }
  return Number(bands[0].hw) || 300;
}

/** First train 05:30, last ~01:00. Return board minutes or null if dead. */
function nextBoardMins(departMins, hw) {
  let t = departMins;
  // 01:15–05:29 → first train
  if (t >= 75 && t < 5 * 60 + 30) t = 5 * 60 + 30;
  if (t > 25 * 60) return null;
  if (t < 5 * 60 + 30 && t >= 3 * 60) t = 5 * 60 + 30;
  const step = Math.max(1, Math.round(hw / 60));
  const rem = t % step;
  if (rem) t += step - rem;
  if (t >= 75 && t < 5 * 60 + 30) t = 5 * 60 + 30;
  return t;
}

function nearestStations(lat, lon, maxM, extraCodes = []) {
  /** @type {Array<{ code: string, dist: number, st: any }>} */
  const hits = [];
  const seen = new Set();
  for (const st of MTR_STATIONS) {
    if (!st.code || !Number.isFinite(st.lat)) continue;
    const d = haversineM(lat, lon, st.lat, st.lon);
    if (d <= maxM) {
      hits.push({ code: st.code, dist: d, st });
      seen.add(st.code);
    }
  }
  for (const code of extraCodes) {
    if (seen.has(code)) continue;
    const st = stationByCode.get(code);
    if (!st) continue;
    const d = haversineM(lat, lon, st.lat, st.lon);
    hits.push({ code, dist: d, st });
  }
  hits.sort((a, b) => a.dist - b.dist);
  if (!hits.length) return hits;
  const tight = hits.filter((h) => h.dist <= 380);
  const pool = tight.length ? tight : hits.slice(0, 1);
  const nearest = pool[0].dist;
  return pool.filter((h) => h.dist <= nearest + 150).slice(0, 2);
}

function buildGraphFrom(allowedLines) {
  /** @type {Map<string, Array<{ to: string, line: string, sec: number, pat: any }>>} */
  const g = new Map();
  const add = (a, b, e) => {
    if (!g.has(a)) g.set(a, []);
    g.get(a).push(e);
  };
  for (const pat of COMPLETED_PATTERNS) {
    if (allowedLines && !allowedLines.has(pat.line)) continue;
    for (let i = 0; i < pat.codes.length - 1; i++) {
      const a = pat.codes[i];
      const b = pat.codes[i + 1];
      const sec = Math.max(45, (pat.offs[i + 1] || 0) - (pat.offs[i] || 0));
      add(a, b, { to: b, line: pat.line, sec, pat });
    }
  }
  for (const [a, b, sec] of LINK_PAIRS) {
    add(a, b, { to: b, line: "LINK", sec, pat: null });
    add(b, a, { to: a, line: "LINK", sec, pat: null });
  }
  return g;
}

function graphFor(allowedLines) {
  if (!allowedLines) return FULL_GRAPH;
  const key = [...allowedLines].sort().join(",");
  let g = graphCache.get(key);
  if (!g) {
    g = buildGraphFrom(allowedLines);
    graphCache.set(key, g);
  }
  return g;
}

/**
 * Dijkstra on (station, line). Line change costs XFER_SEC.
 * @returns {Array<{ code: string, line: string, sec: number, pat: any }> | null}
 */
function shortestPath(graph, from, to) {
  if (from === to) return [];
  const key = (code, line) => `${code}|${line}`;
  /** @type {Map<string, { sec: number, xfers: number, prev: string | null, edge: any, code: string, line: string }>} */
  const best = new Map();
  /** @type {Array<{ sec: number, xfers: number, code: string, line: string }>} */
  const pq = [];
  const push = (sec, xfers, code, line, prev, edge) => {
    if (xfers > 2) return;
    const k = key(code, line);
    const cur = best.get(k);
    if (cur && cur.sec <= sec) return;
    best.set(k, { sec, xfers, prev, edge, code, line });
    pq.push({ sec, xfers, code, line });
  };
  push(0, 0, from, "-", null, null);
  while (pq.length) {
    let bestI = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].sec < pq[bestI].sec) bestI = i;
    }
    const cur = pq[bestI];
    const last = pq.pop();
    if (bestI < pq.length) pq[bestI] = last;
    const rec = best.get(key(cur.code, cur.line));
    if (!rec || rec.sec !== cur.sec) continue;
    if (cur.code === to) {
      const path = [];
      let k = key(cur.code, cur.line);
      while (k) {
        const n = best.get(k);
        if (!n || !n.edge) break;
        path.push({
          code: n.code,
          line: n.edge.line,
          sec: n.edge.sec,
          pat: n.edge.pat,
        });
        k = n.prev;
      }
      path.reverse();
      return path;
    }
    const edges = graph.get(cur.code) || [];
    for (const e of edges) {
      const isXfer =
        cur.line !== "-" &&
        e.line !== cur.line &&
        e.line !== "LINK" &&
        cur.line !== "LINK";
      push(
        cur.sec + e.sec + (isXfer ? XFER_SEC : 0),
        cur.xfers + (isXfer ? 1 : 0),
        e.to,
        e.line,
        key(cur.code, cur.line),
        e,
      );
    }
  }
  return null;
}

function groupLegs(path) {
  /** @type {Array<{ line: string, pat: any, codes: string[], ride: number }>} */
  const groups = [];
  for (const step of path) {
    if (step.line === "LINK") {
      groups.push({ line: "LINK", pat: null, codes: [step.code], ride: step.sec });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.line === step.line) {
      last.codes.push(step.code);
      last.ride += step.sec;
    } else {
      // start station is previous node's code — caller prepends board
      groups.push({
        line: step.line,
        pat: step.pat,
        codes: [step.code],
        ride: step.sec,
      });
    }
  }
  return groups;
}

function stopInfo(code) {
  const st = stationByCode.get(code);
  return {
    stop_id: `MTR-${code}`,
    stop_name: st?.name_en || code,
    location: {
      lat: st?.lat || 0,
      lon: st?.lon || 0,
    },
  };
}

function walkLeg(fromLat, fromLon, toCode, reverse) {
  const st = stationByCode.get(toCode);
  if (!st) return null;
  const dist = haversineM(fromLat, fromLon, st.lat, st.lon);
  if (dist <= 40) return { dist: 0, leg: null };
  const secs = Math.max(45, Math.round(dist / WALK_MPS));
  const station = {
    stop_name: st.name_en,
    stop_id: `MTR-${toCode}`,
    location: { lat: st.lat, lon: st.lon },
  };
  const pin = {
    stop_name: reverse ? "END" : "START",
    location: { lat: fromLat, lon: fromLon },
  };
  return {
    dist,
    leg: {
      type: "walk",
      walk_type: reverse ? "egress" : "access",
      distance_meters: Math.round(dist),
      duration_seconds: secs,
      from: reverse ? station : pin,
      to: reverse ? pin : station,
    },
  };
}

function lineMeta(line) {
  const names = MTR_LINE_NAMES[line] || { en: line, zh: line };
  return {
    color: MTR_LINE_COLORS[line] || "#003DA5",
    longName: names.en,
    shortName: line,
  };
}

function buildPlan(fromCode, toCode, path, origin, dest, departIso) {
  if (!path?.length) return null;
  const groups = groupLegs(path);
  if (!groups.length) return null;

  // Prepend board station onto first rail group
  let cursor = fromCode;
  for (const g of groups) {
    if (g.line === "LINK") {
      g.fromCode = cursor;
      g.toCode = g.codes[g.codes.length - 1];
      cursor = g.toCode;
      continue;
    }
    g.fromCode = cursor;
    g.codes = [cursor, ...g.codes];
    g.toCode = g.codes[g.codes.length - 1];
    cursor = g.toCode;
  }
  if (cursor !== toCode) return null;

  const access = walkLeg(origin.lat, origin.lon, fromCode, false);
  const egress = walkLeg(dest.lat, dest.lon, toCode, true);
  if (!access || !egress) return null;

  const firstRail = groups.find((g) => g.line !== "LINK");
  const hw = headwayAt(firstRail?.pat?.bands, parseDepartMins(departIso));
  const boardMins = nextBoardMins(parseDepartMins(departIso), hw);
  if (boardMins == null) return null;
  const date = parseDepartDate(departIso);

  /** @type {object[]} */
  const legs = [];
  let total = 0;
  let walkM = 0;
  if (access.leg) {
    legs.push(access.leg);
    total += access.leg.duration_seconds;
    walkM += access.dist;
  }

  let railLegs = 0;
  for (const g of groups) {
    if (g.line === "LINK") {
      const a = stationByCode.get(g.fromCode);
      const b = stationByCode.get(g.toCode);
      const dist = a && b ? haversineM(a.lat, a.lon, b.lat, b.lon) : 200;
      legs.push({
        type: "walk",
        walk_type: "station_transfer",
        indoor_interchange: true,
        free_mtr_link: true,
        distance_meters: Math.round(dist),
        duration_seconds: g.ride,
        from: stopInfo(g.fromCode),
        to: stopInfo(g.toCode),
      });
      total += g.ride;
      walkM += dist;
      continue;
    }
    const meta = lineMeta(g.line);
    const stops = g.codes.map((c, i) => {
      const info = stopInfo(c);
      info.departure_offset_minutes = i === 0 ? 0 : Math.round((g.ride * i) / Math.max(1, g.codes.length - 1) / 60);
      info.arrival_offset_minutes = info.departure_offset_minutes;
      return info;
    });
    legs.push({
      type: "transit",
      duration_seconds: g.ride,
      route_options: [
        {
          route_id: `MTR-${g.line}`,
          route_short_name: g.line,
          route_long_name: meta.longName,
          route_name: meta.longName,
          headsign: g.pat?.headsign || g.toCode,
          mode: g.line === "AEL" ? "rail" : "subway",
          color: meta.color,
          agency: { id: "MTRR", name: "MTR" },
          from: stopInfo(g.fromCode),
          to: stopInfo(g.toCode),
          stops,
        },
      ],
    });
    total += g.ride;
    railLegs += 1;
  }

  if (egress.leg) {
    legs.push(egress.leg);
    total += egress.leg.duration_seconds;
    walkM += egress.dist;
  }

  const start = formatIso(date, boardMins);
  return {
    duration_seconds: total,
    start_time: start,
    legs,
    walk_meters: Math.round(walkM),
    transfer_count: Math.max(0, railLegs - 1),
    bus_transfer_count: 0,
    mtr_transfer_count: Math.max(0, railLegs - 1),
    mixed_transfer_count: 0,
    mtr_only: true,
    has_mtr: true,
    mtr_injected: true,
    human_score: total * 0.72,
  };
}

function hintedCodes(query, which) {
  const label = which === "o" ? query.originLabel : query.destLabel;
  const flagged = which === "o" ? query.originIsMtr : query.destIsMtr;
  if (!flagged && !/\bmtr\b|站|station/i.test(String(label || ""))) return [];
  const s = String(label || "").toLowerCase();
  const out = [];
  for (const st of MTR_STATIONS) {
    if (!st.code) continue;
    const en = String(st.name_en || "").toLowerCase();
    const zh = String(st.name_zh || "");
    if (en && s.includes(en)) out.push(st.code);
    else if (zh && String(label || "").includes(zh)) out.push(st.code);
  }
  return out.slice(0, 2);
}

/**
 * @param {import("./router.ts").RouteQuery} query
 * @returns {import("./router.ts").Plan[]}
 */
export function injectMtrPlans(query) {
  const methods = query.trafficMethods;
  if (methods?.length && !methods.includes("mtr") && !methods.includes("ael")) {
    return [];
  }
  const allowed = methods?.length
    ? new Set(
        [
          methods.includes("mtr") ? ["TWL", "ISL", "KTL", "TKL", "TML", "TCL", "EAL", "SIL", "DRL"] : [],
          methods.includes("ael") ? ["AEL"] : [],
        ].flat(),
      )
    : null;
  const oLat = query.origin?.[0];
  const oLon = query.origin?.[1];
  const dLat = query.destination?.[0];
  const dLon = query.destination?.[1];
  if (![oLat, oLon, dLat, dLon].every(Number.isFinite)) return [];

  const origins = nearestStations(oLat, oLon, ACCESS_MAX_M, hintedCodes(query, "o"));
  const dests = nearestStations(dLat, dLon, ACCESS_MAX_M, hintedCodes(query, "d"));
  if (!origins.length || !dests.length) return [];

  const graph = graphFor(allowed);
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  for (const o of origins) {
    for (const d of dests) {
      if (o.code === d.code) continue;
      const path = shortestPath(graph, o.code, d.code);
      if (!path?.length) continue;
      const sig = path.map((s) => `${s.line}:${s.code}`).join(">");
      if (seen.has(sig)) continue;
      seen.add(sig);
      const plan = buildPlan(
        o.code,
        d.code,
        path,
        { lat: oLat, lon: oLon },
        { lat: dLat, lon: dLon },
        query.departAt || "",
      );
      if (plan) out.push(plan);
    }
  }
  out.sort((a, b) => a.duration_seconds - b.duration_seconds);
  return out.slice(0, 4);
}
