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

export async function onRequest(context) {
  const req = context.request;
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // /eta/kmb/stop-eta/XXX  → path parts after /eta/
  const rest = url.pathname.replace(/^\/eta\/?/, "");
  const slash = rest.indexOf("/");
  const op = (slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase();
  const sub = slash >= 0 ? rest.slice(slash) : "";
  const base = TARGETS[op];
  if (!base) {
    return new Response(JSON.stringify({ error: "unknown eta operator", op }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...CORS,
      },
    });
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

  const res = await fetch(target.toString(), init);
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control":
        req.method === "GET" ? "public, max-age=15" : "no-store",
      ...CORS,
    },
  });
}
