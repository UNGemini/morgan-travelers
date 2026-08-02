/**
 * Official MTR heavy-rail station order per line.
 * Index increases with Next Train API "UP" polarity (see eta.js comments).
 */

/** @type {Record<string, string[]>} */
export const MTR_LINE_ORDER = {
  // UP → Tung Chung, DOWN → Hong Kong
  TCL: ["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"],
  // UP → AsiaWorld-Expo, DOWN → Hong Kong
  AEL: ["HOK", "KOW", "TSY", "AIR", "AWE"],
  // UP → Chai Wan, DOWN → Kennedy Town
  ISL: [
    "KET", "HKU", "SYP", "SHW", "CEN", "ADM", "WAC", "CAB", "TIH", "FOH",
    "NOP", "QUB", "TAK", "SWH", "SKW", "HFC", "CHW",
  ],
  // UP → Tsuen Wan, DOWN → Central
  TWL: [
    "CEN", "ADM", "TST", "JOR", "YMT", "MOK", "PRE", "SSP", "CSW", "LCK",
    "MEF", "LAK", "KWF", "KWH", "TWH", "TSW",
  ],
  // Spine + LO Wu / Lok Ma Chau (branch ends both listed at north end)
  EAL: [
    "ADM", "EXC", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", "RAC", "UNI",
    "TAP", "TWO", "FAN", "SHS", "LOW", "LMC",
  ],
  // Wu Kai Sha → Tuen Mun
  TML: [
    "WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", "TAW", "HIK",
    "DIH", "KAT", "SUW", "TKW", "HOM", "HUH", "ETS", "AUS", "NAC", "MEF",
    "TWW", "KSR", "YUL", "LOP", "TIS", "SIH", "TUM",
  ],
  // North Point → LOHAS Park / Tiu Keng Leng branch
  TKL: ["NOP", "QUB", "YAT", "TIK", "TKO", "HAH", "POA", "LHP"],
  SIL: ["ADM", "OCP", "WCH", "LET", "SOH"],
  KTL: [
    "WHA", "HOM", "YMT", "MOK", "PRE", "SKM", "KOT", "LOF", "WTS", "DIH",
    "CHH", "KOB", "NTK", "KWT", "LAT", "YAT", "TIK",
  ],
  DRL: ["SUN", "DIS"],
};

/** Human labels for termini (EN / ZH). */
const CODE_LABELS = {
  HOK: { en: "Hong Kong", zh: "香港" },
  KOW: { en: "Kowloon", zh: "九龍" },
  OLY: { en: "Olympic", zh: "奧運" },
  NAC: { en: "Nam Cheong", zh: "南昌" },
  LAK: { en: "Lai King", zh: "荔景" },
  TSY: { en: "Tsing Yi", zh: "青衣" },
  SUN: { en: "Sunny Bay", zh: "欣澳" },
  TUC: { en: "Tung Chung", zh: "東涌" },
  AIR: { en: "Airport", zh: "機場" },
  AWE: { en: "AsiaWorld-Expo", zh: "博覽館" },
  KET: { en: "Kennedy Town", zh: "堅尼地城" },
  HKU: { en: "HKU", zh: "香港大學" },
  SYP: { en: "Sai Ying Pun", zh: "西營盤" },
  SHW: { en: "Sheung Wan", zh: "上環" },
  CEN: { en: "Central", zh: "中環" },
  ADM: { en: "Admiralty", zh: "金鐘" },
  WAC: { en: "Wan Chai", zh: "灣仔" },
  CAB: { en: "Causeway Bay", zh: "銅鑼灣" },
  TIH: { en: "Tin Hau", zh: "天后" },
  FOH: { en: "Fortress Hill", zh: "炮台山" },
  NOP: { en: "North Point", zh: "北角" },
  QUB: { en: "Quarry Bay", zh: "鰂魚涌" },
  TAK: { en: "Tai Koo", zh: "太古" },
  SWH: { en: "Sai Wan Ho", zh: "西灣河" },
  SKW: { en: "Shau Kei Wan", zh: "筲箕灣" },
  HFC: { en: "Heng Fa Chuen", zh: "杏花邨" },
  CHW: { en: "Chai Wan", zh: "柴灣" },
  TST: { en: "Tsim Sha Tsui", zh: "尖沙咀" },
  JOR: { en: "Jordan", zh: "佐敦" },
  YMT: { en: "Yau Ma Tei", zh: "油麻地" },
  MOK: { en: "Mong Kok", zh: "旺角" },
  PRE: { en: "Prince Edward", zh: "太子" },
  SSP: { en: "Sham Shui Po", zh: "深水埗" },
  CSW: { en: "Cheung Sha Wan", zh: "長沙灣" },
  LCK: { en: "Lai Chi Kok", zh: "荔枝角" },
  MEF: { en: "Mei Foo", zh: "美孚" },
  KWF: { en: "Kwai Fong", zh: "葵芳" },
  KWH: { en: "Kwai Hing", zh: "葵興" },
  TWH: { en: "Tai Wo Hau", zh: "大窩口" },
  TSW: { en: "Tsuen Wan", zh: "荃灣" },
  EXC: { en: "Exhibition Centre", zh: "會展" },
  HUH: { en: "Hung Hom", zh: "紅磡" },
  MKK: { en: "Mong Kok East", zh: "旺角東" },
  KOT: { en: "Kowloon Tong", zh: "九龍塘" },
  TAW: { en: "Tai Wai", zh: "大圍" },
  SHT: { en: "Sha Tin", zh: "沙田" },
  FOT: { en: "Fo Tan", zh: "火炭" },
  RAC: { en: "Racecourse", zh: "馬場" },
  UNI: { en: "University", zh: "大學" },
  TAP: { en: "Tai Po Market", zh: "大埔墟" },
  TWO: { en: "Tai Wo", zh: "太和" },
  FAN: { en: "Fanling", zh: "粉嶺" },
  SHS: { en: "Sheung Shui", zh: "上水" },
  LOW: { en: "Lo Wu", zh: "羅湖" },
  LMC: { en: "Lok Ma Chau", zh: "落馬洲" },
  WKS: { en: "Wu Kai Sha", zh: "烏溪沙" },
  MOS: { en: "Ma On Shan", zh: "馬鞍山" },
  HEO: { en: "Heng On", zh: "恆安" },
  TSH: { en: "Tai Shui Hang", zh: "大水坑" },
  SHM: { en: "Shek Mun", zh: "石門" },
  CIO: { en: "City One", zh: "第一城" },
  STW: { en: "Sha Tin Wai", zh: "沙田圍" },
  CKT: { en: "Che Kung Temple", zh: "車公廟" },
  HIK: { en: "Hin Keng", zh: "顯徑" },
  DIH: { en: "Diamond Hill", zh: "鑽石山" },
  KAT: { en: "Kai Tak", zh: "啟德" },
  SUW: { en: "Sung Wong Toi", zh: "宋皇臺" },
  TKW: { en: "To Kwa Wan", zh: "土瓜灣" },
  HOM: { en: "Ho Man Tin", zh: "何文田" },
  ETS: { en: "East Tsim Sha Tsui", zh: "尖東" },
  AUS: { en: "Austin", zh: "柯士甸" },
  TWW: { en: "Tsuen Wan West", zh: "荃灣西" },
  KSR: { en: "Kam Sheung Road", zh: "錦上路" },
  YUL: { en: "Yuen Long", zh: "元朗" },
  LOP: { en: "Long Ping", zh: "朗屏" },
  TIS: { en: "Tin Shui Wai", zh: "天水圍" },
  SIH: { en: "Siu Hong", zh: "兆康" },
  TUM: { en: "Tuen Mun", zh: "屯門" },
  YAT: { en: "Yau Tong", zh: "油塘" },
  TIK: { en: "Tiu Keng Leng", zh: "調景嶺" },
  TKO: { en: "Tseung Kwan O", zh: "將軍澳" },
  HAH: { en: "Hang Hau", zh: "坑口" },
  POA: { en: "Po Lam", zh: "寶琳" },
  LHP: { en: "LOHAS Park", zh: "康城" },
  OCP: { en: "Ocean Park", zh: "海洋公園" },
  WCH: { en: "Wong Chuk Hang", zh: "黃竹坑" },
  LET: { en: "Lei Tung", zh: "利東" },
  SOH: { en: "South Horizons", zh: "海怡半島" },
  WHA: { en: "Whampoa", zh: "黃埔" },
  SKM: { en: "Shek Kip Mei", zh: "石硤尾" },
  LOF: { en: "Lok Fu", zh: "樂富" },
  WTS: { en: "Wong Tai Sin", zh: "黃大仙" },
  CHH: { en: "Choi Hung", zh: "彩虹" },
  KOB: { en: "Kowloon Bay", zh: "九龍灣" },
  NTK: { en: "Ngau Tau Kok", zh: "牛頭角" },
  KWT: { en: "Kwun Tong", zh: "觀塘" },
  LAT: { en: "Lam Tin", zh: "藍田" },
  DIS: { en: "Disneyland Resort", zh: "迪士尼" },
};

/**
 * @param {string} code
 * @returns {{ en: string, zh: string }}
 */
export function mtrStationLabel(code) {
  const c = String(code || "").toUpperCase();
  return CODE_LABELS[c] || { en: c, zh: c };
}

/**
 * Two travel bounds for a line (O ≈ API UP / toward order end, I ≈ DOWN).
 * @param {string} lineId
 * @returns {Array<{ dest: string, destZh?: string, bound: string, orig?: string, origZh?: string }>}
 */
export function mtrLineDirections(lineId) {
  const line = String(lineId || "").toUpperCase();
  const order = MTR_LINE_ORDER[line];
  if (!order?.length) {
    return [{ dest: line || "—", bound: "line" }];
  }
  // Prefer meaningful termini (skip LMC as sole "end" when LOW is also listed)
  let endCode = order[order.length - 1];
  let startCode = order[0];
  if (line === "EAL") {
    // Show LO Wu as primary north terminus (Lok Ma Chau is alternate)
    endCode = "LOW";
  }
  if (line === "TKL") {
    // Main Po Lam vs LOHAS — Po Lam is classic main terminus
    endCode = "POA";
  }
  const start = mtrStationLabel(startCode);
  const end = mtrStationLabel(endCode);
  return [
    {
      bound: "O",
      dest: end.en,
      destZh: end.zh,
      orig: start.en,
      origZh: start.zh,
    },
    {
      bound: "I",
      dest: start.en,
      destZh: start.zh,
      orig: end.en,
      origZh: end.zh,
    },
  ];
}

/**
 * Ordered station codes for a line bound.
 * @param {string} lineId
 * @param {string} [bound] O|I|UP|DOWN|line
 * @returns {string[]}
 */
export function mtrLineCodesInOrder(lineId, bound = "O") {
  const line = String(lineId || "").toUpperCase();
  const order = MTR_LINE_ORDER[line];
  if (!order?.length) return [];
  const b = String(bound || "O").toUpperCase();
  const reverse =
    b === "I" || b === "DOWN" || b === "INBOUND" || b === "2";
  return reverse ? [...order].reverse() : [...order];
}
