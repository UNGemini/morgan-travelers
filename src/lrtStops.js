/**
 * MTR Light Rail stops — track-accurate coords from OSM
 * public_transport=stop_position + light_rail=yes (averaged per stop).
 * Official Stop Code / Stop ID from opendata.mtr.com.hk.
 * Stop pin overrides: public/overrides/lrt.json (static).
 * Per-track points: public/mtr/lrt-platforms.geojson
 */

import { getLrtOverrides } from "./overrides.js";

/** @type {Array<{ name_en: string, name_zh: string, lat: number, lon: number, code?: string, stop_id?: string }>} */
export const LRT_STOPS = [
  { name_en: 'Affluence', name_zh: '澤豐', lat: 22.403516, lon: 113.97585, code: 'AFF', stop_id: '80' },
  { name_en: 'Butterfly', name_zh: '蝴蝶', lat: 22.378144, lon: 113.961739, code: 'BUT', stop_id: '15' },
  { name_en: 'Chestwood', name_zh: '翠湖', lat: 22.459685, lon: 113.999581, code: 'CHE', stop_id: '490' },
  { name_en: 'Ching Chung', name_zh: '青松', lat: 22.407345, lon: 113.97256, code: 'CHC', stop_id: '120' },
  { name_en: 'Choy Yee Bridge', name_zh: '蔡意橋', lat: 22.400074, lon: 113.974345, code: 'CYB', stop_id: '75' },
  { name_en: 'Chung Fu', name_zh: '頌富', lat: 22.462007, lon: 113.996988, code: 'CHF', stop_id: '468' },
  { name_en: 'Chung Uk Tsuen', name_zh: '鍾屋村', lat: 22.429686, lon: 113.992214, code: 'CUT', stop_id: '370' },
  { name_en: 'Fung Nin Road', name_zh: '豐年路', lat: 22.444531, lon: 114.023884, code: 'FNR', stop_id: '570' },
  { name_en: 'Fung Tei', name_zh: '鳳地', lat: 22.406762, lon: 113.978791, code: 'FUT', stop_id: '340' },
  { name_en: 'Ginza', name_zh: '銀座', lat: 22.457552, lon: 114.004959, code: 'GIN', stop_id: '455' },
  { name_en: 'Goodview Garden', name_zh: '豐景園', lat: 22.383304, lon: 113.973046, code: 'GOG', stop_id: '260' },
  { name_en: 'Hang Mei Tsuen', name_zh: '坑尾村', lat: 22.445109, lon: 114.005595, code: 'HMT', stop_id: '425' },
  { name_en: 'Ho Tin', name_zh: '河田', lat: 22.397102, lon: 113.973003, code: 'HOT', stop_id: '70' },
  { name_en: 'Hoh Fuk Tong', name_zh: '何福堂', lat: 22.397408, lon: 113.977475, code: 'HFT', stop_id: '310' },
  { name_en: 'Hoi Wong Road', name_zh: '海皇路', lat: 22.38121, lon: 113.970372, code: 'TSP', stop_id: '250' },
  { name_en: 'Hong Lok Road', name_zh: '康樂路', lat: 22.444506, lon: 114.026992, code: 'HLR', stop_id: '580' },
  { name_en: 'Hung Shui Kiu', name_zh: '洪水橋', lat: 22.433647, lon: 113.997453, code: 'HSK', stop_id: '380' },
  { name_en: 'Kei Lun', name_zh: '麒麟', lat: 22.410707, lon: 113.97639, code: 'KEL', stop_id: '110' },
  { name_en: 'Kin On', name_zh: '建安', lat: 22.395174, lon: 113.9689, code: 'KIO', stop_id: '60' },
  { name_en: 'Kin Sang', name_zh: '建生', lat: 22.406765, lon: 113.969197, code: 'KIS', stop_id: '130' },
  { name_en: 'Lam Tei', name_zh: '藍地', lat: 22.418689, lon: 113.981853, code: 'LTE', stop_id: '350' },
  { name_en: 'Leung King', name_zh: '良景', lat: 22.406668, lon: 113.963578, code: 'LEK', stop_id: '150' },
  { name_en: 'Light Rail Depot', name_zh: '輕鐵車廠', lat: 22.381827, lon: 113.963372, code: 'LRD', stop_id: '20' },
  { name_en: 'Locwood', name_zh: '樂湖', lat: 22.453077, lon: 114.001114, code: 'LOC', stop_id: '448' },
  { name_en: 'Lung Mun', name_zh: '龍門', lat: 22.385266, lon: 113.965036, code: 'LUM', stop_id: '30' },
  { name_en: 'Melody Garden', name_zh: '美樂', lat: 22.375073, lon: 113.961199, code: 'MEG', stop_id: '10' },
  { name_en: 'Ming Kum', name_zh: '鳴琴', lat: 22.39715, lon: 113.967295, code: 'MIK', stop_id: '200' },
  { name_en: 'Nai Wai', name_zh: '泥圍', lat: 22.42383, lon: 113.986585, code: 'NAW', stop_id: '360' },
  { name_en: 'Ngan Wai', name_zh: '銀圍', lat: 22.402516, lon: 113.974613, code: 'NGW', stop_id: '230' },
  { name_en: 'On Ting', name_zh: '安定', lat: 22.387574, lon: 113.975103, code: 'ONT', stop_id: '270' },
  { name_en: 'Ping Shan', name_zh: '屏山', lat: 22.442897, lon: 114.012078, code: 'PIS', stop_id: '400' },
  { name_en: 'Prime View', name_zh: '景峰', lat: 22.403135, lon: 113.979452, code: 'PRV', stop_id: '330' },
  { name_en: 'Pui To', name_zh: '杯渡', lat: 22.394682, lon: 113.976784, code: 'PUT', stop_id: '300' },
  { name_en: 'Sam Shing', name_zh: '三聖', lat: 22.382607, lon: 113.97668, code: 'SAS', stop_id: '920' },
  { name_en: 'San Hui', name_zh: '新墟', lat: 22.400246, lon: 113.978032, code: 'SAH', stop_id: '320' },
  { name_en: 'San Wai', name_zh: '新圍', lat: 22.405248, lon: 113.964478, code: 'SAW', stop_id: '160' },
  { name_en: 'Shan King (North)', name_zh: '山景 (北)', lat: 22.398482, lon: 113.966662, code: 'SKN', stop_id: '180' },
  { name_en: 'Shan King (South)', name_zh: '山景 (南)', lat: 22.396697, lon: 113.966074, code: 'SKS', stop_id: '190' },
  { name_en: 'Shek Pai', name_zh: '石排', lat: 22.401419, lon: 113.96776, code: 'SHP', stop_id: '170' },
  { name_en: 'Shui Pin Wai', name_zh: '水邊圍', lat: 22.444465, lon: 114.020192, code: 'SPW', stop_id: '560' },
  { name_en: 'Siu Hei', name_zh: '兆禧', lat: 22.375235, lon: 113.966866, code: 'SHE', stop_id: '240' },
  { name_en: 'Siu Hong', name_zh: '兆康', lat: 22.412019, lon: 113.978259, code: 'SHL', stop_id: '100' },
  { name_en: 'Siu Lun', name_zh: '兆麟', lat: 22.384582, lon: 113.975038, code: 'SIL', stop_id: '265' },
  { name_en: 'Tai Hing (North)', name_zh: '大興 (北)', lat: 22.404242, lon: 113.970215, code: 'THN', stop_id: '212' },
  { name_en: 'Tai Hing (South)', name_zh: '大興 (南)', lat: 22.402749, lon: 113.972018, code: 'THS', stop_id: '220' },
  { name_en: 'Tai Tong Road', name_zh: '大棠路', lat: 22.444475, lon: 114.029502, code: 'TTR', stop_id: '590' },
  { name_en: 'Tin Fu', name_zh: '天富', lat: 22.464562, lon: 113.997663, code: 'TFU', stop_id: '480' },
  { name_en: 'Tin Heng', name_zh: '天恒', lat: 22.469727, lon: 114.000759, code: 'THE', stop_id: '540' },
  { name_en: 'Tin King', name_zh: '田景', lat: 22.407746, lon: 113.966415, code: 'TNK', stop_id: '140' },
  { name_en: 'Tin Sau', name_zh: '天秀', lat: 22.465519, lon: 114.002897, code: 'TSA', stop_id: '520' },
  { name_en: 'Tin Shui', name_zh: '天瑞', lat: 22.455889, lon: 113.9994, code: 'TSU', stop_id: '460' },
  { name_en: 'Tin Shui Wai', name_zh: '天水圍', lat: 22.449422, lon: 114.005985, code: 'TSL', stop_id: '430' },
  { name_en: 'Tin Tsz', name_zh: '天慈', lat: 22.452754, lon: 114.006052, code: 'TIT', stop_id: '435' },
  { name_en: 'Tin Wing', name_zh: '天榮', lat: 22.46, lon: 114.00222, code: 'TWI', stop_id: '500' },
  { name_en: 'Tin Wu', name_zh: '天湖', lat: 22.454937, lon: 114.005694, code: 'TWU', stop_id: '450' },
  { name_en: 'Tin Yat', name_zh: '天逸', lat: 22.466881, lon: 113.999065, code: 'TYA', stop_id: '550' },
  { name_en: 'Tin Yiu', name_zh: '天耀', lat: 22.450358, lon: 114.002766, code: 'TIY', stop_id: '445' },
  { name_en: 'Tin Yuet', name_zh: '天悅', lat: 22.462768, lon: 114.001614, code: 'TYU', stop_id: '510' },
  { name_en: 'Tong Fong Tsuen', name_zh: '塘坊村', lat: 22.440243, lon: 114.007367, code: 'TOF', stop_id: '390' },
  { name_en: 'Town Centre', name_zh: '市中心', lat: 22.391333, lon: 113.974962, code: 'TOC', stop_id: '280' },
  { name_en: 'Tsing Shan Tsuen', name_zh: '青山村', lat: 22.390642, lon: 113.967144, code: 'TSS', stop_id: '40' },
  { name_en: 'Tsing Wun', name_zh: '青雲', lat: 22.394355, lon: 113.967461, code: 'TWN', stop_id: '50' },
  { name_en: 'Tuen Mun', name_zh: '屯門', lat: 22.393831, lon: 113.973075, code: 'TML', stop_id: '295' },
  { name_en: 'Tuen Mun Ferry Pier', name_zh: '屯門碼頭', lat: 22.3726, lon: 113.966591, code: 'FEP', stop_id: '1' },
  { name_en: 'Tuen Mun Hospital', name_zh: '屯門醫院', lat: 22.407812, lon: 113.977113, code: 'TMH', stop_id: '90' },
  { name_en: 'Wetland Park', name_zh: '濕地公園', lat: 22.469547, lon: 114.002529, code: 'WEP', stop_id: '530' },
  { name_en: 'Yau Oi', name_zh: '友愛', lat: 22.386702, lon: 113.973585, code: 'YAO', stop_id: '275' },
  { name_en: 'Yuen Long', name_zh: '元朗', lat: 22.445624, lon: 114.034733, code: 'YLL', stop_id: '600' },
];

/**
 * Apply stop coordinate overrides from public/overrides/lrt.json.
 */
export function applyLrtStopOverrides() {
  const stops = getLrtOverrides()?.stops || {};
  for (const [nameEn, ov] of Object.entries(stops)) {
    const st = LRT_STOPS.find(
      (s) => s.name_en.toLowerCase() === String(nameEn).toLowerCase(),
    );
    if (!st) continue;
    if (Number.isFinite(ov.lat)) st.lat = ov.lat;
    if (Number.isFinite(ov.lon)) st.lon = ov.lon;
    if (ov.name_zh) st.name_zh = ov.name_zh;
    if (ov.code) st.code = ov.code;
    if (ov.stop_id) st.stop_id = String(ov.stop_id);
  }
}

// Apply bundled/static fallback immediately (re-applied after fetch load)
applyLrtStopOverrides();

function normLrtKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[·•]/g, " ")
    .replace(/\blight\s*rail\b/g, " ")
    .replace(/輕鐵/g, " ")
    .replace(/\bstation\b|\bstn\b/g, " ")
    .replace(/站/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * Format a local LRT stop as a search hit.
 * isMtr is false so UI does not treat it as heavy rail / snap to TML.
 */
export function lrtStopToHit(s) {
  const zh = s.name_zh || "";
  return {
    lat: s.lat,
    lon: s.lon,
    name: zh ? `${zh} ${s.name_en}` : s.name_en,
    label: `${zh ? zh + " · " : ""}${s.name_en} · Light Rail`,
    isLrt: true,
    isMtr: false,
    category: "railway",
    type: "halt",
    source: "lrt-local",
    mode: "lrt",
    code: s.code || "",
    stop_id: s.stop_id || "",
  };
}

/**
 * Resolve a place name / pin to the official LRT stop (by name or proximity).
 * @param {string} [label]
 * @param {number} [lat]
 * @param {number} [lon]
 * @param {number} [maxMeters]
 */
export function matchLrtStop(label, lat, lon, maxMeters = 280) {
  const q = normLrtKey(label);
  let bestName = null;
  let bestNameScore = 0;

  for (const s of LRT_STOPS) {
    const en = normLrtKey(s.name_en);
    const zh = s.name_zh || "";
    let score = 0;
    if (q && (en === q || zh === q || zh === String(label || "").trim())) score = 1000;
    else if (q && (en.startsWith(q) || q.startsWith(en)) && en.length >= 3) score = 800;
    else if (q && q.length >= 2 && (en.includes(q) || zh.includes(q))) score = 600;
    if (score && en === q) score += 50;
    // Prefer longer, more specific names: "Tuen Mun Hospital" over "Tuen Mun"
    // when query is "tuen mun hospital" (both may match prefix rules).
    if (score && en.length > 0 && q.startsWith(en)) {
      score += Math.min(120, en.length * 4);
    }
    if (
      score > bestNameScore ||
      (score === bestNameScore &&
        score > 0 &&
        s.name_en.length > (bestName?.name_en.length || 0))
    ) {
      bestNameScore = score;
      bestName = s;
    }
  }
  if (bestName && bestNameScore >= 600) return bestName;

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    let best = null;
    let bestD = maxMeters;
    for (const s of LRT_STOPS) {
      const d = haversineM(lat, lon, s.lat, s.lon);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Nearest LRT stop_position / platform point for itinerary geometry.
 * @param {{ lat: number, lon: number, stop_name?: string }} stop
 * @param {GeoJSON.FeatureCollection | null} platformsFc
 */
export function resolveLrtPlatform(stop, platformsFc) {
  if (!stop || !platformsFc?.features?.length) return null;
  const lat = stop.location?.lat ?? stop.lat;
  const lon = stop.location?.lon ?? stop.lon;
  const name = String(stop.stop_name || stop.name || "");
  const matched = matchLrtStop(name, lat, lon, 400);
  let candidates = platformsFc.features;
  if (matched) {
    const en = matched.name_en.toLowerCase();
    const filtered = candidates.filter(
      (f) => String(f.properties?.stop_name_en || "").toLowerCase() === en,
    );
    if (filtered.length) candidates = filtered;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const f = candidates[0];
    if (!f) return null;
    const [plon, plat] = f.geometry.coordinates;
    return {
      lon: plon,
      lat: plat,
      platform_key: f.properties.platform_key,
      ref: f.properties.ref,
      station_name: f.properties.stop_name_en,
      station_code: f.properties.station_code,
    };
  }
  let best = null;
  let bestD = Infinity;
  for (const f of candidates) {
    const [plon, plat] = f.geometry.coordinates;
    const d = (plon - lon) ** 2 + (plat - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  if (!best) return null;
  const [plon, plat] = best.geometry.coordinates;
  return {
    lon: plon,
    lat: plat,
    platform_key: best.properties.platform_key,
    ref: String(best.properties.ref || ""),
    station_name: best.properties.stop_name_en || name,
    station_code: best.properties.station_code || "",
  };
}

/**
 * @param {string} query
 * @param {number} [limit]
 */
export function searchLrtStopsLocal(query, limit = 12) {
  const q = String(query || "")
    .toLowerCase()
    .replace(/@\s*lrt\b/gi, "")
    .replace(/\blight\s*rail\b/gi, "")
    .replace(/輕鐵/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const seen = new Set();
  const scored = [];

  for (const s of LRT_STOPS) {
    const en = s.name_en.toLowerCase();
    const zh = s.name_zh || "";
    const key = `${en}|${s.lat.toFixed(5)}`;
    if (seen.has(key)) continue;

    let score = 0;
    if (!q) score = 10;
    else if (en === q || zh === q) score = 1000;
    else if (en.startsWith(q) || zh.startsWith(q)) score = 800;
    else if (en.includes(q) || zh.includes(q)) score = 600;
    else {
      const tokens = q.split(/\s+/).filter(Boolean);
      if (tokens.every((t) => en.includes(t) || zh.includes(t))) score = 400;
      else continue;
    }

    seen.add(key);
    scored.push({ score, ...lrtStopToHit(s) });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(({ score: _s, ...rest }) => rest);
}
