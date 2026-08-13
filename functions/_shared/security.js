/**
 * Same-origin helpers for Pages Functions.
 * The PWA is first-party; these endpoints must not be an open CORS proxy.
 */

/**
 * @param {Request} request
 * @returns {string} request origin (scheme + host)
 */
export function requestOrigin(request) {
  return new URL(request.url).origin;
}

/**
 * True when the browser Origin (or Referer) matches this worker.
 * Missing Origin is treated as non-CORS (same-origin navigation, curl).
 * @param {Request} request
 */
export function isSameOriginRequest(request) {
  const here = requestOrigin(request);
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      return new URL(origin).origin === here;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin === here;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * CORS headers only for same-origin browsers. Foreign origins get nothing,
 * so the response is unreadable and credentialed cookies stay first-party.
 * @param {Request} request
 * @param {Record<string, string>} [extra]
 */
export function sameOriginCors(request, extra = {}) {
  const origin = request.headers.get("Origin");
  if (!origin) return { ...extra };
  try {
    if (new URL(origin).origin === requestOrigin(request)) {
      return {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        ...extra,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...extra };
}

/**
 * 403 when a cross-site page is calling us. Same-origin fetch always sends
 * a matching Origin. Used on state-changing / quota-sensitive routes.
 * @param {Request} request
 */
export function foreignOriginResponse(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (isSameOriginRequest(request)) return null;
  return new Response(JSON.stringify({ ok: false, error: "forbidden origin" }), {
    status: 403,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
