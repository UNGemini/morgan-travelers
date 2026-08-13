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
import { sameOriginCors } from "../../_shared/security.js";

function authCors(request) {
  return sameOriginCors(request, {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

function json(request, status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...authCors(request),
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
  const id = String(env?.GITHUB_OAUTH_CLIENT_ID || "").trim();
  const secret = String(env?.GITHUB_OAUTH_CLIENT_SECRET || "").trim();
  return !!(id && secret);
}

/** Safe debug flags (never include secret values). */
function oauthEnvFlags(env) {
  const e = env || {};
  return {
    has_client_id: !!String(e.GITHUB_OAUTH_CLIENT_ID || "").trim(),
    has_client_secret: !!String(e.GITHUB_OAUTH_CLIENT_SECRET || "").trim(),
    has_redirect_uri: !!String(e.GITHUB_OAUTH_REDIRECT_URI || "").trim(),
  };
}

/** Same-origin path only — never protocol-relative or off-site. */
function safeReturnPath(raw) {
  const s = String(raw || "/");
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\") || s.includes("://")) {
    return "/";
  }
  return s;
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
    return new Response(null, {
      status: 204,
      headers: sameOriginCors(request, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Credentials": "true",
        "Cross-Origin-Resource-Policy": "same-origin",
      }),
    });
  }

  // path after /api/auth/
  const rest = url.pathname.replace(/^\/api\/auth\/?/, "").replace(/\/$/, "");
  const action = rest.split("/")[0] || "";

  // ── me ────────────────────────────────────────────────────────────
  if (action === "me" && request.method === "GET") {
    const flags = oauthEnvFlags(env);
    const configured = oauthConfigured(env || {});
    const sess = parseSessionCookie(request.headers.get("Cookie"));
    if (!sess) {
      return json(request, 200, {
        logged_in: false,
        oauth_configured: configured,
        ...flags,
      });
    }
    return json(request, 200, {
      logged_in: true,
      login: sess.login,
      name: sess.name || sess.login,
      avatar: sess.avatar || "",
      oauth_configured: configured,
      ...flags,
    });
  }

  // ── logout ────────────────────────────────────────────────────────
  if (action === "logout" && (request.method === "POST" || request.method === "GET")) {
    return json(
      request,
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
      return json(request, 503, {
        ok: false,
        error:
          "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.",
      });
    }
    const state = crypto.randomUUID().replace(/-/g, "");
    const returnTo = safeReturnPath(url.searchParams.get("return_to") || "/");
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
      return json(request, 503, { ok: false, error: "OAuth not configured" });
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return json(request, 400, { ok: false, error: "Missing code/state" });
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
          return json(request, 400, { ok: false, error: "Invalid OAuth state" });
        }
        if (data.returnTo) returnTo = safeReturnPath(data.returnTo);
      }
    } catch {
      return json(request, 400, { ok: false, error: "Invalid OAuth state cookie" });
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
      return json(request, 400, {
        ok: false,
        error: tokenJson.error_description || tokenJson.error || "Token exchange failed",
      });
    }

    const me = await fetchGithubUser(tokenJson.access_token);
    if (!me.ok) {
      return json(request, 400, { ok: false, error: "Could not load GitHub user" });
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

  return json(request, 404, { ok: false, error: "Unknown auth route", action });
}
