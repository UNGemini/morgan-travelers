/**
 * Language / i18n core.
 *
 * Dictionaries are keyed by the English source text (no key codes): English is
 * the default and needs no dictionary — t(key) falls back to the key itself.
 * Static DOM text is translated by applyLangToDom() (text-node + attribute
 * scan, exact full-node matches only), dynamic strings via t() at render time.
 *
 * Station/stop names follow the language's stationMode:
 *   en  (en / ja / ko) → English name
 *   hant (zh-hk / zh-tw) → Traditional Chinese (existing name_zh / name_tc)
 *   hans (zh-cn) → Simplified Chinese (auto-converted via the bundled char map)
 */
import { loadLanguagePref, saveLanguagePref } from "./preferences.js";
import { zhHk } from "./i18n/zh-hk.js";
import { zhTw } from "./i18n/zh-tw.js";
import { zhCn } from "./i18n/zh-cn.js";
import { ja } from "./i18n/ja.js";
import { ko } from "./i18n/ko.js";

/** @type {Record<string, { label: string, stationMode: "en"|"hant"|"hans" }>} */
export const LANG_META = {
  en: { label: "English", stationMode: "en" },
  "zh-hk": { label: "廣東話", stationMode: "hant" },
  "zh-tw": { label: "繁體中文", stationMode: "hant" },
  "zh-cn": { label: "简体中文", stationMode: "hans" },
  ja: { label: "日本語", stationMode: "en" },
  ko: { label: "한국어", stationMode: "en" },
};

const DICTS = { "zh-hk": zhHk, "zh-tw": zhTw, "zh-cn": zhCn, ja, ko };

let lang = "en";
/** @type {Set<(code: string) => void>} */
const langCallbacks = new Set();

/**
 * English-source tracking for re-translation: once a node is translated the
 * English source is gone from the DOM, so the next applyLangToDom() pass
 * (e.g. language switch) would find nothing to match. Record the source key
 * here; stale entries self-heal — a node rewritten by a re-render no longer
 * matches its recorded output and is re-derived from its current text.
 * Maps: textNode → { src, out }, element → attrName → { src, out }.
 */
const textSrc = new WeakMap();
const attrSrc = new WeakMap();

/** Simplified-Chinese char map (lazy, only needed for zh-cn). */
let zhMap = null;
let zhMapPromise = null;
function ensureZhMap(code) {
  if (code === "zh-cn" && !zhMapPromise) {
    zhMapPromise = fetch("/data/zh-simplify-map.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        zhMap = m && typeof m === "object" ? m : {};
      })
      .catch(() => {
        zhMap = {};
      });
  }
}

/** Resolves once the simplify map is loaded (identity fallback until then). */
export function waitZhMap() {
  return zhMapPromise || Promise.resolve();
}

/** Convert Traditional characters to Simplified; unknown chars pass through. */
export function simplifyZh(text) {
  if (!text || !zhMap) return text;
  let out = "";
  for (const ch of String(text)) out += zhMap[ch] || ch;
  return out;
}

/** Active language code ("en" | "zh-hk" | "zh-tw" | "zh-cn" | "ja" | "ko"). */
export function getLang() {
  return lang;
}

/** Apply the persisted language preference (no change callbacks). */
export function initLang() {
  const code = loadLanguagePref();
  lang = LANG_META[code] ? code : "en";
  document.documentElement.lang = lang;
  ensureZhMap(lang);
}

/**
 * Switch the active language (persists; fires change callbacks).
 * @returns {string} the applied code (invalid input falls back to "en")
 */
export function setLang(code) {
  const next = LANG_META[code] ? code : "en";
  const changed = next !== lang;
  lang = next;
  saveLanguagePref(next);
  document.documentElement.lang = next;
  if (changed) ensureZhMap(next);
  for (const cb of langCallbacks) {
    try {
      cb(next);
    } catch (e) {
      console.warn("[i18n] lang callback", e);
    }
  }
  return next;
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLangChange(cb) {
  langCallbacks.add(cb);
  return () => langCallbacks.delete(cb);
}

/**
 * Translate an English source string into the active language.
 * Supports `{name}`-style interpolation for dynamic values.
 */
export function t(key, params) {
  const dict = DICTS[lang];
  let out = (dict && dict[key]) || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = String(out).replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

/**
 * Translate every static string in a subtree: exact full-text-node matches
 * against the dictionaries, plus aria-label / title / placeholder attribute
 * values. Preserves surrounding whitespace. Idempotent (already-translated
 * nodes don't match any key and are left untouched).
 * @param {ParentNode} [root]
 */
export function applyLangToDom(root = document) {
  const SKIP = new Set(["SCRIPT", "STYLE", "KBD", "TITLE", "TEXTAREA"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const raw = node.nodeValue || "";
    if (!/[A-Za-z]/.test(raw)) continue;
    const parentTag = node.parentElement?.tagName || "";
    if (SKIP.has(parentTag)) continue;
    const collapsed = raw.replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    const prev = textSrc.get(node);
    const key = prev && prev.out === raw ? prev.src : collapsed;
    const translated = t(key);
    if (translated !== key) {
      const lead = raw.slice(0, raw.length - raw.trimStart().length);
      const trail = raw.slice(raw.trimEnd().length);
      const out = lead + translated + trail;
      textSrc.set(node, { src: key, out });
      node.nodeValue = out;
    }
  }
  for (const el of root.querySelectorAll("[aria-label],[title],[placeholder]")) {
    for (const attr of ["aria-label", "title", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (!v || !/[A-Za-z]/.test(v)) continue;
      const collapsed = v.replace(/\s+/g, " ").trim();
      const prev = attrSrc.get(el)?.[attr];
      const key = prev && prev.out === v ? prev.src : collapsed;
      const translated = t(key);
      if (translated !== key) {
        attrSrc.set(el, {
          ...(attrSrc.get(el) || {}),
          [attr]: { src: key, out: translated },
        });
        el.setAttribute(attr, translated);
      }
    }
  }
  // data-i18n escape hatches for the rare node scanning can't reach
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const k = el.getAttribute("data-i18n") || "";
    const v = t(k);
    if (v !== k) el.textContent = v;
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    const k = el.getAttribute("data-i18n-aria") || "";
    const v = t(k);
    if (v !== k) el.setAttribute("aria-label", v);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const k = el.getAttribute("data-i18n-title") || "";
    const v = t(k);
    if (v !== k) el.setAttribute("title", v);
  }
  for (const el of root.querySelectorAll("[data-i18n-ph]")) {
    const k = el.getAttribute("data-i18n-ph") || "";
    const v = t(k);
    if (v !== k) el.setAttribute("placeholder", v);
  }
}

/**
 * Display name for a stop object (ETA stops carry nameEn/nameTc raw fields).
 * @param {{ nameEn?: string, name_en?: string, name?: string, nameTc?: string, name_tc?: string, name_zh?: string, nameZh?: string } | null | undefined} stop
 * @param {{ combined?: boolean }} [opts] combined: "中文 English" style (MTR/LRT)
 */
export function stopDisplayName(stop, opts = {}) {
  if (!stop) return "";
  const mode = LANG_META[lang].stationMode;
  const en = String(stop.nameEn || stop.name_en || stop.name || "").trim();
  const zh = String(stop.nameTc || stop.name_tc || stop.name_zh || stop.nameZh || "").trim();
  if (mode === "en") return en || zh;
  const zhOut = zh ? (mode === "hans" ? simplifyZh(zh) : zh) : "";
  if (!zhOut) return en;
  return opts.combined ? `${zhOut} ${en}`.trim() : zhOut;
}

/**
 * Display name for a station directory entry (name_en / name_zh).
 * @param {{ name_en?: string, name?: string, name_zh?: string, name_tc?: string } | null | undefined} st
 * @param {{ combined?: boolean }} [opts]
 */
export function stationDisplayName(st, opts = {}) {
  if (!st) return "";
  const mode = LANG_META[lang].stationMode;
  const en = String(st.name_en || st.name || "").trim();
  const zh = String(st.name_zh || st.name_tc || "").trim();
  if (mode === "en") return en || zh;
  const zhOut = zh ? (mode === "hans" ? simplifyZh(zh) : zh) : "";
  if (!zhOut) return en;
  return opts.combined ? `${zhOut} ${en}`.trim() : zhOut;
}

/** Set a stop's baked `.name` to its localized display name (in place). */
export function localizeStopName(stop, opts = {}) {
  if (stop) stop.name = stopDisplayName(stop, opts);
  return stop;
}

/**
 * Localized direction label ("dest"/"orig", picking the Chinese variant for
 * zh modes — MTR/KMB directions carry destZh / origZh).
 */
export function localizeDirLabel(dir, field = "dest") {
  if (!dir) return "";
  const mode = LANG_META[lang].stationMode;
  const zh = String(dir[`${field}Zh`] || "").trim();
  const en = String(dir[field] || "").trim();
  if (mode === "en") return en || zh;
  const zhOut = zh ? (mode === "hans" ? simplifyZh(zh) : zh) : "";
  return zhOut || en;
}
