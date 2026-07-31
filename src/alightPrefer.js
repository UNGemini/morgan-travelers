/**
 * Prefer alighting at a bus stop whose name matches the destination.
 *
 * RAPTOR + walk-graph often alights early (e.g. Cable Car Terminal) and walks
 * to Tung Chung Station, even when the bus continues to MTR Station / Bus
 * Terminus / a bay on Mei Tung Street. We extend the ride to the best-matching
 * stop on the known pattern (or within the leg’s stop list).
 */

/**
 * @typedef {{
 *   stop_id: string,
 *   stop_name: string,
 *   lat: number,
 *   lon: number,
 *   offsetSec: number,
 * }} PatternStop
 */

/**
 * Tail patterns for NLB circulars/routes that approach Tung Chung Station.
 * Offsets are seconds from an arbitrary template start (only deltas matter).
 * Prefer the stop that best matches destination name + proximity — not always terminus.
 *
 * @type {Record<string, PatternStop[]>}
 */
const ROUTE_PATTERNS = {
  // 38: … Fire → Cable → MTR Station → …
  38: [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 195 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 307 },
    { stop_id: "NLB-105", stop_name: "Tung Chung MTR Station", lat: 22.289613, lon: 113.94021, offsetSec: 437 },
  ],
  N38: [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 195 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 307 },
    { stop_id: "NLB-105", stop_name: "Tung Chung MTR Station", lat: 22.289613, lon: 113.94021, offsetSec: 437 },
  ],
  // 37M: Cable → Station Bus Terminus
  "37M": [
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 1102 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 1342 },
  ],
  // 37A: Fire → Cable → Station Bus Terminus
  "37A": [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 758 },
    { stop_id: "NLB-321", stop_name: "Tung Chung Cable Car Terminal", lat: 22.288853, lon: 113.938462, offsetSec: 886 },
    { stop_id: "NLB-278", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 977 },
  ],
  // 37: Fire → Cable → Station Bus Terminus
  37: [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 400 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 520 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 640 },
  ],
  // 37H (second pass near station)
  "37H": [
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 400 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 520 },
  ],
  // 39M circular ends at terminus
  "39M": [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 400 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 520 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 640 },
  ],
  // Long-haul to terminus via cable
  "3M": [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 1800 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 1920 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 2040 },
  ],
  11: [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 1800 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 1920 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 2040 },
  ],
  "11A": [
    { stop_id: "NLB-77", stop_name: "Tung Chung Fire Station", lat: 22.28603, lon: 113.941057, offsetSec: 1800 },
    { stop_id: "NLB-78", stop_name: "Tung Chung Cable Car Terminal", lat: 22.289301, lon: 113.938733, offsetSec: 1920 },
    { stop_id: "NLB-79", stop_name: "Tung Chung Station Bus Terminus", lat: 22.289862, lon: 113.939616, offsetSec: 2040 },
  ],
};

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
 * @param {object} stop
 */
function stopName(stop) {
  return String(stop?.stop_name || stop?.name || stop?.address || "");
}

/**
 * @param {object} stop
 */
function stopLatLon(stop) {
  const lat = Number(stop?.location?.lat ?? stop?.lat);
  const lon = Number(stop?.location?.lon ?? stop?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Normalize for token matching.
 * @param {string} s
 */
export function normalizePlaceName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[()（）[\]【】,，.。/|·•\-–—]/g, " ")
    .replace(
      /\b(bus\s*terminus|terminus|station|mtr|stop|estate|house|road|street|path|plaza|court|tung|chung|hong|kong|the|and|of|at|to|via)\b/g,
      (m) => m,
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token set for name similarity (keeps important place words).
 * @param {string} s
 */
function nameTokens(s) {
  const n = normalizePlaceName(s);
  /** @type {Set<string>} */
  const out = new Set();
  for (const t of n.split(" ")) {
    if (t.length < 2) continue;
    // drop pure noise
    if (
      /^(bound|north|south|east|west|phase|main|block|outside|opp|opposite)$/.test(
        t,
      )
    ) {
      continue;
    }
    out.add(t);
  }
  // CJK runs as whole chunks
  const zh = String(s || "").match(/[\u4e00-\u9fff]{2,}/g);
  if (zh) for (const z of zh) out.add(z);
  return out;
}

/**
 * Higher = better name match to destination.
 * Heavily rewards shared distinctive tokens; penalizes cable-car when dest is station.
 *
 * @param {string} destLabel
 * @param {string} stopNm
 * @returns {number} 0–100
 */
export function stopNameMatchScore(destLabel, stopNm) {
  const dest = String(destLabel || "").trim();
  const stop = String(stopNm || "").trim();
  if (!dest || !stop) return 0;

  const dLow = dest.toLowerCase();
  const sLow = stop.toLowerCase();

  // Exact / containment
  if (dLow === sLow) return 100;
  if (sLow.includes(dLow) || dLow.includes(sLow)) return 92;

  const dt = nameTokens(dest);
  const st = nameTokens(stop);
  if (!dt.size || !st.size) return 0;

  let hit = 0;
  for (const t of dt) if (st.has(t)) hit++;
  const recall = hit / dt.size;
  const precision = hit / st.size;
  let score = Math.round(100 * (0.65 * recall + 0.35 * precision));

  // Destination looks like a rail / bus station (not “Fire Station”)
  const destIsFire = /fire\s*station|消防/i.test(dest);
  const destIsStation =
    !destIsFire &&
    (/\bterminus\b|總站|巴士總站|\bmtr\b|港鐵/i.test(dest) ||
      /\bstation\b/i.test(dest) ||
      /東涌站|站\s*$/u.test(dest));
  const stopIsCable = /cable\s*car|纜車/i.test(stop);
  const stopIsFire = /fire\s*station|消防/i.test(stop);
  const stopIsRailOrBusStation =
    !stopIsFire &&
    !stopIsCable &&
    (/\bmtr\b|港鐵|terminus|總站|巴士總站/i.test(stop) ||
      /tung\s*chung\s+station|東涌站/i.test(stop) ||
      (/\bstation\b/i.test(stop) && !/fire\s*station/i.test(stop)));

  if (destIsStation && stopIsRailOrBusStation) score += 28;
  if (destIsStation && stopIsCable) score -= 45;
  if (destIsStation && stopIsFire) score -= 35;
  // Dest is cable car → prefer cable
  if (/cable\s*car|纜車/i.test(dest) && stopIsCable) score += 40;
  if (/cable\s*car|纜車/i.test(dest) && stopIsRailOrBusStation) score -= 15;

  // Shared “tung chung” + station-like
  if (dt.has("tung") && dt.has("chung") && st.has("tung") && st.has("chung")) {
    score += 10;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Combined score: name match primary, distance secondary.
 * @param {string} destLabel
 * @param {string} stopNm
 * @param {number} distM
 */
function alightCandidateScore(destLabel, stopNm, distM) {
  const nameSc = stopNameMatchScore(destLabel, stopNm);
  // Within 400 m: small bonus for being closer (up to +20)
  const distSc =
    Number.isFinite(distM) && distM < 800
      ? Math.max(0, 20 - distM / 40)
      : distM < 1200
        ? 5
        : 0;
  return nameSc * 10 + distSc;
}

/**
 * @param {object} [opt]
 */
function routeKey(opt) {
  return String(opt?.route_short_name || "")
    .trim()
    .toUpperCase()
    .replace(/^NLB[-\s]*/, "");
}

/**
 * @param {object} [opt]
 */
function isBusOption(opt) {
  const mode = String(opt?.mode || "").toLowerCase();
  if (mode === "bus" || mode === "trolleybus") return true;
  const blob = `${opt?.agency?.id || ""} ${opt?.agency?.name || ""}`.toLowerCase();
  return /kmb|ctb|nlb|lwb|gmb|citybus|bus/.test(blob);
}

/**
 * Pattern stops at/after the current alight (same stop or later on route).
 * @param {string} route
 * @param {string} alightName
 * @param {{ lat?: number, lon?: number } | null} alightLL
 * @returns {PatternStop[]}
 */
function patternStopsFromAlight(route, alightName, alightLL) {
  const pat = ROUTE_PATTERNS[route] || ROUTE_PATTERNS[route.replace(/^0+/, "")];
  if (!pat?.length) return [];

  let startIdx = -1;
  const aLow = String(alightName || "").toLowerCase();
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    const pLow = p.stop_name.toLowerCase();
    if (
      pLow === aLow ||
      pLow.includes(aLow.slice(0, 12)) ||
      aLow.includes(pLow.slice(0, 12))
    ) {
      startIdx = i;
      break;
    }
    if (alightLL && Number.isFinite(alightLL.lat)) {
      const d = haversineM(alightLL.lat, alightLL.lon, p.lat, p.lon);
      if (d < 60) {
        startIdx = i;
        break;
      }
    }
  }
  // If current alight not on pattern, still offer full pattern tail near station
  if (startIdx < 0) {
    // only if alight looks like approach
    if (/cable|fire|消防|纜車/i.test(alightName || "")) {
      startIdx = 0;
    } else {
      return [];
    }
  }
  return pat.slice(startIdx);
}

/**
 * Build stop object for plan.
 * @param {PatternStop} p
 * @param {number} offsetMin
 */
function patternToStop(p, offsetMin) {
  return {
    stop_id: p.stop_id,
    id: p.stop_id,
    stop_name: p.stop_name,
    name: p.stop_name,
    address: p.stop_name,
    location: { lat: p.lat, lon: p.lon },
    lat: p.lat,
    lon: p.lon,
    departure_offset_minutes: offsetMin,
    arrival_offset_minutes: offsetMin,
  };
}

/**
 * Prefer alight stop with name similar to destination (and nearby).
 *
 * @param {object} plan
 * @param {number} destLat
 * @param {number} destLon
 * @param {{ destIsStation?: boolean, destLabel?: string }} [opts]
 * @returns {object}
 */
export function preferNameMatchedAlight(plan, destLat, destLon, opts = {}) {
  if (!plan?.legs?.length) return plan;
  if (!Number.isFinite(destLat) || !Number.isFinite(destLon)) return plan;

  const destLabel = String(opts.destLabel || "").trim();
  // Need a destination name or station flag to prefer name-matched alights
  if (!destLabel && !opts.destIsStation) return plan;

  const labelForMatch =
    destLabel ||
    (opts.destIsStation ? "Tung Chung Station" : "");

  let changed = false;
  let durationDelta = 0;
  /** @type {object[]} */
  const legs = plan.legs.map((leg) => ({ ...leg }));

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.type !== "transit" || !leg.route_options?.[0]) continue;
    if (!isBusOption(leg.route_options[0])) continue;

    // Only last transit before destination
    let lastTransit = true;
    for (let j = i + 1; j < legs.length; j++) {
      if (legs[j].type === "transit") {
        lastTransit = false;
        break;
      }
    }
    if (!lastTransit) continue;

    const opt = leg.route_options[0];
    const alight =
      opt.to || (opt.stops?.length ? opt.stops[opt.stops.length - 1] : null);
    if (!alight) continue;

    const alightNm = stopName(alight);
    const alightLL = stopLatLon(alight);
    const alightDist = alightLL
      ? haversineM(alightLL.lat, alightLL.lon, destLat, destLon)
      : 9999;
    const alightNameSc = stopNameMatchScore(labelForMatch, alightNm);
    const alightScore = alightCandidateScore(labelForMatch, alightNm, alightDist);

    // Candidates: later pattern stops + existing stops on the leg
    /** @type {Array<{ stop: object, distM: number, nameSc: number, score: number, offsetSec?: number, fromPattern: boolean }>} */
    const candidates = [];

    const rkey = routeKey(opt);
    const patternTail = patternStopsFromAlight(rkey, alightNm, alightLL);
    const alightOffsetOnPat = patternTail[0]?.offsetSec ?? 0;

    for (const p of patternTail) {
      const distM = haversineM(p.lat, p.lon, destLat, destLon);
      // Only consider stops near the destination (not far past it)
      if (distM > 700) continue;
      const nameSc = stopNameMatchScore(labelForMatch, p.stop_name);
      const score = alightCandidateScore(labelForMatch, p.stop_name, distM);
      candidates.push({
        stop: patternToStop(
          p,
          Math.round((p.offsetSec - alightOffsetOnPat) / 60),
        ),
        distM,
        nameSc,
        score,
        offsetSec: p.offsetSec - alightOffsetOnPat,
        fromPattern: true,
      });
    }

    // Also score stops already in the leg
    for (const s of opt.stops || []) {
      const ll = stopLatLon(s);
      if (!ll) continue;
      const distM = haversineM(ll.lat, ll.lon, destLat, destLon);
      if (distM > 700) continue;
      const nameSc = stopNameMatchScore(labelForMatch, stopName(s));
      const score = alightCandidateScore(labelForMatch, stopName(s), distM);
      candidates.push({
        stop: s,
        distM,
        nameSc,
        score,
        fromPattern: false,
      });
    }

    if (!candidates.length) continue;

    candidates.sort((a, b) => b.score - a.score || a.distM - b.distM);
    const best = candidates[0];

    // Clear improvement over current RAPTOR alight
    const nameWin = best.nameSc >= alightNameSc + 12;
    const closeWin =
      best.nameSc >= alightNameSc - 5 && best.distM + 80 < alightDist;
    const scoreWin = best.score >= alightScore + 40;
    const mustWin =
      nameWin ||
      closeWin ||
      scoreWin ||
      (best.nameSc >= 50 && best.distM < alightDist - 40);

    if (!mustWin) continue;

    // Same stop already?
    const bestNm = stopName(best.stop);
    if (
      bestNm.toLowerCase() === alightNm.toLowerCase() &&
      best.distM >= alightDist - 30
    ) {
      continue;
    }

    // Extend stop list to include chosen alight
    const stops = Array.isArray(opt.stops) ? [...opt.stops] : [];
    const lastOff = Number(
      stops[stops.length - 1]?.departure_offset_minutes ??
        stops[stops.length - 1]?.arrival_offset_minutes ??
        0,
    );
    const extraSec =
      best.offsetSec != null && best.offsetSec > 0
        ? best.offsetSec
        : Math.max(60, Math.round((alightDist - best.distM) / 1.2));

    // If best is already in stops as last, just update `to`
    let newStops = stops;
    const alreadyLast =
      stops.length &&
      stopName(stops[stops.length - 1]).toLowerCase() === bestNm.toLowerCase();
    if (!alreadyLast) {
      const addMin = Math.max(1, Math.round(extraSec / 60));
      newStops = [
        ...stops,
        {
          ...best.stop,
          departure_offset_minutes: lastOff + addMin,
          arrival_offset_minutes: lastOff + addMin,
        },
      ];
    }

    const newOpt = {
      ...opt,
      to: { ...best.stop },
      stops: newStops,
    };
    const newDuration = (leg.duration_seconds || 0) + (alreadyLast ? 0 : extraSec);
    durationDelta += alreadyLast ? 0 : extraSec;
    legs[i] = {
      ...leg,
      duration_seconds: newDuration,
      route_options: [newOpt, ...(leg.route_options || []).slice(1)],
    };
    changed = true;

    // Fix egress walk after this leg
    const next = legs[i + 1];
    if (next?.type === "walk") {
      const wtype = String(next.walk_type || "").toLowerCase();
      const isEgress =
        i + 1 === legs.length - 1 ||
        wtype === "egress" ||
        wtype === "station_egress";
      if (isEgress) {
        const bll = stopLatLon(best.stop);
        const destWalk = bll
          ? Math.round(haversineM(bll.lat, bll.lon, destLat, destLon))
          : 40;
        if (destWalk <= 100) {
          durationDelta -= next.duration_seconds || 0;
          legs.splice(i + 1, 1);
        } else {
          const oldSec = next.duration_seconds || 0;
          const newSec = Math.max(30, Math.round(destWalk / 1.25));
          durationDelta += newSec - oldSec;
          legs[i + 1] = {
            ...next,
            distance_meters: destWalk,
            duration_seconds: newSec,
            from: {
              stop_name: stopName(best.stop),
              location: bll
                ? { lat: bll.lat, lon: bll.lon }
                : next.from?.location,
            },
            walk_type: next.walk_type || "egress",
          };
        }
      }
    }
  }

  if (!changed) return plan;

  return {
    ...plan,
    legs,
    duration_seconds: Math.max(
      60,
      (plan.duration_seconds || 0) + durationDelta,
    ),
    name_matched_alight: true,
  };
}

/**
 * @param {object[]} plans
 * @param {number} destLat
 * @param {number} destLon
 * @param {{ destIsStation?: boolean, destLabel?: string }} [opts]
 */
export function preferNameMatchedAlights(plans, destLat, destLon, opts = {}) {
  if (!plans?.length) return plans || [];
  return plans.map((p) => preferNameMatchedAlight(p, destLat, destLon, opts));
}

// Back-compat aliases used by router
export const preferTungChungStationAlight = preferNameMatchedAlight;
export const preferTungChungStationAlights = preferNameMatchedAlights;

export function isNearTungChungStation(lat, lon, radiusM = 320) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return haversineM(lat, lon, 22.28955, 113.94035) <= radiusM;
}
