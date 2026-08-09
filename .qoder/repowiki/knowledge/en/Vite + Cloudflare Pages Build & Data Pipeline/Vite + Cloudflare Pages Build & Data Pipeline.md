---
kind: build_system
name: Vite + Cloudflare Pages Build & Data Pipeline
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - vite.config.js
    - wrangler.toml
    - .github/workflows/pipeline.yml
    - .github/workflows/collect-open-data.yml
    - scripts/build-fares.mjs
    - scripts/collect-open-data.mjs
    - scripts/generate-metadata.mjs
    - scripts/sync-maplibre-worker.mjs
    - scripts/sync-bus-shapes-from-remote.mjs
---

## Build System Overview

MORGAN Travelers is built as a Vite-based single-page PWA and deployed to Cloudflare Pages. The build pipeline combines three layers: (1) a Node.js script-driven data preprocessor that downloads, parses, and packages transit data into static artifacts under `public/`; (2) a Vite build that compiles the MapLibre frontend and emits a `dist/` bundle; (3) GitHub Actions workflows that periodically refresh open-data sources, rebuild fare tables, sync routing artifacts to Cloudflare R2, and publish PRs when data changes.

### Toolchain

- **Build tool**: Vite 6 (`vite.config.js`). Output target `es2022`, sourcemaps enabled, assets inlined at 0 bytes, worker format `es`, `.wasm` files included via `assetsInclude`. Dev server runs on port 5173 with `base: "/"` so the PWA never resolves relative asset paths incorrectly.
- **Runtime / deployment target**: Cloudflare Pages, configured by `wrangler.toml` (`pages_build_output_dir = "dist"`, `compatibility_date = "2024-11-01"`). Functions live in `functions/` and are served alongside the static site.
- **Package manager**: npm with `package-lock.json`. The project is private (`"private": true`) and declares only runtime dependencies (`maplibre-gl`, `pmtiles`, `@protomaps/basemaps`) plus dev deps (`vite`, `playwright`).
- **CI**: GitHub Actions. Two workflows — `pipeline.yml` (daily GTFS/R2 sync) and `collect-open-data.yml` (twice-weekly fare refresh).

### Pre-build / Post-install Hooks

`package.json` scripts orchestrate artifact generation:
- `postinstall`: copies the MapLibre GL worker JS/WASM into `public/maplibre/` via `scripts/sync-maplibre-worker.mjs`.
- `predev` and `prebuild`: run both `sync-maplibre-worker.mjs` and `build-fares.mjs` before Vite starts or builds, ensuring the client-side fare pack and MapLibre worker exist.
- Dedicated scripts for data tasks: `build:fares`, `schemes:sync`, `schemes:summarize`, `schemes:nlb`, `collect:open-data`, `generate-metadata`, `sync:bus-shapes`, and an `overrides:*` suite for local bus-shape contribution management.

### Data Processing Scripts (`scripts/`)

The repo ships a set of ESM Node scripts that transform raw open data into committed static artifacts:
- `build-fares.mjs` — merges MTR, TD bus/GMB MDBs, and hk-bus-crawling data into `public/fares/hk-fares.json`.
- `collect-open-data.mjs` — downloads mutable open-data sources (GTFS zip, PMTiles, edge graph, metadata) into `artifacts/open-data/`.
- `generate-metadata.mjs` — produces `metadata.json` describing available artifacts and their checksums.
- `merge-nlb-bbi.mjs`, `summarize-bbi.mjs`, `sync-interchange-schemes.mjs`, `sync-bus-shapes-from-remote.mjs`, `overrides-local.mjs`, `sync-maplibre-worker.mjs` — domain-specific data sync helpers.

These scripts are invoked directly from CI jobs and npm scripts; they write output into `public/` (committed) and `artifacts/` (workflow-scoped).

### Vite Dev Server as a Proxy Layer

`vite.config.js` extends far beyond a simple bundler config. It injects a custom plugin that:
- Sets COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`) on every response so the WASM RAPTOR router and SharedArrayBuffer work locally.
- Proxies `/edge`, `/geocode`, `/osrm`, `/eta/*`, and `/eta/mtr-open` to external services (hk-gtfsdata, Nominatim, OSRM, HK open-data APIs), rewriting URLs and injecting CORS/CORP headers so the browser can fetch them under COEP.
- Serves `hk.wheelsrouter.gz` as raw octet-stream without gzip encoding to avoid double-decoding.
- Mirrors the Cloudflare Pages Functions API (`/api/auth/*`, `/api/overrides/*`, `/api/contribute-path`) inline in the dev server, including a full GitHub OAuth flow and a local file-backed pending-draft store under `artifacts/contributions/pending/`.

This means the development experience mirrors production Pages Functions behavior without needing a separate server process.

### CI Pipelines

**`pipeline.yml` — GTFS Data Pipeline**
- Runs daily at 16:00 UTC (cron `0 16 * * *`) and on push to workflow files.
- Checks out the repo, sets up Node 22, then either downloads published artifacts from `DATA_PUBLIC_BASE_URL` (`hk.gtfs.zip`, `hongkong.pmtiles`, `mtravelers-graph.dense`) or falls back to fetching them from the edge CDN.
- Generates `metadata.json` via `scripts/generate-metadata.mjs`.
- Syncs artifacts to Cloudflare R2 using `aws-actions/configure-aws-credentials` with `--cache-control public, max-age=86400, stale-while-revalidate=604800` for binaries and short TTL for the manifest.
- Posts a Discord/Slack-compatible webhook notification via `WEBHOOK_URL` secret.
- Uses concurrency group `gtfs-pipeline` with cancel-in-progress.

**`collect-open-data.yml` — Open Data Refresh**
- Runs twice weekly (Mon & Thu at 17:00 UTC) via cron `0 17 * * 1,4`, plus manual dispatch with optional `skip_large` and `open_pr` inputs.
- Installs `mdbtools` (for TD Access MDB → CSV conversion), installs npm deps, then runs `scripts/collect-open-data.mjs` to download all mutable sources into `artifacts/open-data/`.
- Rebuilds `public/fares/hk-fares.json` via `npm run build:fares` and validates matrix sizes.
- Computes SHA-256 checksums of all files under `public/fares`, `public/mtr`, `public/data` and uploads them as workflow artifacts.
- Opens a PR (`chore/open-data-refresh`) when data changed, restricted to `public/fares/hk-fares.json` and `public/fares/mtr-stations.json` — explicitly excludes `public/overrides/**` since those are hand-maintained.

### Environment & Secrets

- Local secrets go in `.env` / `.env.development` and are loaded via `loadEnv("development", …)` in `vite.config.js`.
- Production non-secret variables are committed in `wrangler.toml` under `[vars]` (e.g., `OVERRIDES_REPO`, `OVERRIDES_BASE_BRANCH`).
- Secrets (GitHub tokens, OAuth client secrets, R2 credentials, webhook URL) are managed through the Cloudflare dashboard or `wrangler pages secret put` and referenced via environment variables in CI.
- `.env.example` documents required keys.

### Conventions

- All data transformations are explicit Node ESM scripts under `scripts/`, never embedded in Vite plugins — keeping the build step focused on bundling.
- Mutable transit data is regenerated and committed to `public/` (fares, interchange schemes, bus shapes); hand-edited overrides live under `public/overrides/` and are excluded from automated PRs.
- Large binary artifacts (GTFS, PMTiles, wheelsrouter graph) are not committed to git; they are fetched from the edge CDN during CI and synced to R2.
- Versioning is tracked in `package.json` (`version: "0.4.0"`) but there is no release tagging automation visible — version bumps appear to be manual.
- The dev server intentionally mirrors production Pages Functions routes so contributors can test contributions locally without deploying.