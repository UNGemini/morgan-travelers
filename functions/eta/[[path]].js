/**
 * Cloudflare Pages Function — HK open-data ETA proxy (COEP-safe).
 *
 * /eta/kmb/*      → https://data.etabus.gov.hk/v1/transport/kmb/*
 * /eta/ctb/*      → https://rt.data.gov.hk/v2/transport/citybus/*
 * /eta/nlb/*      → https://rt.data.gov.hk/v2/transport/nlb/*
 * /eta/mtr/*      → https://rt.data.gov.hk/v1/transport/mtr/*
 * /eta/gmb/*      → https://data.etagmb.gov.hk/*
 * /eta/mtr-open/* → https://opendata.mtr.com.hk/*
 *
 * POST is required for MTR Bus getSchedule:
 *   POST /eta/mtr/bus/getSchedule  { language, routeName }
 */

const TARGETS = {
  kmb: "https://data.etabus.gov.hk/v1/transport/kmb",
  ctb: "https://rt.data.gov.hk/v2/transport/citybus",
  nlb: "https://rt.data.gov.hk/v2/transport/nlb",
  mtr: "https://rt.data.gov.hk/v1/transport/mtr",
  gmb: "https://data.etagmb.gov.hk",
  "mtr-open": "https://opendata.mtr.com.hk",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/** Header joining a client request to this proxy across the boundary. */
const CORRELATION_HEADER = "x-correlation-id";

/**
 * Reuse a well-formed client correlation id, else mint one for the request.
 * @param {Request} req
 */
function correlationId(req) {
  const provided = req.headers.get(CORRELATION_HEADER);
  return provided && /^[A-Za-z0-9._:-]{1,64}$/.test(provided)
    ? provided
    : `eta-${crypto.randomUUID()}`;
}

/** Structured JSON failure with the correlation id echoed in header + body. */
function jsonError(body, status, correlation) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      [CORRELATION_HEADER]: correlation,
      ...CORS,
    },
  });
}

export async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);
  const correlation = correlationId(req);
  const corsHeaders = { ...CORS, [CORRELATION_HEADER]: correlation };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // /eta/kmb/stop-eta/XXX  → path parts after /eta/
  const rest = url.pathname.replace(/^\/eta\/?/, "");
  const slash = rest.indexOf("/");
  const op = (slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase();
  const sub = slash >= 0 ? rest.slice(slash) : "";
  const base = TARGETS[op];
  if (!base) {
    return jsonError(
      { ok: false, error: "unknown eta operator", op, correlationId: correlation },
      404,
      correlation,
    );
  }

  const target = new URL(`${base}${sub || ""}`);
  target.search = url.search;

  /** @type {RequestInit} */
  const init = {
    method: req.method,
    headers: {
      Accept: req.headers.get("Accept") || "application/json",
      "User-Agent": "MORGAN-Travelers/0.4 (https://morgandev.cc)",
    },
  };

  // Forward POST/PUT body (MTR Bus getSchedule)
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = req.headers.get("Content-Type");
    if (ct) init.headers["Content-Type"] = ct;
    init.body = await req.arrayBuffer();
  }

  let res;
  try {
    res = await fetch(target.toString(), init);
  } catch (error) {
    // Upstream unreachable — structured, joinable failure instead of an opaque 500.
    return jsonError(
      {
        ok: false,
        error: "upstream_request_failed",
        message: String(error?.message ?? error),
        operator: op,
        correlationId: correlation,
      },
      502,
      correlation,
    );
  }

  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control":
        req.method === "GET" ? "public, max-age=15" : "no-store",
      ...corsHeaders,
    },
  });
}
