---
kind: error_handling
name: Structured Error Responses and Validation in Cloudflare Pages Functions with Frontend Promise Rejection
category: error_handling
scope:
    - '**'
source_files:
    - functions/api/auth/[[path]].js
    - functions/api/contribute-path.js
    - functions/_shared/github.js
    - functions/eta/[[path]].js
    - src/contributePath.js
---

## Overview

This repository implements error handling across two distinct layers: **Cloudflare Pages serverless functions** (backend) and the **Vite-built frontend** (browser). There is no centralized error class hierarchy or framework — instead, each layer follows its own consistent pattern.

## Backend: Cloudflare Pages Functions (`functions/`)

### Response-based errors (no thrown exceptions)
Serverless functions never throw to the runtime. Instead, they return `Response` objects via a local `json(status, body)` helper that sets `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, and CORS headers. Every error path returns `{ ok: false, error: "..." }` as the response body, paired with an appropriate HTTP status code:

- **400 Bad Request**: invalid JSON, missing fields, out-of-bounds coordinates, malformed OAuth state (`functions/api/auth/[[path]].js`, `functions/api/contribute-path.js`).
- **401 Unauthorized**: missing GitHub session cookie for OAuth submit mode.
- **404 Not Found**: unknown auth route, unknown ETA operator proxy target.
- **405 Method Not Allowed**: non-POST on `/api/contribute-path`.
- **413 Payload Too Large**: body exceeds `MAX_BODY_BYTES = 400_000`.
- **502/503**: upstream failures (GitHub PR creation fails, OAuth not configured).

### Centralized validation function
`validateDraft(draft)` in `contribute-path.js` is the single source of truth for input validation. It returns `{ ok: true, draft: cleaned }` or `{ ok: false, error: "..." }` for every rule (schema version, field lengths, coordinate bounds within HK `[113.5–114.6, 22.0–22.7]`, point count ≤ 2000, visual stops ≤ 500). This keeps error messages uniform and user-facing.

### Shared GitHub helpers return result objects
`functions/_shared/github.js` uses a consistent result-object pattern rather than throwing: `fetchGithubUser` returns `{ ok: false, status, error }` on non-OK responses; `openOverridesPullRequest` wraps the entire multi-step GitHub flow (fork → branch → put file → create PR) in a try/catch and always returns `{ ok, pr_url, pr_number, branch, ... }` or `{ ok: false, error: String(e?.message || e) }`. Each step checks `res.ok` and returns early with a descriptive `error` string truncated to ~200–300 chars of the response body.

### Proxy passthrough with explicit fallbacks
`functions/eta/[[path]].js` is a COEP-safe reverse proxy. Unknown operators return `{ error: "unknown eta operator", op }` at 404. Successful proxied responses preserve the upstream `status` and `Content-Type`; failed upstream requests surface as-is since there is no transformation layer.

### Optional feature gating
When optional features are disabled (e.g., `GITHUB_OAUTH_CLIENT_ID` / `SECRET` not set), endpoints return 503 with `{ ok: false, error: "OAuth not configured" }` rather than crashing. The frontend reads `oauth_configured` from `/api/auth/me` to adapt UI.

## Frontend: Browser-side (`src/`)

### Promise rejection via `throw new Error(...)`
Frontend modules use standard JavaScript `throw new Error(message)` for user-facing and developer-facing failures. There is no custom error type — plain `Error` instances carry human-readable strings like `"Operator and route required"`, `"No stops found for KMB 3X"`, `"LRT route CSV empty"`, `"Enter an MTR line code: TWL, ISL, …"`.

### Local fetch wrappers propagate errors upward
`fetchJson(url, ttlMs)` and `fetchText(url, ttlMs)` in `src/contributePath.js` wrap `fetch` with a simple `if (!res.ok) throw new Error(\`${res.status} ${url}\`)` check, then cache successes in `Map`s keyed by URL with TTLs. Callers handle these rejections via `try/catch` blocks around individual async operations (e.g., per-stop GMB detail fetches inside `Promise.all` are wrapped individually so one failure doesn't abort the batch).

### Graceful degradation with `console.warn`
Non-fatal failures during path densification (e.g., rail basemap fallback) are caught and logged via `console.warn("[contribute] rail densify", e)` without breaking the overall flow — the system falls back to OSRM road-snapping instead of failing the whole contribution load.

### No global unhandled rejection handler
There is no `window.onerror`, `unhandledrejection`, or top-level error boundary in the visible code. Errors bubble up to the caller's `try/catch` or remain unhandled if not explicitly caught.

## Conventions Summary

| Layer | Pattern | Enforcement |
|---|---|---|
| Serverless functions | Return `new Response(JSON.stringify({ok:false,error}))` with explicit HTTP status | Every endpoint branches on `res.ok` and returns early |
| Shared helpers | Return `{ ok, ... }` result objects, never throw | `openOverridesPullRequest` catches all errors into `{ ok:false, error }` |
| Input validation | Single `validateDraft()` returning typed result object | Called before any side-effecting work |
| Frontend logic | `throw new Error("human message")` + `try/catch` at call sites | Plain `Error`, no custom classes |
| Network calls | Wrapper functions reject on `!res.ok` | `fetchJson`/`fetchText` enforce this uniformly |
| Optional features | Return 503 with `oauth_configured` flag | Checked via `/api/auth/me` before showing OAuth UI |
| Proxies | Passthrough upstream status, explicit 404 for unknown targets | `TARGETS` map lookup gates routing |
