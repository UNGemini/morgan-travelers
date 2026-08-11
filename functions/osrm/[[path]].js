/**
 * Cloudflare Pages Function — OSRM proxy for bus route densification.
 * /osrm/* → https://router.project-osrm.org/*
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/osrm/, "") || "/";
  const target = new URL(`https://router.project-osrm.org${path}`);
  target.search = url.search;

  // The public demo server is slow — cap the upstream so a hung request
  // becomes a fast structured 504 instead of a stuck worker.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(target.toString(), {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch {
    return Response.json(
      { ok: false, error: "osrm upstream unavailable" },
      {
        status: 504,
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      },
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
