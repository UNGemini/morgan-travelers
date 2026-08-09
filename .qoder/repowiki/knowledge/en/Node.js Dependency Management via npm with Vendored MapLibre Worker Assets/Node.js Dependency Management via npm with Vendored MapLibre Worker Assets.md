---
kind: dependency_management
name: Node.js Dependency Management via npm with Vendored MapLibre Worker Assets
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - scripts/sync-maplibre-worker.mjs
    - wrangler.toml
---

## What system/approach is used

The project uses **npm** as the sole package manager for Node.js dependencies. All third-party packages are declared in a single `package.json` at the repository root, and versions are locked via `package-lock.json`. There is no monorepo tooling (no `pnpm-workspace.yaml`, `lerna.json`, or `yarn.lock`) — this is a flat, single-package project.

## Key files and packages

- `package.json` — declares runtime dependencies (`maplibre-gl ^6.0.0`, `pmtiles ^4.3.0`, `@protomaps/basemaps ^5.7.2`) and dev dependencies (`vite ^6.3.5`, `playwright ^1.62.0`). The project is marked `private: true` and uses ESM (`type: module`).
- `package-lock.json` — locks exact resolved versions of all transitive dependencies; checked into version control so installs are reproducible.
- `scripts/sync-maplibre-worker.mjs` — vendoring script that copies `maplibre-gl/dist/maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` into `public/maplibre/` to bypass Vite's dependency pre-bundler rewrite of `import.meta.url`, which would otherwise resolve the worker to `/ .vite/deps/...` and break same-origin loading.
- `wrangler.toml` — Cloudflare Pages configuration; no server-side Node dependencies are declared here because Pages Functions run in an isolated environment and do not share the root `node_modules`.

## Architecture and conventions

### Runtime vs. build-time separation
Runtime browser dependencies are kept minimal and pinned to major-version ranges (`^6.0.0`, `^4.3.0`, `^5.7.2`), while build tooling (`vite`, `playwright`) lives under `devDependencies`. This keeps production bundles small and avoids shipping test/build tooling to the client.

### Vendoring strategy for binary/WASM assets
Instead of relying on Vite's dynamic resolution for MapLibre GL's WebAssembly worker, the project explicitly vendors the worker `.mjs` files by copying them from `node_modules/maplibre-gl/dist/` into `public/maplibre/` during install/build. The copy is gated by existence checks and runs automatically via npm lifecycle hooks:
- `postinstall` — runs after `npm install`
- `predev` / `prebuild` — runs before development server or production build
This ensures the worker files are always present regardless of how the project is built locally or in CI.

### Data-driven dependencies
Several scripts under `scripts/` download external transit data (bus shapes, interchange schemes, fare tables) at build time rather than declaring them as npm packages. These are treated as generated artifacts committed to the repo (e.g. `public/data/*.json`, `public/fares/*.json`, `src/pkg/wheels_router_nano.*` WASM bundle). The `collect:open-data` and `schemes:*` scripts orchestrate these downloads.

### No private registry or scoped packages beyond public npm
All dependencies come from the public npm registry. There is no `.npmrc`, no `registry=` override, no GitHub Packages usage, and no `GOPRIVATE` or Go modules (the project is JavaScript/TypeScript only aside from one `.ts` file compiled by Vite).

## Conventions and constraints

- **Version pinning**: Runtime dependencies use caret ranges (`^major.minor.patch`), allowing minor/patch updates but locking majors — consistent with semantic versioning expectations for stable libraries like `maplibre-gl` and `pmtiles`.
- **Lockfile enforced**: `package-lock.json` is committed, so every developer and CI gets identical dependency trees. New dependencies must be added via `npm install --save` / `--save-dev` to update both manifests.
- **Lifecycle hook gating**: Build-time side effects (MapLibre worker sync, fare table generation) are expressed as npm scripts bound to `postinstall`, `predev`, and `prebuild`, ensuring they cannot be accidentally skipped during normal workflows.
- **No shared workspace**: Because there is only one `package.json`, there is no cross-package dependency sharing convention to document.
- **Cloudflare Functions have no local deps**: Serverless functions under `functions/` rely only on Node built-ins and fetch APIs; any external library would need to be bundled inline or provided via the Pages build pipeline, since `wrangler.toml` does not declare a `node_modules` directory for functions.