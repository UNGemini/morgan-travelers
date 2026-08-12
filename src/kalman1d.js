/**
 * 1-D discrete Kalman filter for the Live Bus Position Engine (PRD 4.2).
 *
 * State: [s, v] — metres along the route shape, metres/second.
 * Model: constant velocity, F = [[1, dt], [0, 1]].
 *
 * Pure JS on purpose: a 2x2 filter is trivial math and WASM would only add
 * a build pipeline for zero perceptible gain at a 1 Hz tick. The class is
 * self-contained so it can be swapped for a WASM kernel later without
 * touching callers.
 */

/**
 * @typedef {{ s: number, v: number, sigmaM: number, trust: number }} KalmanState
 */

/** Clamp a scalar into [lo, hi]. */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export class Kalman1D {
  /**
   * @param {object} [cfg]
   * @param {number} [cfg.qAccelM] process-noise std dev of acceleration (m/s^2)
   * @param {number} [cfg.rM] measurement noise std dev (m)
   * @param {number} [cfg.vMax] velocity clamp (m/s) — bus speeds
   */
  constructor(cfg = {}) {
    this.qAccelM = cfg.qAccelM ?? 0.25; // ~typical bus acceleration jitter
    this.rM = cfg.rM ?? 120; // ~1 min of travel at 7 m/s (ETA quantization)
    this.vMax = cfg.vMax ?? 22; // ~80 km/h
    this.reset();
  }

  reset() {
    this.s = 0;
    this.v = 0;
    /** @type {[number, number, number, number]} P covariance [[p00,p01],[p10,p11]] */
    this.p = [1000, 0, 0, 100];
    this.lastDt = 0;
    this.coasting = false;
    this.pinned = false;
    this.updatedAt = 0;
  }

  /**
   * Advance the estimate by dt seconds (constant-velocity transition).
   * Traffic multiplier scales process noise: congested roads make the model
   * less certain, so measurements are trusted relatively more.
   * @param {number} dt seconds
   * @param {number} [trafficMult] 1 = nominal, <1 congested, >1 free-flow
   */
  predict(dt, trafficMult = 1) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const m = clamp(Number(trafficMult) || 1, 0.3, 1.6);
    // Process noise from acceleration std dev, inflated when traffic deviates
    // from the nominal model (both congested and free-flow add uncertainty).
    const q = Math.pow(this.qAccelM * (1 + Math.abs(1 - m)), 2);
    const dt2 = dt * dt;
    const p00 = this.p[0] + 2 * this.p[1] * dt + this.p[3] * dt2 + q * (dt2 * dt2) / 4;
    const p01 = this.p[1] + this.p[3] * dt + q * (dt * dt2) / 2;
    const p10 = p01;
    const p11 = this.p[3] + q * dt2;
    this.p = [p00, p01, p10, p11];
    this.s += this.v * dt;
    this.v = clamp(this.v, -this.vMax, this.vMax);
    this.coasting = false;
    this.lastDt = dt;
    this.updatedAt = Date.now();
  }

  /**
   * Seed the filter with a first observation (new track). When the chain
   * implies a speed (ETA deltas between stops), seed it too — a zero velocity
   * start makes the first polls lag by a full minute of travel.
   * @param {number} sMeas metres along shape
   * @param {number} [sigmaM]
   * @param {number} [vHint] ETA-implied speed (m/s), if the chain knows it
   */
  init(sMeas, sigmaM, vHint) {
    this.s = Number.isFinite(sMeas) ? sMeas : 0;
    this.v = clamp(
      Number.isFinite(vHint) && vHint > 0 ? vHint : 0,
      0,
      this.vMax,
    );
    const sigma = Number.isFinite(sigmaM) && sigmaM > 0 ? sigmaM : this.rM;
    const p00 = sigma * sigma;
    const p11 = this.v > 0 ? Math.pow(this.v / 2, 2) : Math.pow(this.vMax / 2, 2);
    this.p = [p00, 0, 0, p11];
    this.lastDt = 0;
    this.coasting = false;
    this.pinned = false;
    this.updatedAt = Date.now();
  }

  /**
   * Incorporate a position observation (metres along shape).
   * @param {number} sMeas
   * @param {number} [sigmaM] override measurement noise for this update
   * @returns {number} innovation (sMeas − predicted s), for gating
   */
  update(sMeas, sigmaM) {
    if (!Number.isFinite(sMeas)) return NaN;
    const r = Number.isFinite(sigmaM) && sigmaM > 0 ? sigmaM * sigmaM : this.rM * this.rM;
    const p00r = this.p[0] + r;
    if (p00r <= 0) return NaN;
    const k0 = this.p[0] / p00r;
    const k1 = this.p[1] / p00r;
    const innov = sMeas - this.s;
    this.s += k0 * innov;
    this.v += k1 * innov;
    this.v = clamp(this.v, -this.vMax, this.vMax);
    this.p = [
      this.p[0] * (1 - k0),
      this.p[1] * (1 - k0),
      this.p[1] * (1 - k0),
      this.p[3] - k1 * this.p[1],
    ];
    this.pinned = false;
    this.updatedAt = Date.now();
    return innov;
  }

  /**
   * Coast mode (network drop): predict-only until connectivity resumes.
   * Call predict() repeatedly; the estimate keeps moving at the last
   * velocity while uncertainty grows.
   */
  coast() {
    this.coasting = true;
  }

  /**
   * Hard-pin the position (e.g. terminal layover: bus at the first stop
   * with ETA > 0 must not creep forward). Velocity zeroed.
   * @param {number} s metres along shape
   */
  pin(s) {
    this.s = Number.isFinite(s) ? s : 0;
    this.v = 0;
    this.p = [10, 0, 0, 4]; // tight but not absolute — future updates can pull
    this.pinned = true;
    this.updatedAt = Date.now();
  }

  /**
   * Innovation gate: is a new observation consistent with the current
   * estimate (within 3 sigma)?
   * @param {number} sMeas
   * @param {number} [sigmaM]
   * @returns {boolean}
   */
  gates(sMeas, sigmaM) {
    if (!Number.isFinite(sMeas)) return false;
    const r = Number.isFinite(sigmaM) && sigmaM > 0 ? sigmaM * sigmaM : this.rM * this.rM;
    const sigma = Math.sqrt(this.p[0] + r);
    return Math.abs(sMeas - this.s) <= 3 * sigma;
  }

  /**
   * Snapshot for callers / markers.
   * @returns {KalmanState}
   */
  state() {
    return { s: this.s, v: this.v, sigmaM: Math.sqrt(this.p[0]), trust: this.coasting ? 0.35 : 1 };
  }
}
