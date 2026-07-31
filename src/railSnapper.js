/**
 * Snap MTR / Light Rail itineraries to basemap railway geometry
 * (Protomaps `roads` layer, kind=rail — OSM subway / rail / light_rail).
 *
 * Builds a track graph from line-matched basemap segments, then A* between
 * consecutive stops so the drawn path follows the rails (incl. tunnels).
 */

import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { detectMtrLineCode } from "./mtrColors.js";

/** @typedef {{ lon: number, lat: number }} LngLat */

const TILE_Z = 14;
const PAD_DEG = 0.012;
/** Merge nearby vertices (m). Must cover dual-track spacing so both
 *  running lines form one connected graph (~15–25 m on MTR). */
const NODE_MERGE_M = 28;
/** Bridge OSM gaps / dual-track ends (m). Tsing Ma / Kap Shui Mun corridor
 *  has ~230 m vector-tile breaks between dual-track fragments. */
const GAP_BRIDGE_M = 200;
/** Named-line graphs only (same OSM name) — safe to bridge farther. */
const NAMED_GAP_BRIDGE_M = 320;
/** Max distance from stop to track when snapping (m). */
const MAX_SNAP_M = 320;
const FETCH_CONCURRENCY = 10;

const TRACK_DETAILS = new Set([
  "rail",
  "subway",
  "light_rail",
  "tram",
  "narrow_gauge",
  "monorail",
  "funicular",
  "yes",
]);

const EXCLUDE_NAME =
  /depot|yard|siding|freight|high[\s-]*speed|guangzhou|ventilation|stabling/i;

/** @type {PMTiles | null} */
let pmtiles = null;
/** @type {Map<string, Array<{ coords: LngLat[], name: string, detail: string, network: string }>>} */
const tileCache = new Map();

function pmtilesUrl() {
  const useProxy =
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  if (useProxy) return `${location.origin}/edge/hongkong.pmtiles`;
  return "https://hk-gtfsdata.morgandev.cc/hongkong.pmtiles";
}

function getPmtiles() {
  if (!pmtiles) pmtiles = new PMTiles(pmtilesUrl());
  return pmtiles;
}

/**
 * Densify an ordered stop sequence along basemap railways.
 * @param {Array<{ lon: number, lat: number, id?: string }>} stops
 * @param {{ mode?: string, route_short_name?: string, route_name?: string, route_long_name?: string, route_id?: string }} opt
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<LngLat[] | null>}
 */
export async function densifyAlongBasemapRail(stops, opt, opts = {}) {
  if (!stops || stops.length < 2) return null;

  const prefer = linePreferences(opt);
  const allSegs = await loadRailSegmentsForStops(stops, prefer, opts.signal);
  if (allSegs.length < 2) {
    console.warn("[railSnapper] few rail segments", allSegs.length);
    return null;
  }

  // Progressive segment sets: strict line name → + same mode → all usable track
  const named = allSegs.filter((s) => isNameMatch(s, prefer) && !EXCLUDE_NAME.test(s.name));
  const preferred = allSegs.filter(
    (s) =>
      prefer.preferDetails.has(s.detail) &&
      !prefer.avoidDetails.has(s.detail) &&
      !EXCLUDE_NAME.test(s.name) &&
      !isExcludedCrossLine(s, prefer),
  );
  const usable = allSegs.filter(
    (s) =>
      TRACK_DETAILS.has(s.detail) &&
      !EXCLUDE_NAME.test(s.name) &&
      !prefer.avoidDetails.has(s.detail) &&
      !isExcludedCrossLine(s, prefer),
  );

  const sets = [];
  if (named.length >= 2) sets.push({ label: "named", segs: named });
  // Named + a limited amount of anonymous preferred-detail connectors
  if (named.length >= 1) {
    const anon = preferred.filter((s) => !s.name || !isNameMatch(s, prefer));
    sets.push({
      label: "named+anon",
      segs: uniqueSegs([...named, ...anon]),
    });
  }
  if (preferred.length >= 2) sets.push({ label: "preferred", segs: preferred });
  if (usable.length >= 2) sets.push({ label: "usable", segs: usable });

  // Pre-build graphs (strict → loose) for per-hop recovery
  /** @type {Array<{ label: string, graph: ReturnType<typeof buildRailGraph>, segs: typeof named }>} */
  const graphs = [];
  for (const { label, segs } of sets) {
    // Named-only graphs: larger bridge (same OSM line; e.g. Tsing Ma gap ~230 m)
    const bridgeM = label.startsWith("named") ? NAMED_GAP_BRIDGE_M : GAP_BRIDGE_M;
    const graph = buildRailGraph(segs, prefer, bridgeM);
    if (graph.nodeCount >= 4) graphs.push({ label, graph, segs });
  }
  if (!graphs.length) return null;

  const isLrt =
    prefer.code === "LRT" ||
    prefer.preferDetails.has("light_rail") ||
    String(opt?.mode || "").toLowerCase() === "tram" ||
    String(opt?.mode || "").toLowerCase() === "light_rail";

  const full = [];
  let ok = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const a = stops[i];
    const b = stops[i + 1];
    const hopM = haversineM(a.lat, a.lon, b.lat, b.lon);

    // Hand-corrected LRT alignments (Tin Wing YOHO West, …) beat stale basemap loops
    if (isLrt) {
      try {
        const { lrtHopOverride } = await import("./lrtShapes.js");
        const override = lrtHopOverride(
          {
            lon: a.lon,
            lat: a.lat,
            stop_name: a.stop_name || a.name || a.id,
            name: a.stop_name || a.name,
          },
          {
            lon: b.lon,
            lat: b.lat,
            stop_name: b.stop_name || b.name || b.id,
            name: b.stop_name || b.name,
          },
        );
        if (override?.length >= 2) {
          const path = clipPolylineToEndpoints(override, a, b);
          ok += 1;
          if (i === 0) full.push(...path);
          else full.push(...path.slice(1));
          continue;
        }
      } catch {
        /* optional */
      }
    }

    let path = null;
    for (const { graph } of graphs) {
      // Graphs are mutated by snap virtual nodes — OK to share across hops.
      const candidate = shortestPathBetween(graph, a, b);
      if (candidate && isAcceptableHop(candidate, a, b, { strictLoop: isLrt && hopM < 1200 })) {
        path = candidate;
        break;
      }
    }
    // Long water/bridge hops: rebuild named graph with extra gap bridge
    if (!path && hopM > 4000 && named.length >= 2) {
      const gLong = buildRailGraph(named, prefer, Math.max(NAMED_GAP_BRIDGE_M, 450));
      const candidate = shortestPathBetween(gLong, a, b);
      if (candidate && isAcceptableHop(candidate, a, b)) path = candidate;
    }
    if (!path) {
      // Last resort stop-chord for this hop only
      console.warn("[railSnapper] hop", i, "no track path", prefer.code || prefer.mode);
      if (i === 0) full.push({ lon: a.lon, lat: a.lat });
      full.push({ lon: b.lon, lat: b.lat });
      continue;
    }
    // Clip hop so track path does not overshoot past the stop (e.g. past ETS
    // toward Hung Hom) and then need a spur back to the platform pin.
    path = clipPolylineToEndpoints(path, a, b);
    ok += 1;
    if (i === 0) full.push(...path);
    else full.push(...path.slice(1));
  }

  if (ok === 0) return null;
  const first = stops[0];
  const last = stops[stops.length - 1];
  // Final clip + short stubs to exact platform pins (no long overshoot spur)
  const poly = dedupeCoords(
    clipPolylineToEndpoints(full, first, last),
  );
  console.info(
    "[railSnapper]",
    prefer.code || prefer.mode,
    "hops",
    `${ok}/${stops.length - 1}`,
    "pts",
    poly.length,
  );
  return poly;
}

/**
 * Keep only the path from the closest approach to `start` through the closest
 * approach to `end`, then short stubs to the exact stop/platform coords.
 * Prevents basemap routing past a station then drawing a line back.
 *
 * @param {LngLat[]} poly
 * @param {{ lon: number, lat: number } | null | undefined} start
 * @param {{ lon: number, lat: number } | null | undefined} end
 * @returns {LngLat[]}
 */
export function clipPolylineToEndpoints(poly, start, end) {
  if (!poly?.length) return poly || [];
  let coords = poly.map((p) => ({ lon: p.lon, lat: p.lat }));
  if (coords.length < 2) {
    const out = [...coords];
    if (start && Number.isFinite(start.lon) && Number.isFinite(start.lat)) {
      out.unshift({ lon: start.lon, lat: start.lat });
    }
    if (end && Number.isFinite(end.lon) && Number.isFinite(end.lat)) {
      out.push({ lon: end.lon, lat: end.lat });
    }
    return dedupeCoords(out);
  }

  // Trim tail past closest approach to end
  if (end && Number.isFinite(end.lon) && Number.isFinite(end.lat)) {
    const hit = closestPointOnPolyline(coords, end);
    if (hit) {
      coords = [
        ...coords.slice(0, hit.segIndex + 1),
        { lon: hit.lon, lat: hit.lat },
      ];
    }
  }

  // Trim head before closest approach to start
  if (start && Number.isFinite(start.lon) && Number.isFinite(start.lat)) {
    const hit = closestPointOnPolyline(coords, start);
    if (hit) {
      coords = [
        { lon: hit.lon, lat: hit.lat },
        ...coords.slice(hit.segIndex + 1),
      ];
    }
  }

  coords = dedupeCoords(coords);
  if (!coords.length) {
    if (start && end) return [{ lon: start.lon, lat: start.lat }, { lon: end.lon, lat: end.lat }];
    return coords;
  }

  // Short stubs from track to platform (platforms sit off the track axis)
  const MAX_STUB_M = 100;
  if (start && Number.isFinite(start.lon) && Number.isFinite(start.lat)) {
    const d0 = haversineM(coords[0].lat, coords[0].lon, start.lat, start.lon);
    if (d0 > 0.8 && d0 <= MAX_STUB_M) {
      coords.unshift({ lon: start.lon, lat: start.lat });
    } else if (d0 > MAX_STUB_M) {
      // Snap start of drawn path to platform without a long diagonal across the map
      coords[0] = { lon: start.lon, lat: start.lat };
    } else {
      coords[0] = { lon: start.lon, lat: start.lat };
    }
  }
  if (end && Number.isFinite(end.lon) && Number.isFinite(end.lat)) {
    const last = coords[coords.length - 1];
    const d1 = haversineM(last.lat, last.lon, end.lat, end.lon);
    if (d1 > 0.8 && d1 <= MAX_STUB_M) {
      coords.push({ lon: end.lon, lat: end.lat });
    } else if (d1 > MAX_STUB_M) {
      coords[coords.length - 1] = { lon: end.lon, lat: end.lat };
    } else {
      coords[coords.length - 1] = { lon: end.lon, lat: end.lat };
    }
  }
  return dedupeCoords(coords);
}

/**
 * Closest projection of a point onto a polyline.
 * @param {LngLat[]} poly
 * @param {{ lon: number, lat: number }} point
 */
function closestPointOnPolyline(poly, point) {
  if (!poly?.length || !point) return null;
  if (poly.length === 1) {
    return {
      lon: poly[0].lon,
      lat: poly[0].lat,
      err: haversineM(point.lat, point.lon, poly[0].lat, poly[0].lon),
      segIndex: 0,
      t: 0,
    };
  }
  let best = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const pr = projectPoint(point, poly[i], poly[i + 1]);
    if (!best || pr.err < best.err - 1e-6) {
      best = { ...pr, segIndex: i };
    }
  }
  return best;
}

function isAcceptableHop(path, a, b, opts = {}) {
  const pathM = pathLengthM(path);
  const chordM = haversineM(a.lat, a.lon, b.lat, b.lon);
  // Long bridge/tunnel corridors (e.g. Tsing Ma) can be ~1.2–1.5× chord
  if (chordM > 40 && pathM > chordM * 3.5) return false;
  // LRT short hops: reject basemap detours through demolished loops
  // (Tin Wing old outdoor loop was ~2–3× the Tin Shing Road approach)
  if (opts.strictLoop && chordM > 40 && pathM > chordM * 1.75) return false;
  // Reject pure 2-point chord disguised as path when hop is long
  if (path.length <= 2 && chordM > 250) return false;
  // Need some intermediate geometry on multi-km hops (not a straight sea chord)
  if (chordM > 3000 && path.length < 8) return false;
  return true;
}

// ── line preference ─────────────────────────────────────────────────────────

function linePreferences(opt) {
  const mode = String(opt?.mode || "").toLowerCase();
  const code = detectMtrLineCode(opt);
  const blob = `${opt?.route_short_name || ""} ${opt?.route_name || ""} ${opt?.route_long_name || ""} ${opt?.route_id || ""}`;

  /** @type {RegExp[]} */
  const nameRes = [];
  /** @type {Set<string>} */
  const preferDetails = new Set();
  /** @type {Set<string>} */
  const avoidDetails = new Set();

  // Specific patterns — avoid cross-matching (e.g. Island vs South Island)
  const byCode = {
    EAL: [/east\s*rail/i, /東鐵/],
    TWL: [/tsuen\s*wan\s*line/i, /荃灣綫|荃灣線/],
    ISL: [/港島綫|港島線/, /\bisland\s*line\b/i],
    KTL: [/kwun\s*tong\s*line/i, /觀塘綫|觀塘線/],
    TKL: [/tseung\s*kwan\s*o/i, /將軍澳/],
    // Shared Airport Railway corridor is often tagged "Lantau and Airport Railway"
    TCL: [
      /tung\s*chung\s*line/i,
      /東涌綫|東涌線/,
      /lantau\s*and\s*airport/i,
      /airport\s*railway/i,
    ],
    AEL: [
      /airport\s*express/i,
      /機場快/,
      /lantau\s*and\s*airport/i,
      /airport\s*railway/i,
    ],
    TML: [/tuen\s*ma/i, /屯馬/, /west\s*rail/i, /西鐵/, /ma\s*on\s*shan/i, /馬鞍山/],
    MOL: [/ma\s*on\s*shan/i, /馬鞍山/, /tuen\s*ma/i],
    WRL: [/west\s*rail/i, /西鐵/, /tuen\s*ma/i],
    SIL: [/south\s*island/i, /南港島/],
    DRL: [/disneyland/i, /迪士尼/],
    LRT: [/light\s*rail/i, /輕鐵/],
  };

  if (code && byCode[code]) nameRes.push(...byCode[code]);

  if (mode === "light_rail" || code === "LRT" || /light\s*rail|輕鐵/i.test(blob)) {
    preferDetails.add("light_rail");
    avoidDetails.add("subway");
    avoidDetails.add("tram");
    if (!nameRes.length) nameRes.push(/light\s*rail/i, /輕鐵/);
  } else if (mode === "tram" || /tramways|電車/i.test(blob)) {
    preferDetails.add("tram");
    avoidDetails.add("subway");
    avoidDetails.add("light_rail");
    if (!nameRes.length) nameRes.push(/hong\s*kong\s*tram/i, /電車/);
  } else {
    preferDetails.add("subway");
    preferDetails.add("rail");
    avoidDetails.add("tram");
    avoidDetails.add("light_rail");
    if (!nameRes.length) nameRes.push(/\bmtr\b/i, /港鐵/);
  }

  return { code, nameRes, preferDetails, avoidDetails, mode };
}

/**
 * True if this OSM name matches the requested line (with anti-confusion rules).
 */
function isNameMatch(seg, prefer) {
  const name = String(seg.name || "");
  if (!name) return false;
  if (!prefer.nameRes.some((re) => re.test(name))) return false;

  // Island Line must not match South Island Line
  if (prefer.code === "ISL" && /south\s*island|南港島/i.test(name)) return false;
  // Tuen Ma vs legacy West Rail / Ma On Shan only when code asks for them
  if (prefer.code === "TML" && /east\s*rail|airport|island|tsuen\s*wan|kwun\s*tong/i.test(name) && !/tuen\s*ma|屯馬|west\s*rail|ma\s*on\s*shan/i.test(name)) {
    return false;
  }
  // West Rail / MOL codes also accept Tuen Ma (same corridor now)
  if ((prefer.code === "WRL" || prefer.code === "MOL") && /tuen\s*ma/i.test(name)) {
    return true;
  }
  return true;
}

/** Drop obvious other MTR lines when we know our code. */
function isExcludedCrossLine(seg, prefer) {
  const name = String(seg.name || "");
  if (!prefer.code || !name) return false;
  // Always drop HSR
  if (/high[\s-]*speed|guangzhou/i.test(name)) return true;
  if (prefer.code === "ISL" && /south\s*island/i.test(name)) return true;
  if (prefer.code === "SIL" && /\bisland\s*line\b/i.test(name) && !/south/i.test(name)) {
    return true;
  }
  // When we have a specific line, drop other clearly named heavy lines
  if (prefer.code && prefer.code !== "LRT") {
    const others = [
      [/east\s*rail/i, "EAL"],
      [/tsuen\s*wan\s*line/i, "TWL"],
      [/south\s*island/i, "SIL"],
      [/\bisland\s*line\b/i, "ISL"],
      [/kwun\s*tong\s*line/i, "KTL"],
      [/tseung\s*kwan\s*o/i, "TKL"],
      [/tung\s*chung\s*line/i, "TCL"],
      [/airport\s*express/i, "AEL"],
      [/tuen\s*ma/i, "TML"],
      [/disneyland/i, "DRL"],
    ];
    for (const [re, code] of others) {
      if (code === prefer.code) continue;
      // TML also owns west rail / ma on shan names
      if (
        prefer.code === "TML" &&
        (code === "WRL" || code === "MOL" || code === "TML")
      ) {
        continue;
      }
      if ((prefer.code === "WRL" || prefer.code === "MOL") && code === "TML") {
        continue;
      }
      // Island line regex also hits "South Island" — handled above
      if (code === "ISL" && /south\s*island/i.test(name)) continue;
      if (re.test(name)) return true;
    }
  }
  return false;
}

function segmentWeight(seg, lengthM, prefer) {
  let w = lengthM;
  const name = seg.name || "";
  const detail = seg.detail || "";

  if (prefer.avoidDetails.has(detail)) w *= 60;
  if (EXCLUDE_NAME.test(name)) w *= 100;
  if (isExcludedCrossLine(seg, prefer)) w *= 80;

  if (isNameMatch(seg, prefer)) w *= 0.1;
  else if (prefer.preferDetails.has(detail) && /mtr|港鐵|light\s*rail/i.test(name + seg.network))
    w *= 1.4;
  else if (prefer.preferDetails.has(detail)) w *= 2.5;
  else w *= 12;

  if (/mtr|港鐵/i.test(seg.network || "")) w *= 0.92;
  return Math.max(w, 0.5);
}

// ── tile loading ────────────────────────────────────────────────────────────

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tile(lat, z) {
  return Math.floor(
    ((1 -
      Math.log(
        Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180),
      ) /
        Math.PI) /
      2) *
      2 ** z,
  );
}

function tilesAlongStops(stops, z, pad) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const hopM = haversineM(a.lat, a.lon, b.lat, b.lon);
    const p = Math.max(pad, Math.min(0.028, (hopM / 111_000) * 0.55 + pad * 0.4));
    const minLon = Math.min(a.lon, b.lon) - p;
    const maxLon = Math.max(a.lon, b.lon) + p;
    const minLat = Math.min(a.lat, b.lat) - p;
    const maxLat = Math.max(a.lat, b.lat) + p;
    const x0 = lon2tile(minLon, z);
    const x1 = lon2tile(maxLon, z);
    const y0 = lat2tile(maxLat, z);
    const y1 = lat2tile(minLat, z);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        keys.add(`${z}/${x}/${y}`);
      }
    }
  }
  // Keep a generous tile budget so long NT corridors (e.g. TML West Rail)
  // are not missing mid-hop tiles (shrinking pad caused disconnected graphs).
  if (keys.size > 420) {
    console.warn("[railSnapper] many tiles", keys.size);
  }
  return [...keys];
}

async function loadRailSegmentsForStops(stops, prefer, signal) {
  const keys = tilesAlongStops(stops, TILE_Z, PAD_DEG);
  const segs = [];
  for (let i = 0; i < keys.length; i += FETCH_CONCURRENCY) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = keys.slice(i, i + FETCH_CONCURRENCY);
    const parts = await Promise.all(batch.map((k) => loadTileSegments(k)));
    for (const list of parts) segs.push(...list);
  }

  return segs.filter((s) => {
    if (!TRACK_DETAILS.has(s.detail) && s.detail !== "?") {
      if (!/mtr|light\s*rail|港鐵|輕鐵/i.test(s.name)) return false;
    }
    if (EXCLUDE_NAME.test(s.name) && !isNameMatch(s, prefer)) return false;
    if (/high[\s-]*speed|guangzhou/i.test(s.name)) return false;
    return true;
  });
}

async function loadTileSegments(key) {
  if (tileCache.has(key)) return tileCache.get(key);

  const [zs, xs, ys] = key.split("/").map(Number);
  try {
    const t = await getPmtiles().getZxy(zs, xs, ys);
    if (!t?.data) {
      tileCache.set(key, []);
      return [];
    }
    const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
    const roads = vt.layers.roads;
    if (!roads) {
      tileCache.set(key, []);
      return [];
    }
    /** @type {Array<{ coords: LngLat[], name: string, detail: string, network: string }>} */
    const out = [];
    for (let i = 0; i < roads.length; i++) {
      const f = roads.feature(i);
      const p = f.properties || {};
      if (p.kind !== "rail") continue;
      const detail = String(p.kind_detail || "?");
      if (
        detail === "depot" ||
        detail === "station" ||
        detail === "yard" ||
        detail === "ventilation_shaft" ||
        detail === "disused"
      ) {
        continue;
      }
      const gj = f.toGeoJSON(xs, ys, zs);
      const lines = coordsFromGeom(gj.geometry);
      const name = String(p["name:en"] || p.name2 || p.name || "");
      const network = String(p.network || "");
      for (const coords of lines) {
        if (coords.length >= 2) out.push({ coords, name, detail, network });
      }
    }
    tileCache.set(key, out);
    return out;
  } catch (e) {
    console.warn("[railSnapper] tile", key, e);
    tileCache.set(key, []);
    return [];
  }
}

function coordsFromGeom(geom) {
  if (!geom) return [];
  if (geom.type === "LineString") {
    return [geom.coordinates.map(([lon, lat]) => ({ lon, lat }))];
  }
  if (geom.type === "MultiLineString") {
    return geom.coordinates.map((ring) =>
      ring.map(([lon, lat]) => ({ lon, lat })),
    );
  }
  return [];
}

function uniqueSegs(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = `${s.name}|${s.detail}|${s.coords[0]?.lon?.toFixed(5)}|${s.coords[0]?.lat?.toFixed(5)}|${s.coords.length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// ── graph + A* ──────────────────────────────────────────────────────────────

function buildRailGraph(segs, prefer, bridgeM = GAP_BRIDGE_M) {
  /** @type {Map<string, { lon: number, lat: number, edges: Array<{ to: string, w: number, path: LngLat[] }> }>} */
  const nodes = new Map();

  function keyOf(lon, lat) {
    const q = 1e5;
    return `${Math.round(lon * q)}_${Math.round(lat * q)}`;
  }

  function ensure(lon, lat) {
    const k = keyOf(lon, lat);
    if (!nodes.has(k)) nodes.set(k, { lon, lat, edges: [] });
    return k;
  }

  function addEdge(a, b, w, path) {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    if (!na || !nb || a === b) return;
    // Skip duplicate edges to same target (keep cheaper)
    const existing = na.edges.find((e) => e.to === b);
    if (existing) {
      if (w < existing.w) {
        existing.w = w;
        existing.path = path;
      }
    } else {
      na.edges.push({ to: b, w, path });
    }
    const existingR = nb.edges.find((e) => e.to === a);
    const rev = path.slice().reverse();
    if (existingR) {
      if (w < existingR.w) {
        existingR.w = w;
        existingR.path = rev;
      }
    } else {
      nb.edges.push({ to: a, w, path: rev });
    }
  }

  for (const seg of segs) {
    const c = seg.coords;
    for (let i = 0; i < c.length - 1; i++) {
      const p0 = c[i];
      const p1 = c[i + 1];
      const len = haversineM(p0.lat, p0.lon, p1.lat, p1.lon);
      if (len < 0.3) continue;
      const a = ensure(p0.lon, p0.lat);
      const b = ensure(p1.lon, p1.lat);
      if (a === b) continue;
      addEdge(a, b, segmentWeight(seg, len, prefer), [p0, p1]);
    }
  }

  // Seam merge + gap bridges. Cell ring must cover bridgeM (was ±1 cell ≈ 60 m,
  // which silently ignored larger OSM gaps and left dual-track components split).
  const list = [...nodes.entries()];
  const cell = 0.00025; // ~28 m
  const ring = Math.max(1, Math.ceil(bridgeM / 28) + 1);
  /** @type {Map<string, string[]>} */
  const grid = new Map();
  for (const [k, n] of list) {
    const gk = `${Math.floor(n.lon / cell)}_${Math.floor(n.lat / cell)}`;
    if (!grid.has(gk)) grid.set(gk, []);
    grid.get(gk).push(k);
  }
  for (const [k, n] of list) {
    const cx = Math.floor(n.lon / cell);
    const cy = Math.floor(n.lat / cell);
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const nearby = grid.get(`${cx + dx}_${cy + dy}`);
        if (!nearby) continue;
        for (const k2 of nearby) {
          if (k2 <= k) continue;
          const n2 = nodes.get(k2);
          const d = haversineM(n.lat, n.lon, n2.lat, n2.lon);
          if (d <= 0) continue;
          if (d <= NODE_MERGE_M) {
            addEdge(k, k2, d * 1.5, [
              { lon: n.lon, lat: n.lat },
              { lon: n2.lon, lat: n2.lat },
            ]);
          } else if (d <= bridgeM) {
            // Costly bridge so real track is preferred when available
            addEdge(k, k2, d * 3.2, [
              { lon: n.lon, lat: n.lat },
              { lon: n2.lon, lat: n2.lat },
            ]);
          }
        }
      }
    }
  }

  return {
    nodes,
    get nodeCount() {
      return nodes.size;
    },
  };
}

/**
 * Snap a stop onto the nearest graph edge and splice a virtual node so
 * routing can enter the track mid-segment (not only near vertices).
 * @returns {{ id: string, lon: number, lat: number } | null}
 */
function snapToGraph(graph, point) {
  let best = null;
  for (const [fromId, node] of graph.nodes) {
    for (const e of node.edges) {
      const path = e.path;
      if (!path || path.length < 2) continue;
      // Most edges are 2-point; still handle multi-point
      for (let i = 0; i < path.length - 1; i++) {
        const pr = projectPoint(point, path[i], path[i + 1]);
        if (!best || pr.err < best.err) {
          best = {
            ...pr,
            fromId,
            toId: e.to,
            a: path[i],
            b: path[i + 1],
          };
        }
      }
    }
  }
  if (!best || best.err > MAX_SNAP_M) return null;

  // Reuse existing node if close to projection
  for (const [id, n] of graph.nodes) {
    if (haversineM(n.lat, n.lon, best.lat, best.lon) < 12) {
      return { id, lon: n.lon, lat: n.lat };
    }
  }

  const vid = `v_${best.lon.toFixed(5)}_${best.lat.toFixed(5)}`;
  if (graph.nodes.has(vid)) {
    const n = graph.nodes.get(vid);
    return { id: vid, lon: n.lon, lat: n.lat };
  }

  const vNode = { lon: best.lon, lat: best.lat, edges: [] };
  graph.nodes.set(vid, vNode);

  const snapPt = { lon: best.lon, lat: best.lat };
  const fromN = graph.nodes.get(best.fromId);
  const toN = graph.nodes.get(best.toId);

  // Splice onto the edge endpoints (guarantees connectivity on that track)
  if (fromN) {
    const w1 = Math.max(
      haversineM(fromN.lat, fromN.lon, best.lat, best.lon),
      0.5,
    );
    linkNodes(fromN, best.fromId, vNode, vid, w1, [
      { lon: fromN.lon, lat: fromN.lat },
      snapPt,
    ]);
  }
  if (toN && best.toId !== best.fromId) {
    const w2 = Math.max(
      haversineM(best.lat, best.lon, toN.lat, toN.lon),
      0.5,
    );
    linkNodes(vNode, vid, toN, best.toId, w2, [snapPt, { lon: toN.lon, lat: toN.lat }]);
  }

  // Also link to a few nearby nodes (helps parallel tracks / seams)
  const near = [];
  for (const [id, n] of graph.nodes) {
    if (id === vid || id === best.fromId || id === best.toId) continue;
    const d = haversineM(n.lat, n.lon, best.lat, best.lon);
    if (d < 70) near.push({ id, d, n });
  }
  near.sort((a, b) => a.d - b.d);
  for (const { id, d, n } of near.slice(0, 4)) {
    linkNodes(vNode, vid, n, id, Math.max(d, 0.5) * 1.4, [
      snapPt,
      { lon: n.lon, lat: n.lat },
    ]);
  }

  return { id: vid, lon: best.lon, lat: best.lat };
}

function linkNodes(na, idA, nb, idB, w, path) {
  if (!na || !nb || idA === idB) return;
  const ex = na.edges.find((e) => e.to === idB);
  if (ex) {
    if (w < ex.w) {
      ex.w = w;
      ex.path = path;
    }
  } else {
    na.edges.push({ to: idB, w, path });
  }
  const rev = path.slice().reverse();
  const exR = nb.edges.find((e) => e.to === idA);
  if (exR) {
    if (w < exR.w) {
      exR.w = w;
      exR.path = rev;
    }
  } else {
    nb.edges.push({ to: idA, w, path: rev });
  }
}

function shortestPathBetween(graph, a, b) {
  const sa = snapToGraph(graph, a);
  const sb = snapToGraph(graph, b);
  if (!sa || !sb) return null;
  if (sa.id === sb.id) {
    return [
      { lon: sa.lon, lat: sa.lat },
      { lon: sb.lon, lat: sb.lat },
    ];
  }

  const dist = new Map([[sa.id, 0]]);
  const prev = new Map();
  const prevEdge = new Map();
  const done = new Set();
  const hOf = (id) => {
    const n = graph.nodes.get(id);
    if (!n) return 0;
    return haversineM(n.lat, n.lon, sb.lat, sb.lon) * 0.92;
  };
  const fScore = new Map([[sa.id, hOf(sa.id)]]);

  while (true) {
    let u = null;
    let bestF = Infinity;
    for (const [id] of dist) {
      if (done.has(id)) continue;
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        u = id;
      }
    }
    if (u == null || u === sb.id) break;
    done.add(u);
    const bestD = dist.get(u) ?? Infinity;
    const node = graph.nodes.get(u);
    if (!node) continue;
    for (const e of node.edges) {
      const nd = bestD + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, u);
        prevEdge.set(e.to, e);
        fScore.set(e.to, nd + hOf(e.to));
      }
    }
  }

  if (!dist.has(sb.id)) return null;

  const edgeChain = [];
  let cur = sb.id;
  while (cur !== sa.id) {
    const e = prevEdge.get(cur);
    const p = prev.get(cur);
    if (!e || p == null) break;
    edgeChain.push(e);
    cur = p;
  }
  edgeChain.reverse();

  /** @type {LngLat[]} */
  const coords = [{ lon: sa.lon, lat: sa.lat }];
  for (const e of edgeChain) {
    const path = e.path || [];
    for (let i = 1; i < path.length; i++) coords.push(path[i]);
  }
  // Ensure we end on snap B
  const last = coords[coords.length - 1];
  if (
    !last ||
    Math.abs(last.lon - sb.lon) > 1e-7 ||
    Math.abs(last.lat - sb.lat) > 1e-7
  ) {
    coords.push({ lon: sb.lon, lat: sb.lat });
  }
  return dedupeCoords(coords);
}

function projectPoint(p, a, b) {
  const cos = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lon * cos;
  const ay = a.lat;
  const bx = b.lon * cos;
  const by = b.lat;
  const px = p.lon * cos;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 < 1e-18 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const lon = a.lon + (b.lon - a.lon) * t;
  const lat = a.lat + (b.lat - a.lat) * t;
  const err = haversineM(p.lat, p.lon, lat, lon);
  return { lon, lat, err, t };
}

function dedupeCoords(coords) {
  const out = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.lon - c.lon) < 1e-7 &&
      Math.abs(prev.lat - c.lat) < 1e-7
    ) {
      continue;
    }
    out.push(c);
  }
  return out;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pathLengthM(coords) {
  let n = 0;
  for (let i = 1; i < coords.length; i++) {
    n += haversineM(
      coords[i - 1].lat,
      coords[i - 1].lon,
      coords[i].lat,
      coords[i].lon,
    );
  }
  return n;
}
