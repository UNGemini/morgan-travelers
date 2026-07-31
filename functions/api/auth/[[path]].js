/**
 * GitHub OAuth for contribute (serverless Pages Function).
 *
 * GET  /api/auth/github          → redirect to GitHub authorize
 * GET  /api/auth/callback        → exchange code, set session cookie
 * GET  /api/auth/me              → { logged_in, login, avatar, name }
 * POST /api/auth/logout          → clear cookie
 *
 * Env:
 *   GITHUB_OAUTH_CLIENT_ID
 *   GITHUB_OAUTH_CLIENT_SECRET
 *   GITHUB_OAUTH_REDIRECT_URI  (optional — defaults from request URL)
 */

import {
  COOKIE_NAME,
  b64encode,
  b64decode,
  parseSessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  fetchGithubUser,
} from "../../_shared/github.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
      ...extraHeaders,
    },
  });
}

function redirect(url, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function isSecureRequest(request) {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  const xf = request.headers.get("x-forwarded-proto");
  return xf === "https";
}

function oauthConfigured(env) {
  return !!(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
}

function redirectUri(request, env) {
  if (env.GITHUB_OAUTH_REDIRECT_URI) return String(env.GITHUB_OAUTH_REDIRECT_URI);
  const url = new URL(request.url);
  return `${url.origin}/api/auth/callback`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // path after /api/auth/
  const rest = url.pathname.replace(/^\/api\/auth\/?/, "").replace(/\/$/, "");
  const action = rest.split("/")[0] || "";

  // ── me ────────────────────────────────────────────────────────────
  if (action === "me" && request.method === "GET") {
    const sess = parseSessionCookie(request.headers.get("Cookie"));
    if (!sess) {
      return json(200, {
        logged_in: false,
        oauth_configured: oauthConfigured(env || {}),
      });
    }
    return json(200, {
      logged_in: true,
      login: sess.login,
      name: sess.name || sess.login,
      avatar: sess.avatar || "",
      oauth_configured: oauthConfigured(env || {}),
    });
  }

  // ── logout ────────────────────────────────────────────────────────
  if (action === "logout" && (request.method === "POST" || request.method === "GET")) {
    return json(
      200,
      { ok: true, logged_in: false },
      {
        "Set-Cookie": clearSessionCookieHeader({
          secure: isSecureRequest(request),
        }),
      },
    );
  }

  // ── github (start OAuth) ──────────────────────────────────────────
  if ((action === "github" || action === "login") && request.method === "GET") {
    if (!oauthConfigured(env || {})) {
      return json(503, {
        ok: false,
        error:
          "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.",
      });
    }
    const state = crypto.randomUUID().replace(/-/g, "");
    const returnTo = url.searchParams.get("return_to") || "/";
    // store state in short-lived cookie
    const stateCookie = [
      `morgan_gh_state=${encodeURIComponent(
        b64encode(JSON.stringify({ state, returnTo, exp: Date.now() + 600_000 })),
      )}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=600",
    ];
    if (isSecureRequest(request)) stateCookie.push("Secure");

    const params = new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(request, env),
      scope: "public_repo read:user",
      state,
    });
    return redirect(`https://github.com/login/oauth/authorize?${params}`, {
      "Set-Cookie": stateCookie.join("; "),
    });
  }

  // ── callback ──────────────────────────────────────────────────────
  if (action === "callback" && request.method === "GET") {
    if (!oauthConfigured(env || {})) {
      return json(503, { ok: false, error: "OAuth not configured" });
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return json(400, { ok: false, error: "Missing code/state" });
    }

    // verify state cookie
    let returnTo = "/";
    try {
      const raw = (request.headers.get("Cookie") || "")
        .split(/;\s*/)
        .find((p) => p.startsWith("morgan_gh_state="));
      if (raw) {
        const data = JSON.parse(
          b64decode(decodeURIComponent(raw.slice("morgan_gh_state=".length))),
        );
        if (data.state !== state || (data.exp && Date.now() > data.exp)) {
          return json(400, { ok: false, error: "Invalid OAuth state" });
        }
        if (data.returnTo && String(data.returnTo).startsWith("/")) {
          returnTo = data.returnTo;
        }
      }
    } catch {
      return json(400, { ok: false, error: "Invalid OAuth state cookie" });
    }

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri(request, env),
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      return json(400, {
        ok: false,
        error: tokenJson.error_description || tokenJson.error || "Token exchange failed",
      });
    }

    const me = await fetchGithubUser(tokenJson.access_token);
    if (!me.ok) {
      return json(400, { ok: false, error: "Could not load GitHub user" });
    }

    const sessHeader = sessionCookieHeader(
      {
        token: tokenJson.access_token,
        login: me.login,
        avatar: me.avatar,
        name: me.name,
      },
      { secure: isSecureRequest(request) },
    );
    const clearState = [
      "morgan_gh_state=",
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
    ];
    if (isSecureRequest(request)) clearState.push("Secure");

    const dest = new URL(returnTo, url.origin);
    dest.searchParams.set("gh_login", "1");
    const headers = new Headers({
      Location: dest.pathname + dest.search + dest.hash,
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", sessHeader);
    headers.append("Set-Cookie", clearState.join("; "));
    return new Response(null, { status: 302, headers });
  }

  return json(404, { ok: false, error: "Unknown auth route", action });
}
