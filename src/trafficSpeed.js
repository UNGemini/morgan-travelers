/**
 * TD Traffic Speed injection for the Live Bus Position Engine (PRD 4.2).
 *
 * Sources (spike-verified 2026-08, direct client fetch — both serve
 * `Access-Control-Allow-Origin: *`, so no same-origin proxy is needed and
 * the COEP `require-corp` isolation is satisfied by the CORS response):
 *
 *   Dynamic (every ~5 min):
 *     https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol-all.xml
 *     → per-detector per-lane speed/volume/occupancy (km/h).
 *   Static metadata (detector → lat/lon, road, direction):
 *     https://static.data.gov.hk/td/traffic-data-strategic-major-roads/info/
 *       traffic_speed_volume_occ_info.csv
 *     → 807 detectors on strategic/major roads with explicit coordinates.
 *
 * The 2nd-gen dataset is detector-based (successor of the retired 1st-gen
 * TrafficSpeedMap.csv); segment geometry (irnAvgSpeed-all.xml) is not
 * published with coordinates, so injection uses nearest-detector speed.
 */

/** Dynamic speed feed (TD Traffic Data of Strategic / Major Roads, 2nd Gen). */
const TRAFFIC_SPEED_URL =
  "https://resource.data.one.gov.hk/td/traffic-detectors/rawSpeedVol-all.xml";
/** Static detector directory (id → coordinates). */
const DETECTOR_INFO_URL =
  "https://static.data.gov.hk/td/traffic-data-strategic-major-roads/info/traffic_speed_volume_occ_info.csv";

const SPEED_TTL_MS = 5 * 60_000; // TD publishes every ~5 min
const INFO_TTL_MS = 24 * 60 * 60_000; // detector directory is static

/** Speed (km/h) → traffic multiplier buckets (nominal = 1). */
function speedToMultiplier(speedKmh) {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return 1;
  if (speedKmh < 15) return 0.35; // crawling
  if (speedKmh < 30) return 0.6; // congested
  if (speedKmh < 45) return 0.8; // heavy
  if (speedKmh < 60) return 0.95; // light
  return 1.1; // free-flow
}

/**
 * Hand-rolled XML extraction (repo convention: no parser library).
 * @param {string} text
 * @returns {Map<string, number>} detectorId → average speed (km/h) of valid lanes
 */
export function parseDetectorSpeedXml(text) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const detectorRe = /<detector>([\s\S]*?)<\/detector>/g;
  const idRe = /<detector_id>\s*([^<]+?)\s*<\/detector_id>/;
  const laneRe = /<lane>([\s\S]*?)<\/lane>/g;
  const speedRe = /<speed>\s*([^<]+?)\s*<\/speed>/;
  const validRe = /<valid>\s*([^<]+?)\s*<\/valid>/;
  let m;
  while ((m = detectorRe.exec(text))) {
    const block = m[1];
    const idm = idRe.exec(block);
    if (!idm) continue;
    const id = String(idm[1]).trim();
    let sum = 0;
    let n = 0;
    let lm;
    while ((lm = laneRe.exec(block))) {
      const lane = lm[1];
      const valid = validRe.exec(lane)?.[1]?.trim()?.toUpperCase();
      if (valid !== "Y") continue;
      const sp = Number(speedRe.exec(lane)?.[1]);
      if (Number.isFinite(sp) && sp >= 0) {
        sum += sp;
        n += 1;
      }
    }
    if (id && n) out.set(id, sum / n);
  }
  return out;
}

/**
 * Hand-rolled CSV parse of the detector directory.
 * @param {string} text
 * @returns {Array<{ id: string, lat: number, lon: number, road: string, direction: string }>}
 */
export function parseDetectorInfoCsv(text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.length) return rows;
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const idx = {
    id: header.indexOf("AID_ID_Number"),
    lat: header.indexOf("Latitude"),
    lon: header.indexOf("Longitude"),
    road: header.indexOf("Road_EN"),
    direction: header.indexOf("Direction"),
  };
  if (idx.id < 0 || idx.lat < 0 || idx.lon < 0) return rows;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Naive CSV split: quoted fields may contain commas, so walk chars.
    const cells = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    const lat = Number(cells[idx.lat]);
    const lon = Number(cells[idx.lon]);
    const id = String(cells[idx.id] || "").trim();
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({
      id,
      lat,
      lon,
      road: String(cells[idx.road] || "").trim(),
      direction: String(cells[idx.direction] || "").trim(),
    });
  }
  return rows;
}

/** ~200 m grid cell size in degrees (lat; lon scaled by cos(lat)). */
const CELL_M = 200;

/**
 * Spatial index over detector points with live speeds.
 * `multiplierAt(lon, lat)` returns the distance-weighted multiplier of the
 * up-to-3 nearest detectors within 400 m, or the nominal 1 when none.
 */
export class TrafficIndex {
  /** @param {Array<{ id: string, lat: number, lon: number, road: string, direction: string }>} detectors @param {Map<string, number>} speeds */
  constructor(detectors, speeds) {
    this.detectors = detectors || [];
    this.speeds = speeds || new Map();
    /** @type {Map<string, number[]>} cellKey → detector indices */
    this.cells = new Map();
    this.detectors.forEach((d, i) => {
      if (!Number.isFinite(d?.lat) || !Number.isFinite(d?.lon)) return;
      const key = cellKey(d.lat, d.lon);
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
  }

  /** @returns {number} traffic multiplier (0.35–1.1) for a lon/lat */
  multiplierAt(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 1;
    const cos = Math.cos((lat * Math.PI) / 180);
    const cands = [];
    const cellLat = Math.round((lat * 111320) / CELL_M);
    const cellLon = Math.round((lon * 111320 * cos) / CELL_M);
    // 400 m radius → ±2 cells
    for (let dl = -2; dl <= 2; dl++) {
      for (let dn = -2; dn <= 2; dn++) {
        const list = this.cells.get(`${cellLat + dl}|${cellLon + dn}`);
        if (!list) continue;
        for (const i of list) {
          const d = this.detectors[i];
          const sp = this.speeds.get(d.id);
          if (sp == null) continue;
          const dist = haversineM(lat, lon, d.lat, d.lon);
          if (dist <= 400) cands.push({ dist, mult: speedToMultiplier(sp) });
        }
      }
    }
    if (!cands.length) return 1;
    cands.sort((a, b) => a.dist - b.dist);
    const top = cands.slice(0, 3);
    let wSum = 0;
    let mSum = 0;
    for (const c of top) {
      const w = 1 / (1 + c.dist); // closer detectors dominate
      wSum += w;
      mSum += w * c.mult;
    }
    return wSum ? mSum / wSum : 1;
  }
}

function cellKey(lat, lon) {
  const cos = Math.cos((lat * Math.PI) / 180);
  return `${Math.round((lat * 111320) / CELL_M)}|${Math.round((lon * 111320 * cos) / CELL_M)}`;
}

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

let infoCache = { t: 0, rows: null };
let speedCache = { t: 0, index: null };

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`traffic ${res.status} ${url}`);
  return res.text();
}

/** Load the static detector directory once per session (24 h TTL). */
async function ensureDetectorInfo(signal) {
  const now = Date.now();
  if (infoCache.rows && now - infoCache.t < INFO_TTL_MS) return infoCache.rows;
  const text = await fetchText(DETECTOR_INFO_URL, signal);
  infoCache = { t: now, rows: parseDetectorInfoCsv(text) };
  return infoCache.rows;
}

/**
 * Fetch the live speed feed and build a fresh TrafficIndex (5 min TTL).
 * Returns null on any failure so the engine can coast — never throws.
 * @param {AbortSignal} [signal]
 * @returns {Promise<TrafficIndex | null>}
 */
export async function fetchTrafficSpeed(signal) {
  const now = Date.now();
  if (speedCache.index && now - speedCache.t < SPEED_TTL_MS) {
    return speedCache.index;
  }
  try {
    const [info, xml] = await Promise.all([
      ensureDetectorInfo(signal),
      fetchText(TRAFFIC_SPEED_URL, signal),
    ]);
    if (!info.length) return null;
    const speeds = parseDetectorSpeedXml(xml);
    const index = new TrafficIndex(info, speeds);
    speedCache = { t: now, index };
    console.info(
      "[buspos] traffic index",
      index.detectors.length,
      "detectors,",
      speeds.size,
      "live speeds",
    );
    return index;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    console.warn("[buspos] traffic fetch failed, engine will coast", e?.message || e);
    return null;
  }
}

/** Clear caches (settings toggle / tests). */
export function resetTrafficCache() {
  infoCache = { t: 0, rows: null };
  speedCache = { t: 0, index: null };
}
