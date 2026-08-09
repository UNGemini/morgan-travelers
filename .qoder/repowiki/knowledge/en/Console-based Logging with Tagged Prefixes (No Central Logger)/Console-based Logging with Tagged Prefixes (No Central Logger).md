---
kind: logging_system
name: Console-based Logging with Tagged Prefixes (No Central Logger)
category: logging_system
scope:
    - '**'
source_files:
    - package.json
    - src/main.js
    - src/contributePath.js
    - src/gmbRouteData.js
    - src/lrtRouteData.js
    - src/fares.js
    - src/interchangeSchemes.js
    - functions/_shared/github.js
---

## What system/approach is used

The repository uses **no dedicated logging framework**. All output goes through the browser/server runtime's built-in `console` API (`console.info`, `console.warn`, `console.error`). There are no logger initializers, log-level configuration files, structured loggers (e.g., pino, winston, bunyan), or custom logger modules anywhere in the codebase.

- Frontend code under `src/` emits logs via `console.info` and `console.warn` directly.
- Cloudflare Pages Functions under `functions/` do not emit any console output — they return structured result objects (e.g. `{ ok: false, error: ... }`) instead of printing diagnostics; errors bubble up as HTTP responses.
- Build/data-sync scripts under `scripts/` also rely on plain `console` calls (not shown here but consistent with the pattern).

## Key files and packages

- `package.json` — no logging-related dependencies at all; only runtime deps (`maplibre-gl`, `pmtiles`, `@protomaps/basemaps`) and dev deps (`vite`, `playwright`).
- `src/main.js` — central app bootstrap; emits startup diagnostics like `[maplibre] worker → ...`, `[coi] crossOriginIsolated = ...`, and feature-specific warnings such as `[overrides]`, `[pinned]`, `[mtrLayer]`.
- `src/contributePath.js` — user contribution flow; tagged warnings like `[contribute] rail densify`, `[contribute] follow roads`, `[contribute] submit overlay missing from DOM`, `[contribute] load path`, `[contribute] API submit failed`.
- `src/gmbRouteData.js` — GMB ETA data loader; tags like `[eta] GMB route codes`, `[eta] GMB directions`, `[eta] GMB stops`.
- `src/lrtRouteData.js` — LRT ETA data loader; tags like `[eta] LRT route data`, plus info logs for route data.
- `src/fares.js` — fare table loading; `console.info` / `console.warn` around fare parsing.
- `src/interchangeSchemes.js` — interchange scheme loading; info/warn around BBI compact data.
- `functions/_shared/github.js` — shared GitHub helpers used by serverless functions; **no logging** — failures are returned as `{ ok: false, error: String(e?.message || e) }`.

## Architecture and conventions

1. **Tagged prefix convention**: Every log line starts with a bracketed tag identifying the subsystem, e.g. `[eta]`, `[contribute]`, `[overrides]`, `[pinned]`, `[mtrLayer]`, `[maplibre]`, `[coi]`. This is the de facto way to distinguish log sources since there is no logger instance that could carry context.
2. **Level usage**:
   - `console.info` — informational events (startup, successful data loads, layer readiness).
   - `console.warn` — recoverable problems (network failures, missing DOM elements, stale data, non-fatal parse errors).
   - `console.error` — rare; used when an exception bubbles out of a catch block (e.g. in `openOverridesPullRequest` returning `{ ok: false, error: ... }`).
3. **Structured fields are ad-hoc**: Log messages concatenate contextual values (route IDs, stop IDs, error messages) into the string rather than passing structured objects. There is no JSON log envelope.
4. **Serverless functions avoid console output entirely**: The `functions/` directory contains zero `console.*` calls. Instead, each function returns a typed result object with an `ok` flag and an `error` string, letting the caller decide how to surface it. This keeps Cloudflare Pages Function logs clean and pushes diagnostics to the response payload.
5. **No log rotation, filtering, or transport**: Logs go straight to the browser DevTools console or the Node/CF runtime stdout. There is no sink abstraction.

## Conventions and constraints

- **Observed convention (descriptive)**: New log statements should use a `[subsystem]` bracketed prefix followed by a human-readable message, matching the existing pattern across `src/`.
- **Observed convention (descriptive)**: Server-side helpers in `functions/_shared/` should not print to console; they should return structured results so callers can handle or forward errors.
- **Constraint enforced by dependency manifest**: No third-party logging library is declared in `package.json`; adding one would require an explicit dependency addition.
- **Constraint inferred from deployment model**: Because this is a PWA served via Vite + Cloudflare Pages, client-side logs are only visible in developer tooling (browser DevTools) and cannot be centrally collected without introducing an external telemetry service — which the repo does not currently do.