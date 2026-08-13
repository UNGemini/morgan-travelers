/**
 * Cloudflare Pages Function — OSRM proxy for bus route densification.
 * Allowlisted: /osrm/{route|nearest|match}/v1/driving/…
 */
import {
  foreignOriginResponse,
  sameOriginCors,
} from "../_shared/security.js";

const OSRM_PATH =
  /^\/(route|nearest|match)\/v1\/driving\/[0-9.\-;,]+$/;

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
        "Access-Control-Allow-Headers": "Accept",
      },
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json(
      { ok: false, error: "method not allowed" },
      { status: 405, headers: cors },
    );
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/osrm/, "") || "/";
  if (!OSRM_PATH.test(path) || path.includes("..")) {
    return Response.json(
      { ok: false, error: "unknown osrm route" },
      { status: 404, headers: cors },
    );
  }

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
          ...cors,
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
      ...cors,
    },
  });
}
