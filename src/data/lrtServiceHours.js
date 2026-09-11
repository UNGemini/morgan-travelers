/**
 * Light Rail service hours — first and last train per route, in minutes since
 * midnight, with a last train after midnight counted past 1440 (01:25 → 1525).
 *
 * MTR publishes no LRT timetable as open data and no headways anywhere: the
 * only public source is the schedule page below, which lists first/last train
 * per station. These are the maxima of those tables, and the engine uses them
 * for one thing only — to stop synthetic ("fill") trains when the real service
 * ends. Frequency still comes from the live feed (see mtrHeadwayInfo).
 *
 * Source: https://www.mtr.com.hk/en/customer/services/schedule_index.html
 * Extracted 2026-09-12. The page warns its times change without notice, so
 * refresh this by re-reading the Light Rail tables when the timetable season
 * changes.
 */
export const LRT_SERVICE_HOURS = {
  "505": { firstMins: 326, lastMins: 1535 },
  "507": { firstMins: 324, lastMins: 1528 },
  "610": { firstMins: 320, lastMins: 1533 },
  "614": { firstMins: 317, lastMins: 1524 },
  "614P": { firstMins: 337, lastMins: 1532 },
  "615": { firstMins: 318, lastMins: 1511 },
  "615P": { firstMins: 331, lastMins: 1534 },
  "705": { firstMins: 311, lastMins: 1525 },
  "706": { firstMins: 320, lastMins: 1533 },
  "751": { firstMins: 320, lastMins: 1531 },
  "761P": { firstMins: 326, lastMins: 1529 },
};

/**
 * Last train for an LRT route in minutes since midnight (>1440 after
 * midnight), or 0 when the route is unknown.
 * @param {string} routeShort
 */
export function lrtLastMins(routeShort) {
  const row = LRT_SERVICE_HOURS[String(routeShort || "").trim().toUpperCase()];
  return row ? row.lastMins : 0;
}
