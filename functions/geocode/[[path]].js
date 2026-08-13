/**
 * Cloudflare Pages Function — Nominatim proxy (COEP-safe same-origin geocode).
 * Routes: /geocode/search , /geocode/reverse
 */
import {
  foreignOriginResponse,
  sameOriginCors,
} from "../_shared/security.js";

const ALLOWED = new Set(["/search", "/reverse"]);
const MAX_QS = 2000;

export async function onRequest(context) {
  const req = context.request;
  const blocked = foreignOriginResponse(req);
  if (blocked) return blocked;

  const cors = sameOriginCors(req, {
    "Cross-Origin-Resource-Policy": "same-origin",
  });

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
      },
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/geocode/, "") || "/";
  if (!ALLOWED.has(path)) {
    return new Response(JSON.stringify({ ok: false, error: "unknown geocode route" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }
  if (url.search.length > MAX_QS) {
    return new Response(JSON.stringify({ ok: false, error: "query too long" }), {
      status: 414,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    });
  }

  const target = new URL(`https://nominatim.openstreetmap.org${path}`);
  target.search = url.search;

  const res = await fetch(target.toString(), {
    method: req.method,
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
      ...cors,
    },
  });
}
