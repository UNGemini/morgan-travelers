# Static overrides

Hand-maintained corrections that **must not** be replaced by open-data collect or `build:fares`.

| File | Purpose |
|------|---------|
| `lrt.json` | Light Rail stop/platform pins + track shape overrides (e.g. Tin Wing YOHO West) |
| `mtr-access-pins.json` | MTR station pins locked against `stations.geojson` merge |
| `bus-shapes.json` | Reviewed **bus path** polylines (bundled fallback). **Live source of truth** is the separate GitHub repo `morgan-travelers-overrides` — see that repo’s README. |

## Rules

1. Edit these files in git; never generate them from the collect pipeline.
2. GitHub Action **Collect open data** only PRs `public/fares/*` — not this folder.
3. App loads them at runtime from `BASE_URL/overrides/…` (Vite `public/`).

## Adding an LRT shape override

```json
{
  "id": "from_to_unique",
  "from_match": ["stop name fragment"],
  "to_match": ["stop name fragment"],
  "coordinates": [[lon, lat], [lon, lat]]
}
```

## Bus path contributions (serverless + moderators)

Contributors use **About → Contribute route path**. Primary submit hits the
**serverless** endpoint (no always-on backend):

```
POST /api/contribute-path  →  functions/api/contribute-path.js  (Cloudflare Pages)
```

Same-origin under COEP. Optional notify/storage via Pages bindings.

### Cloudflare Pages setup (optional but recommended)

| Binding / env | Purpose |
|---------------|---------|
| `CONTRIBUTIONS` (KV) | Store pending drafts (~90 day TTL) |
| `CONTRIBUTIONS_BUCKET` (R2) | Store full JSON files |
| `RESEND_API_KEY` | Email mods via [Resend](https://resend.com) |
| `CONTRIBUTE_TO` | Inbox (default `contributions@morgandev.cc`) |
| `CONTRIBUTE_FROM` | Verified sender for Resend |
| `CONTRIBUTE_WEBHOOK_URL` | Discord/Slack webhook |

Without bindings the API still **validates** and returns `accepted: false`; the
app falls back to **download + mailto**.

Local dev: Vite writes accepted drafts to `artifacts/contributions/`.

See root `wrangler.toml` for binding stubs.

### Other serverless proxies (already in `functions/`)

| Path | Upstream |
|------|----------|
| `/geocode/*` | Nominatim |
| `/osrm/*` | OSRM |
| `/eta/*` | KMB / CTB / NLB / MTR open data |

### Overrides GitHub repo (upload · merge · fetch)

Preferred workflow is the dedicated repo:

**https://github.com/UNGemini/morgan-travelers-overrides/**

```
bus-shapes.json      ← published (app fetches this by default)
pending/*.json       ← PRs from Submit for review
scripts/merge-pending.mjs
```

1. App default fetch URL:  
   `https://raw.githubusercontent.com/UNGemini/morgan-travelers-overrides/main/bus-shapes.json`
2. Set Pages secrets `OVERRIDES_REPO=UNGemini/morgan-travelers-overrides` + `OVERRIDES_GITHUB_TOKEN` so submit opens a PR into `pending/`.
3. Mod: review PR → Actions **Merge pending contribution** (or run `merge-pending.mjs`) → merge to `main`.
4. Clients pick up the new shapes on next load (`cache: no-cache`).

Sync into this app’s offline bundle:

```bash
npm run sync:bus-shapes
# or: OVERRIDES_BUS_SHAPES_URL=https://raw.githubusercontent.com/UNGemini/morgan-travelers-overrides/main/bus-shapes.json node scripts/sync-bus-shapes-from-remote.mjs
```

### Review checklist (manual / local)

1. Fetch draft from GitHub PR `pending/`, KV/R2/email, or contributor JSON.
2. Confirm `route_short_name`, `agency`, `from_match` / `to_match` make sense.
3. Spot-check `coordinates` on a map (lon, lat order — GeoJSON style).
4. `node scripts/merge-pending.mjs pending/<id>.json` in the **overrides** repo.
5. Push `bus-shapes.json` (or merge the workflow commit).

### Entry shape

```json
{
  "id": "nlb_38_yat_tung_tung_chung",
  "status": "published",
  "agency": "NLB",
  "route_short_name": "38",
  "route_id_match": ["NLB-38"],
  "from_match": ["yat tung"],
  "to_match": ["tung chung mtr", "tung chung station"],
  "direction": "to Tung Chung",
  "notes": "via Mei Tung Street approach",
  "coordinates": [[113.9359, 22.2821], [113.9402, 22.2896]],
  "visual_stops": [
    {
      "stop_id": "NLB-…",
      "name": "Mei Tung Street",
      "seq": 3,
      "official": [113.9410, 22.2880],
      "visual": [113.9405, 22.2882]
    }
  ],
  "contributor": "name",
  "submitted_at": "2026-07-31T12:00:00.000Z"
}
```

- **`coordinates`**: path polyline (road alignment).
- **`visual_stops`** (optional): map pin positions for this route only.
  - `official` is the open-data stop (fixed, used for identity / merge).
  - `visual` is where the pin should sit on the map after publish.
  - Routing / ETA still use open-data stop ids; only map display changes.

Never commit drafts with `"status": "pending_review"` into production
`bus-shapes.json` — keep only approved paths.
