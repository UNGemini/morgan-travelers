/**
 * Cloudflare Pages Function — HK open-data ETA proxy (COEP-safe).
 *
 * /eta/kmb/*      → https://data.etabus.gov.hk/v1/transport/kmb/*
 * /eta/ctb/*      → https://rt.data.gov.hk/v2/transport/citybus/*
 * /eta/nlb/*      → https://rt.data.gov.hk/v2/transport/nlb/*
 * /eta/mtr/*      → https://rt.data.gov.hk/v1/transport/mtr/*
 * /eta/gmb/*      → https://data.etagmb.gov.hk/*
 * /eta/mtr-open/* → https://opendata.mtr.com.hk/*
 */

const TARGETS = {
  kmb: "https://data.etabus.gov.hk/v1/transport/kmb",
  ctb: "https://rt.data.gov.hk/v2/transport/citybus",
  nlb: "https://rt.data.gov.hk/v2/transport/nlb",
  mtr: "https://rt.data.gov.hk/v1/transport/mtr",
  gmb: "https://data.etagmb.gov.hk",
  "mtr-open": "https://opendata.mtr.com.hk",
};

export async function onRequest(context) {
  const url = new URL(context.request.url);
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
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  const target = new URL(`${base}${sub || ""}`);
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
      "Cache-Control": "public, max-age=15",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
