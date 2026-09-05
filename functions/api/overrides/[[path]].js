/**
 * Same-origin bus-shapes proxy (COEP-safe).
 *
 * GET /api/overrides/bus-shapes.json
 *   → https://raw.githubusercontent.com/<OVERRIDES_REPO>/<branch>/bus-shapes.json
 * GET /api/overrides/bus-shapes/index.json, /api/overrides/bus-shapes/<id>.json
 *   → same path in the overrides repo (split published store)
 *
 * Env:
 *   OVERRIDES_REPO = owner/name (default UNGemini/morgan-travelers-overrides)
 *   OVERRIDES_BRANCH = branch (default main)
 */

const DEFAULT_REPO = "UNGemini/morgan-travelers-overrides";
const DEFAULT_BRANCH = "main";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...extra,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const rest = url.pathname
    .replace(/^\/api\/overrides\/?/, "")
    .replace(/\/$/, "");

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders({
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
      }),
    });
  }

  // Bus-shapes blob + the split published store (index / per-route files);
  // status/pending stay local-dev via Vite
  if (rest !== "bus-shapes.json" && !/^bus-shapes\/[A-Za-z0-9._-]+\.json$/.test(rest)) {
    return new Response(JSON.stringify({ error: "not found", path: rest }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(),
      },
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const repo = String(env?.OVERRIDES_REPO || DEFAULT_REPO).trim() || DEFAULT_REPO;
  const branch =
    String(env?.OVERRIDES_BRANCH || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  // Cache-bust lightly via GitHub; edge still caches briefly via CF
  const target = `https://raw.githubusercontent.com/${repo}/${branch}/${rest}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MORGAN-Travelers/0.4 (overrides-proxy)",
      },
      cf: {
        // Revalidate often so merges show up within ~1–2 minutes
        cacheTtl: 60,
        cacheEverything: true,
      },
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({
          error: "upstream failed",
          status: upstream.status,
          url: target,
        }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders({ "Cache-Control": "no-store" }),
          },
        },
      );
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: corsHeaders({
        "Content-Type": "application/json; charset=utf-8",
        // Browser: revalidate quickly; CDN: short edge cache
        "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
        "X-Overrides-Source": target,
      }),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: "fetch failed",
        message: String(e?.message || e),
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders({ "Cache-Control": "no-store" }),
        },
      },
    );
  }
}
