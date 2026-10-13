/**
 * MTR service status — per-line RYG state from MTR's own alert feed.
 *
 * Source: https://www.mtr.com.hk/alert/ryg_line_status_lite.xml, reached
 * through the /eta/mtr-alert/* proxy (COEP-safe, 15s edge cache). Every line
 * is listed on every response — "green" simply means normal service — so the
 * disruption banner and the route-detail red stroke both key off
 * `status !== "green"`.
 *
 * CJK titles arrive inside CDATA as numeric entities (&#35264;), which the
 * XML parser hands back verbatim; decodeEntities() is what makes them readable.
 */

const STATUS_URL = "/eta/mtr-alert/ryg_line_status_lite.xml";
const REFRESH_MS = 3 * 60_000;

/** @typedef {{ id: string, titleEn: string, titleTc: string }} MtrAlertMessage */
/** @typedef {{ code: string, status: string, nameEn: string, nameTc: string, color: string, messages: MtrAlertMessage[] }} MtrLineStatus */

/** @type {Record<string, MtrLineStatus>} */
let lines = {};
let lastBuildDate = "";
let lastLoadedAt = 0;
/** @type {Promise<void> | null} */
let inflight = null;
/** @type {Set<() => void>} */
const listeners = new Set();

/** Decode the entity forms MTR uses inside CDATA (numeric + the common named). */
function decodeEntities(text) {
  if (!text) return "";
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const n = Number(dec);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** First matching element's decoded text, trimmed. */
function childText(el, tag) {
  const node = el.getElementsByTagName(tag)[0];
  return decodeEntities(node?.textContent || "").trim();
}

/**
 * Parse the RYG status XML into a line-code keyed map.
 * @param {string} xmlText
 * @returns {{ lines: Record<string, MtrLineStatus>, lastBuildDate: string } | null}
 */
export function parseMtrStatusXml(xmlText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(xmlText || ""), "text/xml");
  } catch {
    return null;
  }
  if (!doc || doc.getElementsByTagName("parsererror").length) return null;

  /** @type {Record<string, MtrLineStatus>} */
  const out = {};
  for (const el of doc.getElementsByTagName("line")) {
    const code = childText(el, "line_code").toUpperCase();
    if (!code) continue;
    /** @type {MtrAlertMessage[]} */
    const messages = [];
    for (const m of el.getElementsByTagName("message")) {
      const titleEn = childText(m, "title_en");
      const titleTc = childText(m, "title_tc");
      if (!titleEn && !titleTc) continue;
      messages.push({ id: childText(m, "id"), titleEn, titleTc });
    }
    out[code] = {
      code,
      status: (childText(el, "status") || "green").toLowerCase(),
      nameEn: childText(el, "line_name"),
      nameTc: childText(el, "line_name_tc"),
      color: childText(el, "line_color"),
      messages,
    };
  }
  if (!Object.keys(out).length) return null;
  const build = doc.getElementsByTagName("lastBuildDate")[0]?.textContent || "";
  return { lines: out, lastBuildDate: String(build).trim() };
}

/** Current snapshot (empty until the first successful load). */
export function getMtrServiceInfo() {
  return { lines, lastBuildDate, lastLoadedAt };
}

/** True when the feed lists the line and it is not running normally. */
export function isMtrLineDisrupted(code) {
  const hit = lines[String(code || "").trim().toUpperCase()];
  return !!hit && hit.status !== "green";
}

/** Disrupted lines, worst first (red before yellow, then feed order). */
export function disruptedMtrLines() {
  const rank = { red: 0, yellow: 1 };
  return Object.values(lines)
    .filter((l) => l.status !== "green")
    .sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));
}

/** Subscribe to status changes (fired after each successful refresh). */
export function onMtrStatusChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit() {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.warn("[mtr-status] listener", e);
    }
  }
}

/**
 * Fetch + parse the feed. Never rejects — offline or a blocked proxy keeps the
 * last good snapshot so the UI degrades to "no known disruption".
 */
export function refreshMtrStatus() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(STATUS_URL, {
        headers: { Accept: "application/xml" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseMtrStatusXml(await res.text());
      if (!parsed) throw new Error("unparsable status XML");
      lines = parsed.lines;
      lastBuildDate = parsed.lastBuildDate;
      lastLoadedAt = Date.now();
      emit();
    } catch (e) {
      console.warn("[mtr-status] refresh failed", e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Load on boot, then poll while the tab is visible and on each re-open. */
export function initMtrStatus() {
  void refreshMtrStatus();
  window.setInterval(() => {
    if (!document.hidden) void refreshMtrStatus();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshMtrStatus();
  });
}
