/**
 * Cloudflare Pages Function — OSRM proxy for bus route densification.
 *
 * Coordinates live in `?coordinates=` (pipe-separated) so the path never
 * contains `;`. Cloudflare WAF 403s `/driving/lon,lat;lon,lat`, and the
 * old allowlist rejected `%3B`, so production snaps always fell back to
 * GTFS kites at roundabouts.
 *
 * Allowlisted: /osrm/{route|nearest|match}/v1/driving?coordinates=…
 */
import {
  foreignOriginResponse,
  sameOriginCors,
} from "../_shared/security.js";

const OSRM_SERVICE = /^\/(route|nearest|match)\/v1\/driving\/?$/;
const COORDS_OK =
  /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?(?:\|-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)*$/;

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
  const service = path.match(OSRM_SERVICE);
  const coords = (url.searchParams.get("coordinates") || "").replace(
    /;/g,
    "|",
  );
  if (!service || path.includes("..") || !COORDS_OK.test(coords)) {
    return Response.json(
      { ok: false, error: "unknown osrm route" },
      { status: 404, headers: cors },
    );
  }

  const kind = service[1];
  const coordPath = coords.replace(/\|/g, ";");
  const target = new URL(
    `https://router.project-osrm.org/${kind}/v1/driving/${coordPath}`,
  );
  for (const [k, v] of url.searchParams) {
    if (k === "coordinates") continue;
    if (k === "radiuses") {
      target.searchParams.set(k, v.replace(/[|,]/g, ";"));
    } else {
      target.searchParams.set(k, v);
    }
  }

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
