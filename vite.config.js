import { defineConfig, loadEnv } from "vite";

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  openOverridesPullRequest,
  fetchGithubUser,
  b64encode,
  b64decode,
  DEFAULT_OVERRIDES_REPO,
} from "./functions/_shared/github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Dev env (process + .env.development / .env) */
function devEnv() {
  const file = loadEnv("development", __dirname, "");
  return {
    botToken:
      process.env.OVERRIDES_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      file.OVERRIDES_GITHUB_TOKEN ||
      file.GITHUB_TOKEN ||
      "",
    repo:
      process.env.OVERRIDES_REPO ||
      file.OVERRIDES_REPO ||
      DEFAULT_OVERRIDES_REPO,
    base:
      process.env.OVERRIDES_BASE_BRANCH ||
      file.OVERRIDES_BASE_BRANCH ||
      "main",
    oauthClientId:
      process.env.GITHUB_OAUTH_CLIENT_ID || file.GITHUB_OAUTH_CLIENT_ID || "",
    oauthClientSecret:
      process.env.GITHUB_OAUTH_CLIENT_SECRET ||
      file.GITHUB_OAUTH_CLIENT_SECRET ||
      "",
    oauthRedirectUri:
      process.env.GITHUB_OAUTH_REDIRECT_URI ||
      file.GITHUB_OAUTH_REDIRECT_URI ||
      "",
  };
}

function oauthConfigured(env) {
  return !!(env.oauthClientId && env.oauthClientSecret);
}

function isSecureReq(req) {
  const host = String(req.headers.host || "");
  if (host.startsWith("127.0.0.1") || host.startsWith("localhost")) return false;
  const xf = req.headers["x-forwarded-proto"];
  return xf === "https";
}

function reqOrigin(req) {
  const host = req.headers.host || "127.0.0.1:5173";
  const proto = isSecureReq(req) ? "https" : "http";
  return `${proto}://${host}`;
}

function appendSetCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, value]);
  } else {
    res.setHeader("Set-Cookie", [String(prev), value]);
  }
}

/** Sibling overrides repo (local path contributions + bus-shapes). */
function resolveOverridesRepoRoot() {
  const fromEnv = process.env.OVERRIDES_REPO_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const sibling = path.join(__dirname, "..", "morgan-travelers-overrides");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function jsonRes(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes = 400_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Inject COOP/COEP for local cross-origin isolation (WASM / SharedArrayBuffer). */
function crossOriginIsolation() {
  const isolationHeaders = (res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // require-corp matches production _headers (brief §5).
    // Edge data must send Cross-Origin-Resource-Policy: cross-origin
    // for PMTiles / graph fetches to succeed under this policy.
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  };

  /**
   * Local overrides + contribute + GitHub OAuth (mirrors Pages Functions).
   *
   * GET  /api/auth/github|callback|me  POST /api/auth/logout
   * GET  /api/overrides/status
   * GET  /api/overrides/bus-shapes.json
   * GET  /api/overrides/pending
   * POST /api/contribute-path   body.submit_mode: oauth|bot
   * POST /api/overrides/merge
   * POST /api/overrides/reload-public
   */
  async function overridesApiMiddleware(req, res, next) {
    const rawUrl = req.url || "";
    const urlPath = rawUrl.split("?")[0];
    const qs = rawUrl.includes("?")
      ? new URLSearchParams(rawUrl.slice(rawUrl.indexOf("?") + 1))
      : new URLSearchParams();

    const isAuth = urlPath.startsWith("/api/auth");
    const isOverrides =
      urlPath.startsWith("/api/contribute-path") ||
      urlPath.startsWith("/api/overrides");
    if (!isAuth && !isOverrides) {
      return next();
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.end();
      return;
    }

    // ── GitHub OAuth (dev mirror of functions/api/auth) ──────────────
    if (isAuth) {
      const env = devEnv();
      const action = urlPath.replace(/^\/api\/auth\/?/, "").replace(/\/$/, "").split("/")[0] || "";
      const secure = isSecureReq(req);

      if (action === "me" && req.method === "GET") {
        const sess = parseSessionCookie(req.headers.cookie);
        if (!sess) {
          return jsonRes(res, 200, {
            logged_in: false,
            oauth_configured: oauthConfigured(env),
          });
        }
        return jsonRes(res, 200, {
          logged_in: true,
          login: sess.login,
          name: sess.name || sess.login,
          avatar: sess.avatar || "",
          oauth_configured: oauthConfigured(env),
        });
      }

      if (action === "logout" && (req.method === "POST" || req.method === "GET")) {
        res.setHeader("Set-Cookie", clearSessionCookieHeader({ secure }));
        return jsonRes(res, 200, { ok: true, logged_in: false });
      }

      if ((action === "github" || action === "login") && req.method === "GET") {
        if (!oauthConfigured(env)) {
          return jsonRes(res, 503, {
            ok: false,
            error:
              "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET in .env",
          });
        }
        const state = crypto.randomUUID().replace(/-/g, "");
        const returnTo = qs.get("return_to") || "/";
        const stateCookie = [
          `morgan_gh_state=${encodeURIComponent(
            b64encode(JSON.stringify({ state, returnTo, exp: Date.now() + 600_000 })),
          )}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          "Max-Age=600",
        ];
        if (secure) stateCookie.push("Secure");
        const redirectUri =
          env.oauthRedirectUri || `${reqOrigin(req)}/api/auth/callback`;
        const params = new URLSearchParams({
          client_id: env.oauthClientId,
          redirect_uri: redirectUri,
          scope: "public_repo read:user",
          state,
        });
        res.statusCode = 302;
        res.setHeader("Location", `https://github.com/login/oauth/authorize?${params}`);
        res.setHeader("Set-Cookie", stateCookie.join("; "));
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }

      if (action === "callback" && req.method === "GET") {
        if (!oauthConfigured(env)) {
          return jsonRes(res, 503, { ok: false, error: "OAuth not configured" });
        }
        const code = qs.get("code");
        const state = qs.get("state");
        if (!code || !state) {
          return jsonRes(res, 400, { ok: false, error: "Missing code/state" });
        }
        let returnTo = "/";
        try {
          const raw = String(req.headers.cookie || "")
            .split(/;\s*/)
            .find((p) => p.startsWith("morgan_gh_state="));
          if (raw) {
            const data = JSON.parse(
              b64decode(decodeURIComponent(raw.slice("morgan_gh_state=".length))),
            );
            if (data.state !== state || (data.exp && Date.now() > data.exp)) {
              return jsonRes(res, 400, { ok: false, error: "Invalid OAuth state" });
            }
            if (data.returnTo && String(data.returnTo).startsWith("/")) {
              returnTo = data.returnTo;
            }
          }
        } catch {
          return jsonRes(res, 400, { ok: false, error: "Invalid OAuth state cookie" });
        }

        const redirectUri =
          env.oauthRedirectUri || `${reqOrigin(req)}/api/auth/callback`;
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: env.oauthClientId,
            client_secret: env.oauthClientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenJson.access_token) {
          return jsonRes(res, 400, {
            ok: false,
            error:
              tokenJson.error_description ||
              tokenJson.error ||
              "Token exchange failed",
          });
        }
        const me = await fetchGithubUser(tokenJson.access_token);
        if (!me.ok) {
          return jsonRes(res, 400, { ok: false, error: "Could not load GitHub user" });
        }
        const sessHeader = sessionCookieHeader(
          {
            token: tokenJson.access_token,
            login: me.login,
            avatar: me.avatar,
            name: me.name,
          },
          { secure },
        );
        const clearState = [
          "morgan_gh_state=",
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
          "Max-Age=0",
        ];
        if (secure) clearState.push("Secure");
        const dest = new URL(returnTo, reqOrigin(req));
        dest.searchParams.set("gh_login", "1");
        res.statusCode = 302;
        res.setHeader("Location", dest.pathname + dest.search + dest.hash);
        appendSetCookie(res, sessHeader);
        appendSetCookie(res, clearState.join("; "));
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }

      return jsonRes(res, 404, { ok: false, error: "Unknown auth route", action });
    }

    const overridesRoot = resolveOverridesRepoRoot();
    const publicShapes = path.join(__dirname, "public", "overrides", "bus-shapes.json");
    const artifactsDir = path.join(__dirname, "artifacts", "contributions");
    const pendingDir = overridesRoot
      ? path.join(overridesRoot, "pending")
      : path.join(artifactsDir, "pending");
    const shapesPath = overridesRoot
      ? path.join(overridesRoot, "bus-shapes.json")
      : publicShapes;
    const mergeScript = overridesRoot
      ? path.join(overridesRoot, "scripts", "merge-pending.mjs")
      : null;

    // ── status ──────────────────────────────────────────────────────────
    if (urlPath === "/api/overrides/status" && req.method === "GET") {
      let routes = 0;
      let pending = [];
      try {
        if (fs.existsSync(shapesPath)) {
          const j = JSON.parse(fs.readFileSync(shapesPath, "utf8"));
          routes = Array.isArray(j.routes) ? j.routes.length : 0;
        }
        if (fs.existsSync(pendingDir)) {
          pending = fs
            .readdirSync(pendingDir)
            .filter((f) => f.endsWith(".json"));
        }
      } catch {
        /* ignore */
      }
      return jsonRes(res, 200, {
        ok: true,
        mode: "local-dev",
        overrides_repo_path: overridesRoot,
        bus_shapes_path: shapesPath,
        pending_dir: pendingDir,
        published_routes: routes,
        pending_files: pending,
        fetch_url: "/api/overrides/bus-shapes.json",
        tip: overridesRoot
          ? "Contribute writes to sibling repo pending/. Merge via POST /api/overrides/merge"
          : "Sibling morgan-travelers-overrides not found — using artifacts/ + public/",
      });
    }

    // ── published shapes (what the app fetches in dev) ──────────────────
    if (
      (urlPath === "/api/overrides/bus-shapes.json" ||
        urlPath === "/api/overrides/bus-shapes") &&
      req.method === "GET"
    ) {
      const file = fs.existsSync(shapesPath) ? shapesPath : publicShapes;
      if (!fs.existsSync(file)) {
        return jsonRes(res, 404, { ok: false, error: "bus-shapes.json not found" });
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ── list pending ────────────────────────────────────────────────────
    if (urlPath === "/api/overrides/pending" && req.method === "GET") {
      fs.mkdirSync(pendingDir, { recursive: true });
      const files = fs
        .readdirSync(pendingDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const full = path.join(pendingDir, f);
          let meta = {};
          try {
            const j = JSON.parse(fs.readFileSync(full, "utf8"));
            meta = {
              id: j.id,
              agency: j.agency,
              route: j.route_short_name,
              status: j.status,
              points: Array.isArray(j.coordinates) ? j.coordinates.length : 0,
            };
          } catch {
            /* ignore */
          }
          return { file: f, path: `pending/${f}`, ...meta };
        });
      return jsonRes(res, 200, { ok: true, pending: files, dir: pendingDir });
    }

    // ── contribute (save pending draft + optional PR) ─────────────────
    if (urlPath === "/api/contribute-path" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || "{}");
        const submitMode =
          String(parsed.submit_mode || parsed.submitMode || "oauth").toLowerCase() ===
          "bot"
            ? "bot"
            : "oauth";
        // Strip client-only field from stored draft
        const { submit_mode: _sm, submitMode: _sm2, ...draftRest } = parsed;
        const draft = draftRest;
        if (draft.schema !== "morgan.travelers.bus-shape.v1") {
          return jsonRes(res, 400, { ok: false, error: "Unsupported schema" });
        }
        if (!Array.isArray(draft.coordinates) || draft.coordinates.length < 2) {
          return jsonRes(res, 400, {
            ok: false,
            error: "coordinates must have at least 2 points",
          });
        }
        const id = String(draft.id || `dev_${Date.now()}`)
          .replace(/[^a-zA-Z0-9._-]+/g, "_")
          .slice(0, 80);
        const env = devEnv();
        const sess = parseSessionCookie(req.headers.cookie);

        if (submitMode === "oauth" && !sess?.token) {
          return jsonRes(res, 401, {
            ok: false,
            error: "GitHub login required for OAuth submit",
            need_login: true,
            submit_mode: "oauth",
          });
        }

        if (!draft.contributor && sess?.login) {
          draft.contributor = sess.login;
        }

        const payload = {
          ...draft,
          id,
          status: "pending_review",
          received_at: new Date().toISOString(),
          local_dev: true,
          submit_mode: submitMode,
        };

        fs.mkdirSync(artifactsDir, { recursive: true });
        fs.mkdirSync(pendingDir, { recursive: true });

        const artifactFile = path.join(artifactsDir, `${id}.json`);
        const pendingFile = path.join(pendingDir, `${id}.json`);
        const text = JSON.stringify(payload, null, 2) + "\n";
        fs.writeFileSync(artifactFile, text);
        fs.writeFileSync(pendingFile, text);

        const storage = ["dev-fs", "pending"];
        console.info("[dev contribute-path]", submitMode, pendingFile);

        let gh = { ok: false, skipped: true };
        if (submitMode === "oauth") {
          gh = await openOverridesPullRequest({
            token: sess.token,
            draft: payload,
            mode: "oauth",
            repo: env.repo,
            base: env.base,
            userLogin: sess.login,
          });
        } else if (env.botToken) {
          gh = await openOverridesPullRequest({
            token: env.botToken,
            draft: payload,
            mode: "bot",
            repo: env.repo,
            base: env.base,
          });
        } else {
          gh = {
            ok: false,
            skipped: true,
            error: "Bot token not configured (OVERRIDES_GITHUB_TOKEN)",
          };
        }

        if (gh.ok) {
          console.info("[dev contribute-path] GitHub PR", gh.pr_url, gh.mode);
        } else if (!gh.skipped) {
          console.warn("[dev contribute-path] GitHub PR failed", gh.error);
        }

        const host = req.headers.host || "127.0.0.1:5173";
        const proto = isSecureReq(req) ? "https" : "http";
        const localReview = `${proto}://${host}/api/overrides/review/${encodeURIComponent(id)}`;

        // OAuth with failed PR and nothing stored would be bad — we always store locally
        if (submitMode === "oauth" && !gh.ok) {
          return jsonRes(res, 200, {
            ok: true,
            accepted: true,
            stored: true,
            storage,
            storage_key: pendingFile,
            id,
            submit_mode: submitMode,
            github_pr: false,
            github_pr_url: null,
            github_error: gh.error || "Could not open PR",
            github_author: null,
            local_pending: `pending/${id}.json`,
            local_repo: overridesRoot,
            local_review_url: localReview,
            message: `Dev: saved locally; OAuth PR failed: ${gh.error || "unknown"}. Local review: ${localReview}`,
          });
        }

        return jsonRes(res, 200, {
          ok: true,
          accepted: true,
          stored: true,
          storage: gh.ok ? [...storage, "github"] : storage,
          storage_key: pendingFile,
          id,
          submit_mode: submitMode,
          github_pr: !!gh.ok,
          github_pr_url: gh.pr_url || null,
          github_pr_number: gh.pr_number || null,
          github_author: gh.author || null,
          github_skipped: !!gh.skipped,
          github_error: gh.error || null,
          local_pending: `pending/${id}.json`,
          local_repo: overridesRoot,
          local_review_url: localReview,
          message: gh.ok
            ? `Dev: PR opened ${gh.pr_url} (${submitMode}${gh.author ? ` as ${gh.author}` : ""})`
            : gh.skipped
              ? `Dev: saved to pending/${id}.json (bot: set OVERRIDES_GITHUB_TOKEN; oauth: Log in with GitHub). Local review: ${localReview}`
              : `Dev: saved locally; GitHub PR failed: ${gh.error || "unknown"}. Local review: ${localReview}`,
        });
      } catch (e) {
        return jsonRes(res, 400, {
          ok: false,
          error: e?.message || "Invalid JSON",
        });
      }
    }

    // ── local review page (HTML) for pending draft ────────────────────
    if (urlPath.startsWith("/api/overrides/review/") && req.method === "GET") {
      const id = decodeURIComponent(urlPath.replace("/api/overrides/review/", ""));
      const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
      const file = path.join(pendingDir, `${safe}.json`);
      if (!fs.existsSync(file)) {
        return jsonRes(res, 404, { ok: false, error: "Draft not found", id: safe });
      }
      let draft = {};
      try {
        draft = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        draft = {};
      }
      const pts = Array.isArray(draft.coordinates) ? draft.coordinates.length : 0;
      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Local draft ${safe}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
  code,pre{background:#1c1c22;padding:2px 6px;border-radius:6px}
  pre{padding:12px;overflow:auto;font-size:12px}
  .btn{display:inline-block;margin:8px 8px 8px 0;padding:10px 14px;border-radius:10px;border:1px solid #444;background:#2a2a35;color:#fff;text-decoration:none;cursor:pointer}
  .ok{border-color:#3a8;background:#1a3}
</style></head><body>
  <h1>Local contribution draft</h1>
  <p><strong>${draft.agency || "?"} ${draft.route_short_name || "?"}</strong> · ${pts} points · <code>${safe}</code></p>
  <p>Status: <code>${draft.status || "pending_review"}</code></p>
  <p>File: <code>${file}</code></p>
  <p>
    <button class="btn ok" id="merge">Merge into bus-shapes.json</button>
    <a class="btn" href="/api/overrides/pending/${encodeURIComponent(safe)}.json">Download JSON</a>
    <a class="btn" href="/">Back to app</a>
  </p>
  <pre id="out"></pre>
  <script>
    document.getElementById('merge').onclick = async () => {
      const r = await fetch('/api/overrides/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'pending/${safe}.json' }),
      });
      const j = await r.json();
      document.getElementById('out').textContent = JSON.stringify(j, null, 2);
    };
  </script>
</body></html>`;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.end(html);
      return;
    }

    // ── raw pending JSON download ─────────────────────────────────────
    if (
      urlPath.startsWith("/api/overrides/pending/") &&
      urlPath.endsWith(".json") &&
      req.method === "GET"
    ) {
      const name = path.basename(urlPath);
      const file = path.join(pendingDir, name);
      if (!fs.existsSync(file)) {
        return jsonRes(res, 404, { ok: false, error: "not found" });
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name}"`,
      );
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ── merge pending → bus-shapes.json ─────────────────────────────────
    if (urlPath === "/api/overrides/merge" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const { file, dry_run: dryRun, remove_pending: removePending } =
          JSON.parse(body || "{}");
        if (!file || typeof file !== "string") {
          return jsonRes(res, 400, {
            ok: false,
            error: 'Body needs { "file": "pending/<id>.json" }',
          });
        }
        const safe = file.replace(/\.\./g, "").replace(/^\/+/, "");
        const abs = path.isAbsolute(safe)
          ? safe
          : path.join(overridesRoot || artifactsDir, safe);
        if (!fs.existsSync(abs)) {
          return jsonRes(res, 404, { ok: false, error: `Not found: ${abs}` });
        }
        if (!mergeScript || !fs.existsSync(mergeScript)) {
          // Inline minimal merge if script missing
          const draft = JSON.parse(fs.readFileSync(abs, "utf8"));
          const shapes = fs.existsSync(shapesPath)
            ? JSON.parse(fs.readFileSync(shapesPath, "utf8"))
            : { routes: [] };
          if (!Array.isArray(shapes.routes)) shapes.routes = [];
          const entry = {
            id: draft.id,
            status: "published",
            agency: draft.agency,
            route_short_name: draft.route_short_name,
            route_id_match: draft.route_id_match || [],
            from_match: draft.from_match || [],
            to_match: draft.to_match || [],
            direction: draft.direction || "",
            notes: draft.notes || "",
            coordinates: draft.coordinates,
            visual_stops: draft.visual_stops || [],
            published_at: new Date().toISOString().slice(0, 10),
          };
          const idx = shapes.routes.findIndex((r) => r.id === entry.id);
          if (idx >= 0) shapes.routes[idx] = entry;
          else shapes.routes.push(entry);
          shapes.updated_at = new Date().toISOString().slice(0, 10);
          if (!dryRun) {
            fs.mkdirSync(path.dirname(shapesPath), { recursive: true });
            fs.writeFileSync(shapesPath, JSON.stringify(shapes, null, 2) + "\n");
            fs.writeFileSync(publicShapes, JSON.stringify(shapes, null, 2) + "\n");
          }
          return jsonRes(res, 200, {
            ok: true,
            dry_run: !!dryRun,
            routes: shapes.routes.length,
            id: entry.id,
            bus_shapes_path: shapesPath,
          });
        }

        const { spawnSync } = await import("node:child_process");
        const args = [mergeScript, abs];
        if (dryRun) args.push("--dry-run");
        if (removePending) args.push("--remove-pending");
        const r = spawnSync(process.execPath, args, {
          encoding: "utf8",
          cwd: overridesRoot || __dirname,
        });
        if (r.status !== 0) {
          return jsonRes(res, 500, {
            ok: false,
            error: r.stderr || r.stdout || `merge exit ${r.status}`,
          });
        }
        // Mirror into app public/ for offline fallback
        if (!dryRun && fs.existsSync(shapesPath)) {
          fs.copyFileSync(shapesPath, publicShapes);
        }
        console.info("[dev overrides/merge]", r.stdout);
        return jsonRes(res, 200, {
          ok: true,
          dry_run: !!dryRun,
          stdout: r.stdout,
          bus_shapes_path: shapesPath,
          public_synced: !dryRun,
        });
      } catch (e) {
        return jsonRes(res, 400, {
          ok: false,
          error: e?.message || "Merge failed",
        });
      }
    }

    // ── copy shapes → public/overrides ──────────────────────────────────
    if (urlPath === "/api/overrides/reload-public" && req.method === "POST") {
      try {
        if (!fs.existsSync(shapesPath)) {
          return jsonRes(res, 404, { ok: false, error: "No bus-shapes.json" });
        }
        fs.mkdirSync(path.dirname(publicShapes), { recursive: true });
        fs.copyFileSync(shapesPath, publicShapes);
        return jsonRes(res, 200, {
          ok: true,
          copied_to: publicShapes,
        });
      } catch (e) {
        return jsonRes(res, 500, { ok: false, error: e?.message || "copy failed" });
      }
    }

    return next();
  }

  return {
    name: "cross-origin-isolation",
    configureServer(server) {
      // Serve the local graph as raw bytes — do NOT set Content-Encoding: gzip
      // (Vite's static handler does, which double-decodes / breaks fetch).
      server.middlewares.use((req, res, next) => {
        isolationHeaders(res);
        const url = req.url?.split("?")[0] || "";
        if (url === "/data/hk.wheelsrouter.gz" || url.endsWith("/data/hk.wheelsrouter.gz")) {
          const file = path.join(__dirname, "public/data/hk.wheelsrouter.gz");
          if (!fs.existsSync(file)) return next();
          const stat = fs.statSync(file);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Length", String(stat.size));
          res.setHeader("Cache-Control", "no-cache");
          // Explicitly no Content-Encoding — body is still gzip-compressed bytes
          fs.createReadStream(file).pipe(res);
          return;
        }
        next();
      });
      server.middlewares.use(overridesApiMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        isolationHeaders(res);
        next();
      });
      server.middlewares.use(overridesApiMiddleware);
      // vite preview does not run `server.proxy` — mirror the /edge proxy so
      // the PMTiles basemap / graph fetch work identically to production.
      server.middlewares.use("/edge", (req, res) => {
        const target = "https://hk-gtfsdata.morgandev.cc";
        const upstream = https.request(
          {
            host: new URL(target).host,
            path: (req.url || "/").replace(/^\/edge/, "") || "/",
            method: req.method,
            headers: { ...req.headers, host: new URL(target).host },
          },
          (upRes) => {
            upRes.headers["cross-origin-resource-policy"] = "cross-origin";
            upRes.headers["access-control-allow-origin"] = "*";
            // Keep .pmtiles/.gz edge objects raw — no HTTP Content-Encoding
            delete upRes.headers["content-encoding"];
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            upRes.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "edge proxy unavailable" }));
        });
        req.pipe(upstream);
      });
    },
  };
}

export default defineConfig({
  // Absolute base so PWA / mobile never resolve ./assets to a bad path
  base: "/",
  plugins: [crossOriginIsolation()],
  server: {
    port: 5173,
    open: false,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      // Same-origin assets are fine; explicit CORP helps some SW / COEP edge cases
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    fs: {
      allow: [".."],
    },
    // Same-origin proxy so COEP require-corp can load edge assets in dev
    // (injects CORP on the proxied response).
    proxy: {
      "/edge": {
        target: "https://hk-gtfsdata.morgandev.cc",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/edge/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            // Avoid Vite/browser treating .gz edge objects as Content-Encoding
            delete proxyRes.headers["content-encoding"];
          });
        },
      },
      // Nominatim geocoder (same-origin under COEP require-corp)
      "/geocode": {
        target: "https://nominatim.openstreetmap.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/geocode/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader(
              "User-Agent",
              "MORGAN-Travelers/0.4 (transit PWA; https://morgandev.cc)",
            );
            proxyReq.setHeader("Accept", "application/json");
          });
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=300";
          });
        },
      },
      // OSRM for road-following bus polylines (route-snapper densify)
      "/osrm": {
        target: "https://router.project-osrm.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/osrm/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=3600";
          });
        },
      },
      // HK open-data ETAs (KMB / CTB / NLB / MTR) — same-origin under COEP
      "/eta/kmb": {
        target: "https://data.etabus.gov.hk",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/eta\/kmb/, "/v1/transport/kmb"),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=15";
          });
        },
      },
      "/eta/ctb": {
        target: "https://rt.data.gov.hk",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/eta\/ctb/, "/v2/transport/citybus"),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=15";
          });
        },
      },
      "/eta/nlb": {
        target: "https://rt.data.gov.hk",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/eta\/nlb/, "/v2/transport/nlb"),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=15";
          });
        },
      },
      "/eta/mtr": {
        target: "https://rt.data.gov.hk",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/eta\/mtr/, "/v1/transport/mtr"),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=15";
          });
        },
      },
      // GMB (green minibus) ETA open data
      "/eta/gmb": {
        target: "https://data.etagmb.gov.hk",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/eta\/gmb/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=300";
          });
        },
      },
      // MTR open data CSVs (LRT routes & stops)
      "/eta/mtr-open": {
        target: "https://opendata.mtr.com.hk",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/eta\/mtr-open/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cross-origin-resource-policy"] = "cross-origin";
            proxyRes.headers["access-control-allow-origin"] = "*";
            proxyRes.headers["cache-control"] = "public, max-age=86400";
          });
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  worker: {
    format: "es",
  },
  assetsInclude: ["**/*.wasm"],
});
