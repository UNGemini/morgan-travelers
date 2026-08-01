#!/usr/bin/env node
/**
 * Expand NLB Chinese 八達通轉乘 tables → public/fares/bbi-compact.json pairs.
 *
 * Source: https://www.nlb.com.hk/info/passenger#bus_bus_interchange (zh only)
 * Data:   src/data/nlb-interchange.json
 *
 * Usage: node scripts/merge-nlb-bbi.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const NLB = path.join(ROOT, "src", "data", "nlb-interchange.json");
const COMPACT = path.join(ROOT, "public", "fares", "bbi-compact.json");
const SCHEMES = path.join(ROOT, "src", "data", "interchange-schemes.json");

function expand(ref, groups) {
  if (Array.isArray(ref)) {
    return ref.flatMap((x) => expand(x, groups));
  }
  const s = String(ref || "").trim();
  if (!s) return [];
  if (groups[s]) return [...groups[s]];
  return [s.toUpperCase().replace(/\s+/g, "")];
}

function addPair(map, from, to, save) {
  const a = String(from).toUpperCase().replace(/\s+/g, "");
  const b = String(to).toUpperCase().replace(/\s+/g, "");
  if (!a || !b || a === b) return;
  if (save == null || !(save >= 0)) return;
  // free = 0: still mark with tiny sentinel? skip free for now (second leg $0 rare)
  if (save === 0) {
    // encode free as full second-leg waiver isn't known without fare — skip
    return;
  }
  const key = `${a}>${b}`;
  const prev = map[key] || 0;
  if (save > prev) map[key] = Math.round(save * 10) / 10;
}

function main() {
  const nlb = JSON.parse(fs.readFileSync(NLB, "utf8"));
  const groups = nlb.groups || {};
  /** @type {Record<string, number>} */
  const added = {};

  for (const scheme of nlb.schemes || []) {
    const adultDefault = scheme.adult;
    if (Array.isArray(scheme.pairs_explicit)) {
      for (const p of scheme.pairs_explicit) {
        if (p.free) continue;
        const save = p.adult ?? adultDefault;
        const froms = expand(p.from, groups);
        const tos = expand(p.to, groups);
        for (const f of froms) for (const t of tos) addPair(added, f, t, save);
      }
    }
    if (Array.isArray(scheme.pairs)) {
      for (const p of scheme.pairs) {
        const save = p.adult ?? adultDefault;
        const froms = expand(p.from, groups);
        const tos = expand(p.to, groups);
        for (const f of froms) for (const t of tos) addPair(added, f, t, save);
      }
    }
  }

  let compact = {
    schema: "morgan.travelers.bbi-compact.v1",
    updated_at: new Date().toISOString().slice(0, 10),
    pairs: {},
  };
  if (fs.existsSync(COMPACT)) {
    compact = JSON.parse(fs.readFileSync(COMPACT, "utf8"));
    if (!compact.pairs) compact.pairs = {};
  }

  let newCount = 0;
  let raised = 0;
  for (const [k, v] of Object.entries(added)) {
    const prev = compact.pairs[k];
    if (prev == null) {
      compact.pairs[k] = v;
      newCount += 1;
    } else if (v > prev) {
      compact.pairs[k] = v;
      raised += 1;
    }
  }

  compact.pair_count = Object.keys(compact.pairs).length;
  compact.updated_at = new Date().toISOString().slice(0, 10);
  compact.sources = Array.from(
    new Set([
      ...(compact.sources || []),
      nlb.source?.url || "https://www.nlb.com.hk/info/passenger#bus_bus_interchange",
    ]),
  );
  compact.note =
    (compact.note || "") +
    " + NLB zh passenger BBI (Tung Chung / HZMB / south Lantau pairs).";

  fs.writeFileSync(COMPACT, JSON.stringify(compact) + "\n");

  if (fs.existsSync(SCHEMES)) {
    const schemes = JSON.parse(fs.readFileSync(SCHEMES, "utf8"));
    if (!schemes.sources) schemes.sources = [];
    if (!schemes.sources.some((s) => s.id === "nlb_passenger_bbi")) {
      schemes.sources.push({
        id: "nlb_passenger_bbi",
        title: "NLB Octopus interchange (Chinese only)",
        url: "https://www.nlb.com.hk/info/passenger#bus_bus_interchange",
        language: "zh-HK",
        note: "No English page (/en/info/passenger 404). Structured extract: src/data/nlb-interchange.json",
      });
    }
    if (!schemes.bus_bus) schemes.bus_bus = {};
    schemes.bus_bus.nlb_pairs_merged = Object.keys(added).length;
    schemes.bus_bus.nlb_source = "src/data/nlb-interchange.json";
    schemes.bus_bus.compact_pairs = compact.pair_count;
    schemes.bus_bus.compact_updated_at = compact.updated_at;
    schemes.updated_at = compact.updated_at;
    fs.writeFileSync(SCHEMES, JSON.stringify(schemes, null, 2) + "\n");
  }

  console.log("NLB pairs expanded:", Object.keys(added).length);
  console.log("  new in compact:", newCount, "raised:", raised);
  console.log("  compact total:", compact.pair_count);
  console.log("  sample B6>38 free skipped; B6>37", added["B6>37"]);
  console.log("  sample 37>E11", added["37>E11"], "E32>3M", added["E32>3M"]);
  console.log("wrote", COMPACT);
}

main();
