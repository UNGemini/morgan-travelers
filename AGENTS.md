# AGENTS.md

Start here; route to the canonical owners below before re-deriving anything.

## Canonical owners
- Product intent & scope: [`MORGAN Travelers PRD.md`](./MORGAN%20Travelers%20PRD.md)
- Maintained knowledge tree (architecture, module docs, conventions): `.qoder/repowiki/en/` and `.qoder/repowiki/knowledge/en/`
- Transit-data overrides workflow: `docs/local-overrides.md`

## Always-needed constraints
- Gate every code change with `npm run check` (syntax + production build) before review.
- Functions under `functions/` return structured `{ok:false, error}` JSON with an explicit status — never throw raw or reply with an opaque 500.
- Frontend diagnostics use `[tag]`-prefixed console calls (e.g. `[eta]`).
- Never hand-edit generated artifacts (`dist/`, `public/fares/hk-fares.json`, `artifacts/`); regenerate them with the npm scripts.
- For transit-data corrections, follow the overrides flow in `docs/local-overrides.md` instead of patching generated sources.
