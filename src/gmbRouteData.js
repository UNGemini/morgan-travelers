/**
 * Green Minibus (GMB) routes & stops via data.etagmb.gov.hk
 * (proxied same-origin as /eta/gmb/*).
 *
 * APIs:
 *  GET /eta/gmb/route/                         — all region route codes
 *  GET /eta/gmb/route/{HKI|KLN|NT}/{code}      — variants + directions
 *  GET /eta/gmb/route-stop/{route_id}/{seq}    — ordered stops
 *  GET /eta/gmb/stop/{stop_id}                 — WGS84 coordinates
 */

/** @typedef {{ region: string, routeId: number, code: string, dest: string, destZh: string, orig: string, origZh: string, routeSeq: number }} GmbDirSlot */

/** @type {Record<string, string[]> | null} region → route codes */
let gmbCodesByRegion = null;
/** @type {Promise<void> | null} */
let gmbCodesPromise = null;

/** route code upper → GmbDirSlot[] (both directions / regions) */
/** @type {Map<string, GmbDirSlot[]>} */
const gmbDirsByCode = new Map();
/** @type {Map<string, Promise<GmbDirSlot[]>>} */
const gmbDirsLoad = new Map();

/** `${routeId}|${routeSeq}` → stops */
/** @type {Map<string, Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>>} */
const gmbStopSeqCache = new Map();

/**
 * @param {string} path e.g. "/route/" or "/route/NT/44A"
 */
async function gmbFetchJson(path) {
  const url = `/eta/gmb${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GMB ${path} ${res.status}`);
  return res.json();
}

/** Load region → route code lists once. */
export async function ensureGmbRouteCodes() {
  if (gmbCodesByRegion) return gmbCodesByRegion;
  if (gmbCodesPromise) {
    await gmbCodesPromise;
    return gmbCodesByRegion;
  }
  gmbCodesPromise = (async () => {
    try {
      const j = await gmbFetchJson("/route/");
      gmbCodesByRegion = j?.data?.routes || {};
      const n = Object.values(gmbCodesByRegion).reduce(
        (s, a) => s + (Array.isArray(a) ? a.length : 0),
        0,
      );
      console.info("[eta] GMB route codes", n);
    } catch (e) {
      console.warn("[eta] GMB route list", e);
      gmbCodesByRegion = {};
    } finally {
      gmbCodesPromise = null;
    }
  })();
  await gmbCodesPromise;
  return gmbCodesByRegion;
}

/**
 * Resolve region(s) that publish this route code.
 * @param {string} code
 * @returns {Promise<string[]>}
 */
async function gmbRegionsForCode(code) {
  const want = String(code || "").trim().toUpperCase();
  const byRegion = await ensureGmbRouteCodes();
  /** @type {string[]} */
  const out = [];
  for (const region of ["HKI", "KLN", "NT"]) {
    const codes = byRegion[region] || [];
    if (codes.some((c) => String(c).toUpperCase() === want)) out.push(region);
  }
  return out;
}

/**
 * Load direction slots for a public GMB route code (e.g. "44A", "1").
 * @param {string} routeCode
 * @returns {Promise<GmbDirSlot[]>}
 */
export async function ensureGmbRouteDirections(routeCode) {
  const code = String(routeCode || "").trim().toUpperCase();
  if (!code) return [];
  if (gmbDirsByCode.has(code)) return gmbDirsByCode.get(code) || [];
  if (gmbDirsLoad.has(code)) return gmbDirsLoad.get(code);

  const p = (async () => {
    /** @type {GmbDirSlot[]} */
    const slots = [];
    try {
      const regions = await gmbRegionsForCode(code);
      const tryRegions = regions.length ? regions : ["HKI", "KLN", "NT"];
      for (const region of tryRegions) {
        try {
          const detail = await gmbFetchJson(
            `/route/${region}/${encodeURIComponent(code)}`,
          );
          const entries = Array.isArray(detail?.data) ? detail.data : [];
          for (const e of entries) {
            const routeId = Number(e.route_id);
            if (!Number.isFinite(routeId)) continue;
            const dirs = Array.isArray(e.directions) ? e.directions : [];
            for (const d of dirs) {
              const routeSeq = Number(d.route_seq) || 1;
              slots.push({
                region,
                routeId,
                code,
                routeSeq,
                dest: String(d.dest_en || d.dest_tc || "").trim(),
                destZh: String(d.dest_tc || "").trim(),
                orig: String(d.orig_en || d.orig_tc || "").trim(),
                origZh: String(d.orig_tc || "").trim(),
              });
            }
            // Variant with no directions array — still usable for stop fetch
            if (!dirs.length) {
              slots.push({
                region,
                routeId,
                code,
                routeSeq: 1,
                dest: "",
                destZh: "",
                orig: "",
                origZh: "",
              });
            }
          }
          if (slots.length) break;
        } catch {
          /* try next region */
        }
      }
    } catch (e) {
      console.warn("[eta] GMB directions", code, e);
    }
    // Prefer Normal Route first, unique by routeSeq when possible
    const bySeq = new Map();
    for (const s of slots) {
      const k = String(s.routeSeq);
      if (!bySeq.has(k)) bySeq.set(k, s);
    }
    const ordered = [...bySeq.values()].sort(
      (a, b) => a.routeSeq - b.routeSeq,
    );
    gmbDirsByCode.set(code, ordered);
    return ordered;
  })();

  gmbDirsLoad.set(code, p);
  try {
    return await p;
  } finally {
    gmbDirsLoad.delete(code);
  }
}

/**
 * OD labels for Opposite / cards (bound O = route_seq 1, I = 2).
 * @param {string} routeCode
 * @returns {Array<{ dest: string, destZh?: string, bound: string, orig?: string, routeId?: string, routeSeq?: number }>}
 */
export function gmbRouteDirectionsSync(routeCode) {
  const code = String(routeCode || "").trim().toUpperCase();
  const slots = gmbDirsByCode.get(code) || [];
  if (!slots.length) return [];
  return slots.map((s) => ({
    dest: s.dest || s.destZh || "—",
    destZh: s.destZh || "",
    bound: s.routeSeq === 2 ? "I" : "O",
    orig: s.orig || s.origZh || "",
    routeId: String(s.routeId),
    routeSeq: s.routeSeq,
  }));
}

/**
 * @param {string} routeCode
 * @param {string} [bound] O|I|1|2
 * @returns {Promise<Array<{ seq: number, name: string, nameEn: string, nameTc: string, stopId: string, lon: number, lat: number }>>}
 */
export async function loadGmbStopSequence(routeCode, bound = "O") {
  const code = String(routeCode || "").trim().toUpperCase();
  if (!code) return [];
  const b = String(bound || "O").toUpperCase();
  const routeSeq =
    b === "I" || b === "2" || b === "INBOUND" || b === "DOWN" ? 2 : 1;

  const dirs = await ensureGmbRouteDirections(code);
  let slot =
    dirs.find((s) => Number(s.routeSeq) === routeSeq) ||
    dirs[0] ||
    null;
  if (!slot?.routeId) return [];

  const cacheKey = `${slot.routeId}|${slot.routeSeq}`;
  if (gmbStopSeqCache.has(cacheKey)) {
    return gmbStopSeqCache.get(cacheKey) || [];
  }

  try {
    const stopData = await gmbFetchJson(
      `/route-stop/${slot.routeId}/${slot.routeSeq}`,
    );
    const raw = stopData?.data?.route_stops || stopData?.data || [];
    if (!Array.isArray(raw) || !raw.length) {
      gmbStopSeqCache.set(cacheKey, []);
      return [];
    }

    const details = await Promise.all(
      raw.map(async (s, i) => {
        const sid = String(s.stop_id ?? s.stopId ?? "");
        const nameEn = String(s.name_en || "").trim();
        const nameTc = String(s.name_tc || s.name_sc || "").trim();
        const name = nameTc || nameEn || sid;
        let lon = NaN;
        let lat = NaN;
        if (sid) {
          try {
            const d = await gmbFetchJson(`/stop/${encodeURIComponent(sid)}`);
            const wgs = d?.data?.coordinates?.wgs84;
            lat = Number(wgs?.latitude);
            lon = Number(wgs?.longitude);
          } catch {
            /* coords optional for list */
          }
        }
        return {
          seq: Number(s.stop_seq ?? s.seq) || i + 1,
          name,
          nameEn,
          nameTc,
          stopId: sid,
          lon,
          lat,
          // For live ETA: /eta/route-stop/{route_id}/{route_seq}/{stop_seq}
          gmbRouteId: String(slot.routeId),
          gmbRouteSeq: slot.routeSeq,
        };
      }),
    );

    const stops = details
      .filter(Boolean)
      .sort((a, b) => a.seq - b.seq);
    gmbStopSeqCache.set(cacheKey, stops);
    return stops;
  } catch (e) {
    console.warn("[eta] GMB stops", code, e);
    gmbStopSeqCache.set(cacheKey, []);
    return [];
  }
}
