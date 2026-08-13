/**
 * Dev tool: list every candidate UI string in index.html so the language
 * dictionaries (src/i18n/*.js) can be authored against exact keys.
 *
 * Normalization matches src/lang.js applyLangToDom: collapse whitespace and
 * trim (the DOM already decodes HTML entities, so keys are entity-decoded).
 * Excludes: icon-font spans (material symbols are ligature glyphs, not text),
 * <kbd> hints, script/style/head content, URLs and © lines.
 *
 * Usage: node scripts/extract-i18n-keys.mjs > /tmp/i18n-keys.txt
 */
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const body = (html.match(/<body[\s\S]*<\/body>/i) || [""])[0]
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  // Icon spans render as font ligatures — never translate the glyph names
  .replace(/<span[^>]*class="[^"]*material-symbols[^"]*"[^>]*>[\s\S]*?<\/span>/gi, " ")
  .replace(/<kbd[\s\S]*?<\/kbd>/gi, " ");

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&times;": "×",
  "&rarr;": "→",
  "&plusmn;": "±",
  "&approx;": "≈",
  "&middot;": "·",
  "&rsquo;": "’",
  "&lsquo;": "‘",
};
const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|times|rarr|plusmn|approx|middot|rsquo|lsquo);/g, (e) => ENTITIES[e] || e);

const norm = (s) => decode(s).replace(/\s+/g, " ").trim();

const keep = (t) =>
  t &&
  /[A-Za-z]/.test(t) &&
  !/^https?:\/\//.test(t) &&
  !/^©/.test(t) &&
  !/\.(json|geojson|pmtiles)$/.test(t);

const out = new Set();
let m;
const textRe = />([^<>]+)</g;
while ((m = textRe.exec(body))) {
  const t = norm(m[1]);
  if (keep(t)) out.add(t);
}
for (const attr of ["aria-label", "placeholder", "title"]) {
  const re = new RegExp(`${attr}="([^"]+)"`, "g");
  while ((m = re.exec(body))) {
    const t = norm(m[1]);
    if (keep(t)) out.add(t);
  }
}
console.log([...out].sort().join("\n"));
console.error(`keys: ${out.size}`);
