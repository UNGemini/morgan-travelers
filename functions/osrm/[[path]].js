/**
 * Cloudflare Pages Function — OSRM proxy for bus route densification.
 * /osrm/* → https://router.project-osrm.org/*
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/osrm/, "") || "/";
  const target = new URL(`https://router.project-osrm.org${path}`);
  target.search = url.search;

  const res = await fetch(target.toString(), {
    headers: { Accept: "application/json" },
  });
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
