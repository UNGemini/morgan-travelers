/**
 * Official MTR station directory for search + routing pin snaps.
 * Coordinates from public/mtr/stations.geojson (CSDI / exits crawler).
 * Access-pin overrides: public/overrides/mtr-access-pins.json (static).
 * Names align with MTR open data English names (fare matrix).
 */

import {
  getAccessPinLockSet,
  getAccessPinCoords,
} from "./overrides.js";

/** @type {Array<{ name_en: string, name_zh?: string, lat: number, lon: number, code?: string }>} */
export let MTR_STATIONS = [
  // Sha Tin default — overridden by public/overrides/mtr-access-pins.json
  { name_en: "Sha Tin", name_zh: "沙田", lat: 22.3827, lon: 114.1875, code: "SHT" },
  { name_en: "Admiralty", name_zh: "金鐘", lat: 22.278384, lon: 114.165956, code: "ADM" },
  // AEL Platform 2 — reliable RAPTOR board/alight (centroid also OK)
  { name_en: "Airport", name_zh: "機場", lat: 22.31595, lon: 113.93656, code: "AIR" },
  // AEL stop orphaned in wheels graph; dual-access via Airport in stationAccess.js
  { name_en: "AsiaWorld-Expo", name_zh: "博覽館", lat: 22.321897, lon: 113.942015, code: "AWE" },
  { name_en: "Austin", name_zh: "柯士甸", lat: 22.30447, lon: 114.166666, code: "AUS" },
  { name_en: "Causeway Bay", name_zh: "銅鑼灣", lat: 22.27958, lon: 114.183869, code: "CAB" },
  { name_en: "Central", name_zh: "中環", lat: 22.281895, lon: 114.159243, code: "CEN" },
  { name_en: "Chai Wan", name_zh: "柴灣", lat: 22.264599, lon: 114.237124, code: "CHW" },
  { name_en: "Che Kung Temple", name_zh: "車公廟", lat: 22.374768, lon: 114.186174, code: "CKT" },
  { name_en: "Cheung Sha Wan", name_zh: "長沙灣", lat: 22.335389, lon: 114.156422, code: "CSW" },
  { name_en: "Choi Hung", name_zh: "彩虹", lat: 22.334807, lon: 114.208799, code: "CHH" },
  { name_en: "City One", name_zh: "第一城", lat: 22.382857, lon: 114.203519, code: "CIO" },
  { name_en: "Diamond Hill", name_zh: "鑽石山", lat: 22.339869, lon: 114.201406, code: "DIH" },
  { name_en: "Disneyland Resort", name_zh: "迪士尼", lat: 22.315394, lon: 114.044907, code: "DIS" },
  { name_en: "East Tsim Sha Tsui", name_zh: "尖東", lat: 22.296206, lon: 114.173893, code: "ETS" },
  { name_en: "Exhibition Centre", name_zh: "會展", lat: 22.281608, lon: 114.175192, code: "EXC" },
  { name_en: "Fanling", name_zh: "粉嶺", lat: 22.492132, lon: 114.138651, code: "FAN" },
  { name_en: "Fo Tan", name_zh: "火炭", lat: 22.395607, lon: 114.198354, code: "FOT" },
  { name_en: "Fortress Hill", name_zh: "炮台山", lat: 22.287698, lon: 114.193759, code: "FOH" },
  { name_en: "Hang Hau", name_zh: "坑口", lat: 22.315828, lon: 114.264166, code: "HAH" },
  { name_en: "Heng Fa Chuen", name_zh: "杏花邨", lat: 22.276541, lon: 114.239633, code: "HFC" },
  { name_en: "Heng On", name_zh: "恆安", lat: 22.417504, lon: 114.225748, code: "HEO" },
  { name_en: "Hin Keng", name_zh: "顯徑", lat: 22.363921, lon: 114.170795, code: "HIK" },
  { name_en: "HKU", name_zh: "香港大學", lat: 22.284562, lon: 114.134746, code: "HKU" },
  { name_en: "Ho Man Tin", name_zh: "何文田", lat: 22.310026, lon: 114.182675, code: "HOM" },
  // Access pin: geojson centroid is unroutable. Use AEL/TCL platform cluster (IFC)
  // so Airport Express boards with ~25 m walk instead of 450 m+ via Central streets.
  { name_en: "Hong Kong", name_zh: "香港", lat: 22.28495, lon: 114.15835, code: "HOK" },
  { name_en: "Hung Hom", name_zh: "紅磡", lat: 22.30244, lon: 114.18181, code: "HUH" },
  { name_en: "Jordan", name_zh: "佐敦", lat: 22.304851, lon: 114.171707, code: "JOR" },
  { name_en: "Kai Tak", name_zh: "啟德", lat: 22.330637, lon: 114.199654, code: "KAT" },
  { name_en: "Kam Sheung Road", name_zh: "錦上路", lat: 22.434798, lon: 114.06342, code: "KSR" },
  { name_en: "Kennedy Town", name_zh: "堅尼地城", lat: 22.2814, lon: 114.128529, code: "KET" },
  { name_en: "Kowloon", name_zh: "九龍", lat: 22.304787, lon: 114.161733, code: "KOW" },
  { name_en: "Kowloon Bay", name_zh: "九龍灣", lat: 22.323434, lon: 114.214081, code: "KOB" },
  { name_en: "Kowloon Tong", name_zh: "九龍塘", lat: 22.337117, lon: 114.176676, code: "KOT" },
  { name_en: "Kwai Fong", name_zh: "葵芳", lat: 22.356847, lon: 114.127807, code: "KWF" },
  { name_en: "Kwai Hing", name_zh: "葵興", lat: 22.363169, lon: 114.131359, code: "KWH" },
  { name_en: "Kwun Tong", name_zh: "觀塘", lat: 22.312143, lon: 114.226575, code: "KWT" },
  { name_en: "Lai Chi Kok", name_zh: "茘枝角", lat: 22.336561, lon: 114.148069, code: "LCK" },
  { name_en: "Lai King", name_zh: "茘景", lat: 22.348324, lon: 114.126159, code: "LAK" },
  { name_en: "Lam Tin", name_zh: "藍田", lat: 22.306932, lon: 114.233064, code: "LAT" },
  { name_en: "Lei Tung", name_zh: "利東", lat: 22.2422, lon: 114.156011, code: "LET" },
  { name_en: "Lo Wu", name_zh: "羅湖", lat: 22.528067, lon: 114.11371, code: "LOW" },
  { name_en: "LOHAS Park", name_zh: "康城", lat: 22.295492, lon: 114.268652, code: "LHP" },
  { name_en: "Lok Fu", name_zh: "樂富", lat: 22.33787, lon: 114.186758, code: "LOF" },
  { name_en: "Lok Ma Chau", name_zh: "落馬洲", lat: 22.515001, lon: 114.065682, code: "LMC" },
  { name_en: "Long Ping", name_zh: "朗屏", lat: 22.447773, lon: 114.025423, code: "LOP" },
  { name_en: "Ma On Shan", name_zh: "馬鞍山", lat: 22.424795, lon: 114.231607, code: "MOS" },
  { name_en: "Mei Foo", name_zh: "美孚", lat: 22.338305, lon: 114.138401, code: "MEF" },
  { name_en: "Mong Kok", name_zh: "旺角", lat: 22.319467, lon: 114.169367, code: "MOK" },
  { name_en: "Mong Kok East", name_zh: "旺角東", lat: 22.322162, lon: 114.172712, code: "MKK" },
  { name_en: "Nam Cheong", name_zh: "南昌", lat: 22.326465, lon: 114.153826, code: "NAC" },
  { name_en: "Ngau Tau Kok", name_zh: "牛頭角", lat: 22.315502, lon: 114.218922, code: "NTK" },
  { name_en: "North Point", name_zh: "北角", lat: 22.291154, lon: 114.200476, code: "NOP" },
  { name_en: "Ocean Park", name_zh: "海洋公園", lat: 22.248594, lon: 114.174377, code: "OCP" },
  { name_en: "Olympic", name_zh: "奧運", lat: 22.317804, lon: 114.160183, code: "OLY" },
  { name_en: "Po Lam", name_zh: "寶琳", lat: 22.322717, lon: 114.257764, code: "POA" },
  { name_en: "Prince Edward", name_zh: "太子", lat: 22.324657, lon: 114.168343, code: "PRE" },
  { name_en: "Quarry Bay", name_zh: "鰂魚涌", lat: 22.288774, lon: 114.208946, code: "QUB" },
  { name_en: "Racecourse", name_zh: "馬場", lat: 22.4005, lon: 114.2028, code: "RAC" },
  { name_en: "Sai Wan Ho", name_zh: "西灣河", lat: 22.282007, lon: 114.222037, code: "SWH" },
  { name_en: "Sai Ying Pun", name_zh: "西營盤", lat: 22.286092, lon: 114.143085, code: "SYP" },
  { name_en: "Sha Tin Wai", name_zh: "沙田圍", lat: 22.377033, lon: 114.194992, code: "STW" },
  { name_en: "Sham Shui Po", name_zh: "深水埗", lat: 22.330758, lon: 114.162281, code: "SSP" },
  { name_en: "Shau Kei Wan", name_zh: "筲箕灣", lat: 22.279549, lon: 114.229066, code: "SKW" },
  { name_en: "Shek Kip Mei", name_zh: "石硤尾", lat: 22.331827, lon: 114.168849, code: "SKM" },
  { name_en: "Shek Mun", name_zh: "石門", lat: 22.387674, lon: 114.208266, code: "SHM" },
  { name_en: "Sheung Shui", name_zh: "上水", lat: 22.501383, lon: 114.127858, code: "SHS" },
  { name_en: "Sheung Wan", name_zh: "上環", lat: 22.286855, lon: 114.1515, code: "SHW" },
  { name_en: "Siu Hong", name_zh: "兆康", lat: 22.412099, lon: 113.978726, code: "SIH" },
  { name_en: "South Horizons", name_zh: "海怡半島", lat: 22.242483, lon: 114.149032, code: "SOH" },
  { name_en: "Sung Wong Toi", name_zh: "宋皇臺", lat: 22.326944, lon: 114.191215, code: "SUW" },
  { name_en: "Sunny Bay", name_zh: "欣澳", lat: 22.33189, lon: 114.028947, code: "SUN" },
  { name_en: "Tai Koo", name_zh: "太古", lat: 22.285162, lon: 114.21621, code: "TAK" },
  { name_en: "Tai Po Market", name_zh: "大埔墟", lat: 22.44448, lon: 114.170558, code: "TAP" },
  { name_en: "Tai Shui Hang", name_zh: "大水坑", lat: 22.408207, lon: 114.222595, code: "TSH" },
  { name_en: "Tai Wai", name_zh: "大圍", lat: 22.373065, lon: 114.178365, code: "TAW" },
  { name_en: "Tai Wo", name_zh: "太和", lat: 22.451058, lon: 114.161068, code: "TWO" },
  { name_en: "Tai Wo Hau", name_zh: "大窩口", lat: 22.370818, lon: 114.125039, code: "TWH" },
  { name_en: "Tin Hau", name_zh: "天后", lat: 22.282251, lon: 114.191811, code: "TIH" },
  { name_en: "Tin Shui Wai", name_zh: "天水圍", lat: 22.448032, lon: 114.004621, code: "TIS" },
  { name_en: "Tiu Keng Leng", name_zh: "調景嶺", lat: 22.303947, lon: 114.252265, code: "TIK" },
  { name_en: "To Kwa Wan", name_zh: "土瓜灣", lat: 22.316935, lon: 114.187532, code: "TKW" },
  { name_en: "Tseung Kwan O", name_zh: "將軍澳", lat: 22.307366, lon: 114.259899, code: "TKO" },
  { name_en: "Tsim Sha Tsui", name_zh: "尖沙咀", lat: 22.297295, lon: 114.172377, code: "TST" },
  { name_en: "Tsing Yi", name_zh: "青衣", lat: 22.358325, lon: 114.107029, code: "TSY" },
  { name_en: "Tsuen Wan", name_zh: "荃灣", lat: 22.373615, lon: 114.117827, code: "TSW" },
  { name_en: "Tsuen Wan West", name_zh: "荃灣西", lat: 22.368067, lon: 114.109967, code: "TWW" },
  { name_en: "Tuen Mun", name_zh: "屯門", lat: 22.395229, lon: 113.973162, code: "TUM" },
  { name_en: "Tung Chung", name_zh: "東涌", lat: 22.289342, lon: 113.941528, code: "TUC" },
  { name_en: "University", name_zh: "大學", lat: 22.413624, lon: 114.210325, code: "UNI" },
  { name_en: "Wan Chai", name_zh: "灣仔", lat: 22.277237, lon: 114.172916, code: "WAC" },
  { name_en: "Whampoa", name_zh: "黃埔", lat: 22.304804, lon: 114.190185, code: "WHA" },
  { name_en: "Wong Chuk Hang", name_zh: "黃竹坑", lat: 22.248241, lon: 114.167576, code: "WCH" },
  { name_en: "Wong Tai Sin", name_zh: "黃大仙", lat: 22.341625, lon: 114.194086, code: "WTS" },
  { name_en: "Wu Kai Sha", name_zh: "烏溪沙", lat: 22.429146, lon: 114.243936, code: "WKS" },
  { name_en: "Yau Ma Tei", name_zh: "油麻地", lat: 22.312769, lon: 114.170592, code: "YMT" },
  { name_en: "Yau Tong", name_zh: "油塘", lat: 22.297814, lon: 114.237167, code: "YAT" },
  { name_en: "Yuen Long", name_zh: "元朗", lat: 22.446251, lon: 114.03531, code: "YUL" },
];

function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\bstation\b/g, " ")
    .replace(/\bmtr\b/g, " ")
    .replace(/站/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Local MTR station hits for free-text search (ahead of Nominatim bus stops).
 * @param {string} query
 * @param {number} [limit]
 */
export function searchMtrStationsLocal(query, limit = 8) {
  const q = normKey(query);
  if (q.length < 2) return [];

  const wantsStation =
    /\bstation\b|\bstn\b|\bmtr\b|站/.test(query.toLowerCase()) || /站/.test(query);
  // Strip station words for matching bare names ("Sha Tin Station" → "sha tin")
  // Keep LRT-specific qualifiers so "Tuen Mun Hospital" ≠ "Tuen Mun" MTR.
  const qCore = normKey(
    query
      .replace(/\b(station|stn|mtr|railway|light\s*rail)\b/gi, " ")
      .replace(/站|鐵路|地鐵|地铁|輕鐵/g, " "),
  );

  // Place names that share an MTR district name but are not the heavy-rail station
  const lrtSpecific =
    /\b(hospital|ferry\s*pier|ferry|pier|town\s*centre|town\s*center|depot)\b|醫院|碼頭|市中心|車廠/i.test(
      query,
    );

  const scored = [];
  for (const st of MTR_STATIONS) {
    const en = normKey(st.name_en);
    const zh = st.name_zh || "";
    let score = 0;
    if (en === q || en === qCore || zh === query.trim() || zh === qCore) score = 1000;
    else if (en.startsWith(qCore) || qCore.startsWith(en) || en.startsWith(q)) score = 800;
    else if (en.includes(qCore) || qCore.includes(en) || en.includes(q)) score = 600;
    else if (zh && (zh.includes(query.trim()) || query.includes(zh) || zh.includes(qCore)))
      score = 700;
    else continue;

    // "Tuen Mun Hospital" / "Tuen Mun Ferry Pier" must not resolve to Tuen Mun MTR
    if (
      lrtSpecific ||
      (qCore !== en && qCore.startsWith(en + " ")) ||
      (qCore !== en && qCore.includes(en) && qCore.length > en.length + 2 && !en.startsWith(qCore))
    ) {
      // Only keep if this station's full name is the query (exact / equal core)
      if (en !== qCore && en !== q) continue;
    }

    // Prefer exact "sha tin" over "sha tin wai" when query is "sha tin"
    if (en !== qCore && en !== q && en.startsWith(qCore + " ")) score -= 80;
    if (wantsStation && !lrtSpecific) score += 100;
    // Exact station name match is decisive
    if (en === qCore) score += 200;

    scored.push({ st, score });
  }

  // Require a minimum score so weak substring noise is ignored
  const strong = scored.filter((x) => x.score >= 600);
  const pool = strong.length ? strong : scored;

  pool.sort((a, b) => b.score - a.score || a.st.name_en.localeCompare(b.st.name_en));

  // Dedupe by name_en
  const seen = new Set();
  const out = [];
  for (const { st } of pool) {
    const k = st.name_en.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      lat: st.lat,
      lon: st.lon,
      name: `${st.name_en} Station`,
      label: st.name_zh
        ? `${st.name_zh} ${st.name_en} Station · MTR`
        : `${st.name_en} Station · MTR`,
      category: "railway",
      type: "station",
      isMtr: true,
      source: "mtr-local",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Snap a free-text / geocode label to the nearest local MTR station if close.
 */
export function snapToMtrStation(lat, lon, label, maxMeters = 250) {
  // Never snap LRT-only place names (Hospital / Ferry Pier / …) onto heavy rail
  const raw = String(label || "");
  if (
    /light\s*rail|輕鐵|\blrt\b/i.test(raw) ||
    /\b(hospital|ferry\s*pier|ferry|pier|town\s*centre|depot)\b|醫院|碼頭|市中心|車廠/i.test(
      raw,
    )
  ) {
    // Still allow true dual-hub labels like "Tuen Mun Station · MTR"
    if (!/\bmtr\b|港鐵/i.test(raw) || /light\s*rail|輕鐵|hospital|ferry|醫院|碼頭/i.test(raw)) {
      return null;
    }
  }

  const local = searchMtrStationsLocal(label || "", 5);
  // Also try nearest by distance among all stations
  let best = null;
  let bestD = Infinity;
  for (const st of MTR_STATIONS) {
    const d = haversineM(lat, lon, st.lat, st.lon);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  if (best && bestD <= maxMeters) {
    return {
      lat: best.lat,
      lon: best.lon,
      name: `${best.name_en} Station`,
      label: best.name_zh
        ? `${best.name_zh} ${best.name_en} Station · MTR`
        : `${best.name_en} Station · MTR`,
      category: "railway",
      type: "station",
      isMtr: true,
      source: "mtr-snap",
    };
  }
  // Name-based snap from local search (e.g. query "Sha Tin Station")
  if (local[0]) return local[0];
  return null;
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
 * Apply static access-pin overrides from public/overrides/mtr-access-pins.json.
 */
export function applyAccessPinOverrides() {
  const pins = getAccessPinCoords();
  for (const [key, pin] of pins) {
    const st = MTR_STATIONS.find((s) => s.name_en.toLowerCase() === key);
    if (st) {
      st.lat = pin.lat;
      st.lon = pin.lon;
      if (pin.name_zh) st.name_zh = pin.name_zh;
      if (pin.code) st.code = pin.code;
    } else {
      MTR_STATIONS.push({
        name_en: key.replace(/\b\w/g, (c) => c.toUpperCase()),
        name_zh: pin.name_zh,
        lat: pin.lat,
        lon: pin.lon,
        code: pin.code,
      });
    }
  }
}

/**
 * Merge stations from exits-crawler GeoJSON.
 * Prefer GeoJSON coordinates for RAPTOR connectivity, except locked access pins
 * from public/overrides/mtr-access-pins.json.
 * @param {Array<{ name_en: string, name_zh?: string, lat: number, lon: number, code?: string }>} extra
 */
export function mergeStationDirectory(extra) {
  if (!extra?.length) return;
  const lock = getAccessPinLockSet();
  const byEn = new Map(MTR_STATIONS.map((s) => [s.name_en.toLowerCase(), s]));
  for (const s of extra) {
    if (!s?.name_en || !Number.isFinite(s.lat)) continue;
    const k = s.name_en.toLowerCase();
    const existing = byEn.get(k);
    if (existing) {
      if (s.code) existing.code = s.code;
      if (s.name_zh) existing.name_zh = s.name_zh;
      // Update pin from GeoJSON unless this is a locked access fix
      if (!lock.has(k) && Number.isFinite(s.lon)) {
        existing.lat = s.lat;
        existing.lon = s.lon;
      }
    } else {
      MTR_STATIONS.push({
        name_en: s.name_en,
        name_zh: s.name_zh,
        lat: s.lat,
        lon: s.lon,
        code: s.code,
      });
      byEn.set(k, MTR_STATIONS[MTR_STATIONS.length - 1]);
    }
  }
}
