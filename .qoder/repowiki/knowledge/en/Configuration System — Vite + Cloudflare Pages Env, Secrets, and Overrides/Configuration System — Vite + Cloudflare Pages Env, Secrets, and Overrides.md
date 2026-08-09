---
kind: configuration_system
name: Configuration System — Vite + Cloudflare Pages Env, Secrets, and Overrides
category: configuration_system
scope:
    - '**'
source_files:
    - vite.config.js
    - wrangler.toml
    - .env.example
    - docs/local-overrides.md
    - package.json
    - functions/_shared/github.js
---

## What system/approach is used

The project uses a **two-layer configuration model** split between development-time (Vite) and runtime (Cloudflare Pages):

1. **Development**: `vite.config.js` loads environment variables via Vite's `loadEnv('development', ...)` from `.env`, `.env.development`, plus Node `process.env`. It also reads a sibling overrides repository path (`OVERRIDES_REPO_PATH`) and injects a custom dev server middleware that mirrors the production `/api/auth*` and `/api/overrides*` endpoints.
2. **Production (Cloudflare Pages)**: `wrangler.toml` declares non-secret runtime variables under `[vars]` and documents secrets to be set in the Cloudflare dashboard or via `wrangler pages secret put`. The same env names are consumed by the Pages Functions in `functions/api/*`.
3. **Frontend build-time env**: Vite exposes variables prefixed with `VITE_` to the browser bundle; the example file shows `VITE_OVERRIDES_BUS_SHAPES_URL` as a way to force the app to fetch bus shapes from GitHub raw instead of the local dev API.
4. **Feature toggles / modes**: The codebase switches behavior based on whether OAuth credentials are configured (`oauthConfigured(env)` checks both client id and secret), whether a sibling overrides repo exists (`resolveOverridesRepoRoot()`), and whether a bot token is present — enabling "OAuth submit", "Bot submit", or "local draft only" modes without code changes.

## Key files and packages

- `vite.config.js` — central config loader for dev env, dev-only override APIs, proxy targets for external services (Nominatim, OSRM, HK open-data ETAs), COEP/COOP headers, and the `crossOriginIsolation` plugin.
- `wrangler.toml` — Cloudflare Pages deployment config: name, compatibility date, build output dir, `[vars]` defaults (`OVERRIDES_REPO`, `OVERRIDES_BASE_BRANCH`, optional `GITHUB_OAUTH_CLIENT_ID`/`REDIRECT_URI`), and documented secrets.
- `.env.example` — canonical reference for all supported environment variables, grouped into "Local dev" and "Production (Cloudflare Pages secrets)" sections.
- `docs/local-overrides.md` — authoritative documentation of the overrides workflow, env variables, dev API surface, and production secret mapping.
- `package.json` — scripts that run pre-build hooks (`sync-maplibre-worker.mjs`, `build-fares.mjs`) and expose CLI commands like `overrides:status`, `overrides:pending`, `overrides:merge`.
- `functions/_shared/github.js` — shared GitHub OAuth / PR helpers imported by both `vite.config.js` (dev mirror) and Pages Functions, including `DEFAULT_OVERRIDES_REPO`.
- `public/_headers` — serves COOP/COEP headers required by the WASM router under cross-origin isolation.

## Architecture and conventions

### Environment variable precedence

In `vite.config.js::devEnv()`, each setting follows an explicit priority chain:

```
process.env.X > .env(.development).X > DEFAULT_OVERRIDES_REPO / hardcoded default
```

This pattern applies to every configurable value: `OVERRIDES_GITHUB_TOKEN`, `OVERRIDES_REPO`, `OVERRIDES_BASE_BRANCH`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`.

### Secret vs. non-secret separation

`wrangler.toml` explicitly separates:
- `[vars]` block for committed, non-secret values (repo name, base branch, optional public client id).
- A commented-out section documenting secrets that must be set in the Cloudflare dashboard or via Wrangler CLI — never committed to the repo.

### Feature gating by configuration presence

- OAuth flow is gated by `oauthConfigured(env)`: if both `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are absent, `/api/auth/github` returns 503 with an error message directing users to set them in `.env`.
- Overrides source resolution falls back through: `OVERRIDES_REPO_PATH` → sibling `../morgan-travelers-overrides` → `public/overrides/bus-shapes.json`.
- Submit mode selection (`oauth` vs `bot`) is chosen at request time based on whether a session cookie (OAuth) or `OVERRIDES_GITHUB_TOKEN` is available.

### Dev mirrors production

`vite.config.js` implements a full mirror of the Pages Functions routes (`/api/auth/github|callback|me|logout`, `/api/overrides/status|bus-shapes.json|pending|merge|reload-public`, `/api/contribute-path`) so developers can test the contribution workflow locally without deploying to Cloudflare.

### External service proxies as configuration

All outbound third-party calls are funneled through Vite dev proxies configured in `vite.config.js` under `server.proxy`, each with its own target URL, rewrite rules, CORS headers, and cache-control policies. This keeps the frontend codebase free of hard-coded URLs and lets operators adjust endpoints per environment.

## Conventions and constraints

- **Environment variable naming**: All configuration keys use UPPER_SNAKE_CASE. Frontend-exposed variables are prefixed with `VITE_` (e.g. `VITE_OVERRIDES_BUS_SHAPES_URL`).
- **Defaults are explicit**: Every env lookup chains to a sensible default (`DEFAULT_OVERRIDES_REPO`, base branch `main`, fallback paths). Missing secrets produce informative 503/400 errors rather than silent failures.
- **Secrets are never committed**: `wrangler.toml` comments state "Do NOT put real values in this file." Secrets live in the Cloudflare dashboard or `wrangler pages secret put`; `.env.example` contains placeholder values only.
- **Overrides repo layout is enforced**: Contributions are saved as JSON files with schema `morgan.travelers.bus-shape.v1` and coordinates arrays of at least two points; invalid payloads return 400 with a descriptive error.
- **Dev-only features are isolated**: The entire override API middleware is wrapped in a Vite plugin and only active during `npm run dev` / preview; production relies on Pages Functions.
- **Build-time data generation is scripted**: Prebuild hooks (`predev`, `prebuild`) invoke `scripts/sync-maplibre-worker.mjs` and `scripts/build-fares.mjs` to regenerate static assets before the Vite build runs.