/**
 * Merge duplicate bus stops in a transit stop sequence.
 *
 * - KMB/LWB: public stop ids appear as e.g. "TC450" / "(TC450)" in names or
 *   stop_code — same id ⇒ same stop (merge).
 * - CTB / NLB: no shared public id in GTFS — merge when same name and nearby.
 * - Always merge exact same stop_id / consecutive near-identical pins.
 */

/**
 * @param {object} [stop]
 * @returns {string}
 */
export function stopRawId(stop) {
  return String(stop?.stop_id || stop?.id || "").trim();
}

/**
 * Operator prefix from id: KMB | CTB | NLB | LWB | …
 * @param {object} [stop]
 */
export function stopOperator(stop) {
  const id = stopRawId(stop).toUpperCase();
  const m = /^(KMB|LWB|CTB|NWFB|NLB|GMB|MTR)/.exec(id);
  if (m) return m[1] === "LWB" || m[1] === "KMB" ? "KMB" : m[1];
  return "";
}

/**
 * Public KMB-style stop code: TC450, WT916, …
 * @param {object | string | null | undefined} stopOrName
 * @returns {string} uppercase code or ""
 */
export function extractPublicStopCode(stopOrName) {
  if (stopOrName == null) return "";
  if (typeof stopOrName === "object") {
    const direct = String(
      stopOrName.stop_code ||
        stopOrName.public_id ||
        stopOrName.stopCode ||
        "",
    )
      .trim()
      .toUpperCase();
    if (/^[A-Z]{1,4}\d{2,5}[A-Z]?$/.test(direct)) return direct;

    const id = stopRawId(stopOrName);
    // Bare public id (no operator hash)
    if (/^[A-Z]{1,4}\d{2,5}[A-Z]?$/i.test(id)) return id.toUpperCase();
    // KMB-TC450 style
    const mId = /^(?:KMB|LWB)-([A-Z]{1,4}\d{2,5}[A-Z]?)$/i.exec(id);
    if (mId) return mId[1].toUpperCase();

    const name = String(
      stopOrName.stop_name ||
        stopOrName.name ||
        stopOrName.address ||
        "",
    );
    return extractPublicStopCode(name);
  }

  const s = String(stopOrName);
  // "(TC450)" / "(WT916)" at end of English names
  let m = /\(([A-Z]{1,4}\d{2,5}[A-Z]?)\)\s*$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /\b([A-Z]{1,4}\d{2,5}[A-Z]?)\s*$/i.exec(s.trim());
  if (m && !/^\d+$/.test(m[1])) return m[1].toUpperCase();
  return "";
}

/**
 * Normalize stop name for equality (strip codes, punctuation, operator noise).
 * @param {string} name
 */
export function normalizeStopName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/月台\s*\d+/g, " ")
    .replace(/platform\s*\d+/gi, " ")
    .replace(/[，,·•|/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {object} [stop]
 */
export function stopDisplayName(stop) {
  return String(
    stop?.stop_name || stop?.name || stop?.address || "",
  ).trim();
}

/**
 * @param {object} [stop]
 * @returns {{ lat: number, lon: number } | null}
 */
export function stopLatLon(stop) {
  if (!stop) return null;
  const lat = Number(stop.location?.lat ?? stop.lat);
  const lon = Number(stop.location?.lon ?? stop.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * @param {object} a
 * @param {object} b
 */
function distM(a, b) {
  const pa = stopLatLon(a);
  const pb = stopLatLon(b);
  if (!pa || !pb) return Infinity;
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(pb.lat - pa.lat);
  const dLon = toR(pb.lon - pa.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(pa.lat)) * Math.cos(toR(pb.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * True if two stops represent the same boarding place.
 * @param {object} a
 * @param {object} b
 * @param {{ nearbyM?: number }} [opts]
 */
export function stopsAreSamePlace(a, b, opts = {}) {
  if (!a || !b) return false;
  const nearbyM = opts.nearbyM ?? 90;

  const idA = stopRawId(a);
  const idB = stopRawId(b);
  if (idA && idB && idA === idB) return true;

  // KMB/LWB public codes (TC450, …)
  const codeA = extractPublicStopCode(a);
  const codeB = extractPublicStopCode(b);
  if (codeA && codeB && codeA === codeB) return true;

  const opA = stopOperator(a);
  const opB = stopOperator(b);
  const nameA = normalizeStopName(stopDisplayName(a));
  const nameB = normalizeStopName(stopDisplayName(b));
  const d = distM(a, b);

  // Same operator hash family + very close
  if (idA && idB && d <= 35) {
    // Different hash ids but on top of each other
    if (nameA && nameA === nameB) return true;
  }

  // CTB / NLB (and unknowns): same name + nearby
  const nameMergeOps = !opA || !opB || opA === "CTB" || opA === "NLB" || opA === "NWFB" ||
    opB === "CTB" || opB === "NLB" || opB === "NWFB" ||
    (opA === opB && opA !== "KMB");
  if (nameA && nameA === nameB && d <= nearbyM) {
    if (nameMergeOps || opA === "KMB" || opB === "KMB") return true;
  }

  // Cross-operator same bay (KMB hex + CTB numeric at same kerb)
  if (nameA && nameA === nameB && d <= 55) return true;
  if (d <= 25 && nameA && nameB) {
    // Near-identical pin even if names differ slightly
    if (
      nameA.includes(nameB) ||
      nameB.includes(nameA) ||
      tokenOverlap(nameA, nameB) >= 0.7
    ) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} a
 * @param {string} b
 */
function tokenOverlap(a, b) {
  const ta = new Set(a.split(" ").filter((t) => t.length > 2));
  const tb = new Set(b.split(" ").filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

/**
 * Merge consecutive duplicate stops; keep first occurrence’s coords/name,
 * prefer richer public code / earlier offset.
 *
 * @param {object[]} stops
 * @param {{ nearbyM?: number }} [opts]
 * @returns {object[]}
 */
export function mergeStopSequence(stops, opts = {}) {
  if (!Array.isArray(stops) || stops.length <= 1) return stops || [];

  /** @type {object[]} */
  const out = [];
  for (const s of stops) {
    if (!s) continue;
    const prev = out[out.length - 1];
    if (prev && stopsAreSamePlace(prev, s, opts)) {
      out[out.length - 1] = mergeStopRecords(prev, s);
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * Prefer public code, keep earliest departure offset, average coords if both present.
 * @param {object} a
 * @param {object} b
 */
function mergeStopRecords(a, b) {
  const code = extractPublicStopCode(a) || extractPublicStopCode(b);
  const nameA = stopDisplayName(a);
  const nameB = stopDisplayName(b);
  // Prefer longer/cleaner English name without duplicate codes
  let name = nameA.length >= nameB.length ? nameA : nameB;
  if (code && !new RegExp(`\\(${code}\\)`, "i").test(name)) {
    // keep name as-is; code stored separately if useful
  }
  const offA = Number(a.departure_offset_minutes ?? a.arrival_offset_minutes);
  const offB = Number(b.departure_offset_minutes ?? b.arrival_offset_minutes);
  const off =
    Number.isFinite(offA) && Number.isFinite(offB)
      ? Math.min(offA, offB)
      : Number.isFinite(offA)
        ? offA
        : offB;

  const pa = stopLatLon(a);
  const pb = stopLatLon(b);
  let location = a.location || (pa ? { lat: pa.lat, lon: pa.lon } : undefined);
  if (pa && pb) {
    location = {
      lat: (pa.lat + pb.lat) / 2,
      lon: (pa.lon + pb.lon) / 2,
    };
  }

  return {
    ...a,
    ...b,
    stop_name: name || a.stop_name || b.stop_name,
    name: name || a.name || b.name,
    stop_code: code || a.stop_code || b.stop_code,
    public_id: code || a.public_id || b.public_id,
    // Keep first stop_id for ETA stability (prefer CTB numeric / KMB hash that works)
    stop_id: a.stop_id || a.id || b.stop_id || b.id,
    id: a.id || a.stop_id || b.id || b.stop_id,
    location,
    lat: location?.lat ?? a.lat ?? b.lat,
    lon: location?.lon ?? a.lon ?? b.lon,
    departure_offset_minutes: Number.isFinite(off)
      ? off
      : a.departure_offset_minutes ?? b.departure_offset_minutes,
    arrival_offset_minutes: Number.isFinite(off)
      ? off
      : a.arrival_offset_minutes ?? b.arrival_offset_minutes,
    _merged: true,
  };
}

/**
 * Label for UI: "Tung Chung Station (TC450)" when public code known.
 * @param {object} [stop]
 * @param {string} [baseName] already cleaned name
 */
export function stopLabelWithPublicId(stop, baseName) {
  const base = String(baseName || stopDisplayName(stop) || "").trim();
  const code = extractPublicStopCode(stop);
  if (!code) return base;
  if (new RegExp(`\\(${code}\\)`, "i").test(base)) return base;
  if (!base) return code;
  return `${base.replace(/\s*\([A-Z]{1,4}\d{2,5}[A-Z]?\)\s*$/i, "").trim()} (${code})`;
}
