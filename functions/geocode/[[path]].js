/**
 * Cloudflare Pages Function — Nominatim proxy (COEP-safe same-origin geocode).
 * Routes: /geocode/search , /geocode/reverse
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/geocode/, "") || "/";
  const target = new URL(`https://nominatim.openstreetmap.org${path}`);
  target.search = url.search;

  const res = await fetch(target.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "MORGAN-Travelers/0.4 (https://morgandev.cc)",
    },
  });

  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
