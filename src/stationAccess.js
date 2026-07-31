/**
 * Dual-access MTR station complexes (Central ↔ Hong Kong, TST ↔ East TST).
 *
 * When the user starts at Central, we also plan from Hong Kong (TCL/AEL), then
 * stitch an explicit indoor free-interchange walk onto those plans so results
 * never look like “start at Hong Kong” or “walk to Central from Hong Kong”.
 */

import { MTR_STATIONS } from "./mtrStations.js";

/**
 * @typedef {{ lat: number, lon: number, name?: string, code?: string }} AccessPoint
 */

/**
 * Station codes that share dual boarding options.
 * freeLink: official free paid-area walk (CEN↔HOK, TST↔ETS).
 * AWE↔AIR is NOT free — wheels graph orphans AEL at AsiaWorld-Expo, so we
 * also plan via Airport and stitch an outdoor access walk.
 */
const COMPLEXES = [
  {
    id: "cen_hok",
    codes: ["CEN", "HOK"],
    labelRe:
      /\bcentral\b|中環|\bhong\s*kong\b(?!\s*university)|香港站|香港\s*station/i,
    radiusM: 480,
    /** Indoor paid-area (IFC / Central–HK Station walkway) */
    indoor: true,
    freeLink: true,
  },
  {
    id: "tst_ets",
    codes: ["TST", "ETS"],
    labelRe: /tsim\s*sha\s*tsui|尖沙咀|尖東|east\s*tsim/i,
    radiusM: 420,
    indoor: false,
    freeLink: true,
  },
  {
    // AEL AsiaWorld-Expo stop is in GTFS names but not walk-reachable in the
    // RAPTOR graph — plan via Airport and stitch access so city↔AWE still gets AEL.
    id: "air_awe",
    codes: ["AIR", "AWE"],
    labelRe: /\bairport\b|機場|\basia\s*world|\bawe\b|博覽/i,
    radiusM: 1100,
    indoor: false,
    freeLink: false,
  },
];

/** Max distance (m) to use a nearby MTR station as alternate access/egress. */
const NEARBY_MTR_ACCESS_M = 520;

/**
 * Nearest MTR station within maxM, or null.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxM]
 * @returns {(typeof MTR_STATIONS)[0] & { distM: number } | null}
 */
export function nearestMtrStation(lat, lon, maxM = NEARBY_MTR_ACCESS_M) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  let bestD = Infinity;
  for (const st of MTR_STATIONS) {
    const d = haversineM(lat, lon, st.lat, st.lon);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  if (!best || bestD > maxM) return null;
  return { ...best, distM: bestD };
}

/**
 * Expand a single OD pin into boarding/alighting options.
 * First entry is always the user's original pin.
 *
 * Also adds:
 *  - Dual-access complexes (CEN↔HOK, TST↔ETS, AIR↔AWE)
 *  - Nearest MTR within ~520 m (hotels/POIs often sit in walk-graph holes;
 *    planning via the station then stitching a short walk fixes empty results)
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} [label]
 * @param {boolean} [isMtr]
 * @returns {AccessPoint[]}
 */
export function expandAccessPoints(lat, lon, label = "", isMtr = false) {
  /** @type {AccessPoint[]} */
  const out = [{ lat, lon, name: label || "origin" }];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return out;

  const labelHit = String(label || "");

  for (const complex of COMPLEXES) {
    const members = complex.codes
      .map((code) => MTR_STATIONS.find((s) => s.code === code))
      .filter(Boolean);
    if (members.length < 2) continue;

    const nearAny = members.some(
      (s) => haversineM(lat, lon, s.lat, s.lon) <= complex.radiusM,
    );
    const labelMatch = complex.labelRe.test(labelHit);
    if (!nearAny && !(isMtr && labelMatch)) continue;

    for (const s of members) {
      if (out.some((p) => haversineM(p.lat, p.lon, s.lat, s.lon) < 60)) continue;
      out.push({
        lat: s.lat,
        lon: s.lon,
        name: s.name_en,
        code: s.code,
        freeLink: !!complex.freeLink,
        indoor: !!complex.indoor,
        complexId: complex.id,
      });
    }
  }

  // Nearby MTR for POIs / hotels in walk-graph holes (e.g. 東隅 EAST near Tai Koo)
  const near = nearestMtrStation(lat, lon, NEARBY_MTR_ACCESS_M);
  if (near && !out.some((p) => haversineM(p.lat, p.lon, near.lat, near.lon) < 60)) {
    out.push({
      lat: near.lat,
      lon: near.lon,
      name: near.name_en,
      code: near.code,
      freeLink: false,
      indoor: false,
      nearbyStation: true,
      accessWalkM: Math.round(near.distM),
    });
  }

  return out;
}

/**
 * If a plan was computed from a sibling station (e.g. Hong Kong) while the
 * user is at the primary pin (Central), prepend/append free-link walks so the
 * itinerary is relative to the user's actual OD.
 *
 * @param {object} plan  RAPTOR plan
 * @param {AccessPoint} primaryOrigin  user's origin (first expandAccessPoints entry)
 * @param {AccessPoint} usedOrigin     pin used for this plan
 * @param {AccessPoint} primaryDest
 * @param {AccessPoint} usedDest
 * @returns {object}
 */
export function stitchDualAccessPlan(
  plan,
  primaryOrigin,
  usedOrigin,
  primaryDest,
  usedDest,
) {
  if (!plan?.legs?.length) return plan;

  let legs = [...plan.legs];
  let extraSec = 0;
  let extraM = 0;

  // ── Origin: user at primary, plan started at sibling / nearby MTR ────────
  if (
    usedOrigin &&
    primaryOrigin &&
    !samePin(primaryOrigin, usedOrigin) &&
    shouldStitchAccess(primaryOrigin, usedOrigin)
  ) {
    const meta = pairMeta(primaryOrigin, usedOrigin);
    const link = makeLinkWalk(
      primaryOrigin,
      usedOrigin,
      displayName(primaryOrigin),
      displayName(usedOrigin),
      meta,
    );
    // Drop RAPTOR access walk at sibling (pin → platform). User already
    // arrives via the free link / access walk into the station.
    if (legs[0]?.type === "walk") {
      const accessM = legs[0].distance_meters ?? 9999;
      if (accessM < 700) {
        extraSec -= legs[0].duration_seconds || Math.round(accessM / 1.2);
        extraM -= accessM;
        legs = legs.slice(1);
      }
    }
    legs = [link, ...legs];
    extraSec += link.duration_seconds;
    extraM += link.distance_meters;
  }

  // ── Destination: plan ended at sibling / nearby MTR, user wants primary ──
  if (
    usedDest &&
    primaryDest &&
    !samePin(primaryDest, usedDest) &&
    shouldStitchAccess(primaryDest, usedDest)
  ) {
    const meta = pairMeta(primaryDest, usedDest);
    const link = makeLinkWalk(
      usedDest,
      primaryDest,
      displayName(usedDest),
      displayName(primaryDest),
      meta,
    );
    const last = legs[legs.length - 1];
    if (last?.type === "walk") {
      const egressM = last.distance_meters ?? 9999;
      if (egressM < 700) {
        extraSec -= last.duration_seconds || Math.round(egressM / 1.2);
        extraM -= egressM;
        legs = legs.slice(0, -1);
      }
    }
    legs = [...legs, link];
    extraSec += link.duration_seconds;
    extraM += link.distance_meters;
  }

  if (extraSec === 0) return plan;

  return {
    ...plan,
    duration_seconds: (plan.duration_seconds || 0) + extraSec,
    legs,
    dual_access_stitched: true,
  };
}

/**
 * @param {AccessPoint} a
 * @param {AccessPoint} b
 */
function samePin(a, b) {
  if (!a || !b) return true;
  if (a.code && b.code && a.code === b.code) return true;
  return haversineM(a.lat, a.lon, b.lat, b.lon) < 60;
}

/**
 * True if we should stitch a walk between the user's pin and the pin RAPTOR used.
 * Covers dual-access complexes and nearby-MTR POI access.
 * @param {AccessPoint} a
 * @param {AccessPoint} b
 */
function shouldStitchAccess(a, b) {
  if (!a || !b || samePin(a, b)) return false;
  // Explicit nearby-station expansion (hotel / POI → nearest MTR)
  if (a.nearbyStation || b.nearbyStation) return true;
  if (a.code && !b.code && haversineM(a.lat, a.lon, b.lat, b.lon) <= NEARBY_MTR_ACCESS_M) {
    return true;
  }
  if (b.code && !a.code && haversineM(a.lat, a.lon, b.lat, b.lon) <= NEARBY_MTR_ACCESS_M) {
    return true;
  }
  return isPairedAccess(a, b);
}

/**
 * True if both points are members of the same dual-access complex.
 * @param {AccessPoint} a
 * @param {AccessPoint} b
 */
function isPairedAccess(a, b) {
  for (const complex of COMPLEXES) {
    const members = complex.codes
      .map((code) => MTR_STATIONS.find((s) => s.code === code))
      .filter(Boolean);
    if (members.length < 2) continue;
    const nearA = members.find(
      (s) =>
        (a.code && a.code === s.code) ||
        haversineM(a.lat, a.lon, s.lat, s.lon) < 80,
    );
    const nearB = members.find(
      (s) =>
        (b.code && b.code === s.code) ||
        haversineM(b.lat, b.lon, s.lat, s.lon) < 80,
    );
    if (nearA && nearB && nearA.code !== nearB.code) return true;
  }
  // Label-based fallback (codes missing on primary pin)
  const na = displayName(a).toLowerCase();
  const nb = displayName(b).toLowerCase();
  const cen = (s) => /\bcentral\b|中環/.test(s);
  const hok = (s) => /\bhong\s*kong\b|香港/.test(s) && !/university|大學/.test(s);
  if ((cen(na) && hok(nb)) || (hok(na) && cen(nb))) return true;
  const tst = (s) => /tsim\s*sha\s*tsui|尖沙咀/.test(s) && !/east|尖東/.test(s);
  const ets = (s) => /east\s*tsim|尖東/.test(s);
  if ((tst(na) && ets(nb)) || (ets(na) && tst(nb))) return true;
  const air = (s) => /\bairport\b|機場/.test(s) && !/expo|asia|博覽/.test(s);
  const awe = (s) => /asia\s*world|\bawe\b|博覽/.test(s);
  if ((air(na) && awe(nb)) || (awe(na) && air(nb))) return true;
  return false;
}

/**
 * @param {AccessPoint} a
 * @param {AccessPoint} b
 * @returns {{ freeLink: boolean, indoor: boolean, complexId?: string }}
 */
function pairMeta(a, b) {
  for (const complex of COMPLEXES) {
    const members = complex.codes
      .map((code) => MTR_STATIONS.find((s) => s.code === code))
      .filter(Boolean);
    if (members.length < 2) continue;
    const nearA = members.find(
      (s) =>
        (a.code && a.code === s.code) ||
        haversineM(a.lat, a.lon, s.lat, s.lon) < 100,
    );
    const nearB = members.find(
      (s) =>
        (b.code && b.code === s.code) ||
        haversineM(b.lat, b.lon, s.lat, s.lon) < 100,
    );
    if (nearA && nearB && nearA.code !== nearB.code) {
      return {
        freeLink: complex.freeLink !== false,
        indoor: !!complex.indoor,
        complexId: complex.id,
      };
    }
  }
  // Nearby MTR ↔ POI: outdoor paid walk (not free interchange)
  if (a.nearbyStation || b.nearbyStation || a.code || b.code) {
    return { freeLink: false, indoor: false };
  }
  return { freeLink: true, indoor: false };
}

/**
 * @param {AccessPoint} from
 * @param {AccessPoint} to
 * @param {string} fromName
 * @param {string} toName
 * @param {{ freeLink?: boolean, indoor?: boolean, complexId?: string }} [meta]
 */
function makeLinkWalk(from, to, fromName, toName, meta = {}) {
  const dist = Math.max(80, Math.round(haversineM(from.lat, from.lon, to.lat, to.lon)));
  const freeLink = meta.freeLink !== false;
  const indoor =
    meta.indoor === true ||
    (/\bcentral\b|中環/i.test(fromName) && /\bhong\s*kong\b|香港/i.test(toName)) ||
    (/\bhong\s*kong\b|香港/i.test(fromName) && /\bcentral\b|中環/i.test(toName));
  // Indoor corridor ~1.1 m/s; outdoor access ~1.25 m/s
  const pace = indoor ? 1.1 : 1.25;
  const duration = Math.max(freeLink ? 90 : 120, Math.round(dist / pace));

  return {
    type: "walk",
    walk_type: freeLink ? "station_transfer" : "station_access",
    distance_meters: dist,
    duration_seconds: duration,
    free_mtr_link: freeLink,
    indoor_interchange: freeLink && indoor,
    from: {
      stop_name: fromName,
      address: fromName,
      location: { lat: from.lat, lon: from.lon },
    },
    to: {
      stop_name: toName,
      address: toName,
      location: { lat: to.lat, lon: to.lon },
    },
    path: [
      { lat: from.lat, lon: from.lon },
      { lat: to.lat, lon: to.lon },
    ],
  };
}

/** @param {AccessPoint} p */
function displayName(p) {
  if (p?.name && !/^origin|destination$/i.test(p.name)) return p.name;
  if (p?.code) {
    const s = MTR_STATIONS.find((x) => x.code === p.code);
    if (s) return s.name_en;
  }
  // Nearest station name for anonymous pins
  let best = null;
  let bestD = Infinity;
  for (const s of MTR_STATIONS) {
    const d = haversineM(p.lat, p.lon, s.lat, s.lon);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best && bestD < 400) return best.name_en;
  return p?.name || "Station";
}

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
  return 2 * R * Math.asin(Math.sqrt(a));
}
