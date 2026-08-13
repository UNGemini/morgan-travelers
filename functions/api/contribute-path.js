/**
 * Cloudflare Pages Function — path contribution intake (serverless).
 *
 * POST /api/contribute-path
 *   Body: JSON draft (morgan.travelers.bus-shape.v1)
 *   Optional: submit_mode: "oauth" | "bot"
 *
 * Env:
 *   GITHUB_OAUTH_* / session cookie for oauth mode
 *   OVERRIDES_GITHUB_TOKEN for bot mode
 *   OVERRIDES_REPO=UNGemini/morgan-travelers-overrides
 *   + optional KV/R2/webhook
 */

import {
  parseSessionCookie,
  openOverridesPullRequest,
  DEFAULT_OVERRIDES_REPO,
} from "../_shared/github.js";
import {
  foreignOriginResponse,
  sameOriginCors,
} from "../_shared/security.js";

const MAX_BODY_BYTES = 400_000;
const MAX_POINTS = 2_000;

function contribHeaders(request) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...sameOriginCors(request, {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Cross-Origin-Resource-Policy": "same-origin",
    }),
  };
}

/**
 * @param {unknown} draft
 */
function validateDraft(draft) {
  if (!draft || typeof draft !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const d = /** @type {Record<string, unknown>} */ (draft);
  if (d.schema !== "morgan.travelers.bus-shape.v1") {
    return { ok: false, error: "Unsupported schema (expect morgan.travelers.bus-shape.v1)" };
  }
  const route = String(d.route_short_name || "").trim();
  if (!route || route.length > 32) {
    return { ok: false, error: "route_short_name required (max 32 chars)" };
  }
  const agency = String(d.agency || "").trim();
  if (!agency || agency.length > 32) {
    return { ok: false, error: "agency required" };
  }
  const coords = d.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    return { ok: false, error: "coordinates must have at least 2 [lon,lat] points" };
  }
  if (coords.length > MAX_POINTS) {
    return { ok: false, error: `Too many points (max ${MAX_POINTS})` };
  }
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!Array.isArray(c) || c.length < 2) {
      return { ok: false, error: `Invalid coordinate at index ${i}` };
    }
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return { ok: false, error: `Non-numeric coordinate at index ${i}` };
    }
    if (lon < 113.5 || lon > 114.6 || lat < 22.0 || lat > 22.7) {
      return { ok: false, error: `Coordinate out of HK bounds at index ${i}` };
    }
  }
  const from = d.from_match;
  const to = d.to_match;
  if (!Array.isArray(from) || !from.length || !Array.isArray(to) || !to.length) {
    return { ok: false, error: "from_match and to_match required (string arrays)" };
  }

  let visualStops = [];
  if (Array.isArray(d.visual_stops)) {
    if (d.visual_stops.length > 500) {
      return { ok: false, error: "Too many visual_stops (max 500)" };
    }
    for (let i = 0; i < d.visual_stops.length; i++) {
      const s = d.visual_stops[i];
      if (!s || typeof s !== "object") continue;
      const vis = s.visual;
      if (!Array.isArray(vis) || vis.length < 2) continue;
      const vLon = Number(vis[0]);
      const vLat = Number(vis[1]);
      if (!Number.isFinite(vLon) || !Number.isFinite(vLat)) continue;
      if (vLon < 113.5 || vLon > 114.6 || vLat < 22.0 || vLat > 22.7) {
        return { ok: false, error: `visual_stops[${i}] out of HK bounds` };
      }
      let official;
      if (Array.isArray(s.official) && s.official.length >= 2) {
        const oLon = Number(s.official[0]);
        const oLat = Number(s.official[1]);
        if (Number.isFinite(oLon) && Number.isFinite(oLat)) {
          official = [oLon, oLat];
        }
      }
      visualStops.push({
        stop_id: String(s.stop_id || "").slice(0, 64),
        name: String(s.name || "").slice(0, 120),
        seq: Number.isFinite(Number(s.seq)) ? Number(s.seq) : i,
        official,
        visual: [vLon, vLat],
      });
    }
  }

  const cleaned = {
    schema: "morgan.travelers.bus-shape.v1",
    status: "pending_review",
    id: String(d.id || `path_${Date.now()}`).slice(0, 120),
    agency,
    route_short_name: route,
    route_id_match: Array.isArray(d.route_id_match)
      ? d.route_id_match.map(String).slice(0, 20)
      : [],
    from_match: from.map(String).slice(0, 20),
    to_match: to.map(String).slice(0, 20),
    direction: String(d.direction || "").slice(0, 120),
    notes: String(d.notes || "").slice(0, 2000),
    coordinates: coords.map((c) => [Number(c[0]), Number(c[1])]),
    visual_stops: visualStops,
    contributor: String(d.contributor || "").slice(0, 120),
    submitted_at: String(d.submitted_at || new Date().toISOString()),
    app_version: String(d.app_version || "").slice(0, 32),
    received_at: new Date().toISOString(),
  };
  return { ok: true, draft: cleaned };
}

async function storeDraft(env, draft) {
  const key = `pending/${draft.submitted_at.slice(0, 10)}/${draft.id}.json`;
  let stored = false;
  let storage = [];

  if (env.CONTRIBUTIONS && typeof env.CONTRIBUTIONS.put === "function") {
    await env.CONTRIBUTIONS.put(key, JSON.stringify(draft), {
      metadata: {
        route: draft.route_short_name,
        agency: draft.agency,
        status: "pending_review",
      },
      expirationTtl: 60 * 60 * 24 * 90,
    });
    stored = true;
    storage.push("kv");
  }

  if (
    env.CONTRIBUTIONS_BUCKET &&
    typeof env.CONTRIBUTIONS_BUCKET.put === "function"
  ) {
    await env.CONTRIBUTIONS_BUCKET.put(key, JSON.stringify(draft, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        route: String(draft.route_short_name),
        agency: String(draft.agency),
      },
    });
    stored = true;
    storage.push("r2");
  }

  return { stored, storage, key };
}

async function notifyWebhook(env, draft) {
  const url = env.CONTRIBUTE_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `MORGAN path contribution: **${draft.agency} ${draft.route_short_name}** (${draft.coordinates.length} pts)`,
        draft: {
          id: draft.id,
          agency: draft.agency,
          route_short_name: draft.route_short_name,
          coordinates_count: draft.coordinates.length,
        },
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function json(request, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: contribHeaders(request),
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: contribHeaders(request) });
  }

  const blocked = foreignOriginResponse(request);
  if (blocked) return blocked;

  if (request.method !== "POST") {
    return json(request, 405, { ok: false, error: "POST only" });
  }

  const cl = Number(request.headers.get("content-length") || 0);
  if (cl > MAX_BODY_BYTES) {
    return json(request, 413, { ok: false, error: "Payload too large" });
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return json(request, 400, { ok: false, error: "Could not read body" });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json(request, 413, { ok: false, error: "Payload too large" });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(request, 400, { ok: false, error: "Invalid JSON" });
  }

  const submitMode =
    String(parsed.submit_mode || parsed.submitMode || "oauth").toLowerCase() ===
    "bot"
      ? "bot"
      : "oauth";

  // Bot mode uses the site token — only first-party browsers may trigger it.
  if (submitMode === "bot" && !request.headers.get("Origin")) {
    return json(request, 403, {
      ok: false,
      error: "browser origin required for bot submit",
    });
  }

  const v = validateDraft(parsed);
  if (!v.ok) return json(request, 400, { ok: false, error: v.error });

  const draft = v.draft;
  const store = await storeDraft(env || {}, draft);
  const webhook = await notifyWebhook(env || {}, draft);

  let gh = { ok: false, skipped: true };
  const sess = parseSessionCookie(request.headers.get("Cookie"));
  const repo = env.OVERRIDES_REPO || DEFAULT_OVERRIDES_REPO;
  const base = env.OVERRIDES_BASE_BRANCH || "main";

  if (submitMode === "oauth") {
    if (!sess?.token) {
      return json(request, 401, {
        ok: false,
        error: "GitHub login required for OAuth submit",
        need_login: true,
        submit_mode: "oauth",
      });
    }
    // Prefer contributor login as name if empty
    if (!draft.contributor) draft.contributor = sess.login || "";
    gh = await openOverridesPullRequest({
      token: sess.token,
      draft,
      mode: "oauth",
      repo,
      base,
      userLogin: sess.login,
    });
  } else {
    // bot mode
    const botToken = env.OVERRIDES_GITHUB_TOKEN || env.GITHUB_TOKEN;
    if (!botToken) {
      gh = {
        ok: false,
        skipped: true,
        error: "Bot token not configured (OVERRIDES_GITHUB_TOKEN)",
      };
    } else {
      gh = await openOverridesPullRequest({
        token: botToken,
        draft,
        mode: "bot",
        repo,
        base,
      });
    }
  }

  const accepted =
    store.stored ||
    webhook.ok === true ||
    gh.ok === true;

  // OAuth mode with failed PR and nothing else → surface as error-ish but still 200 if stored
  if (submitMode === "oauth" && !gh.ok && !accepted) {
    return json(request, gh.need_login ? 401 : 502, {
      ok: false,
      id: draft.id,
      accepted: false,
      submit_mode: submitMode,
      need_login: !!gh.need_login,
      github_pr: false,
      github_error: gh.error || "Could not open PR",
      error: gh.error || "OAuth submit failed",
      message: gh.error || "Could not open pull request with your GitHub account",
    });
  }

  return json(request, accepted ? 200 : 202, {
    ok: true,
    id: draft.id,
    accepted,
    submit_mode: submitMode,
    stored: store.stored,
    storage: store.storage,
    storage_key: store.key,
    webhook: webhook.ok === true,
    webhook_skipped: !!webhook.skipped,
    github_pr: gh.ok === true,
    github_pr_url: gh.pr_url || null,
    github_pr_number: gh.pr_number || null,
    github_author: gh.author || null,
    github_skipped: !!gh.skipped,
    github_error: gh.error || null,
    message: accepted
      ? gh.ok
        ? `Submitted — PR opened${gh.pr_url ? `: ${gh.pr_url}` : ""} (${submitMode})`
        : "Submission received. Moderators will review before publish."
      : "Validated. No channel configured — use Download JSON or set OVERRIDES_GITHUB_TOKEN / OAuth.",
  });
}
