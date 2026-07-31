# Local overrides testing

Test **fetch → contribute → merge → reload** without Cloudflare or GitHub tokens.

## Layout

```
Documents/Projects/
  MorganTraveler/                 ← this app (npm run dev)
  morgan-travelers-overrides/     ← sibling repo (pending + bus-shapes.json)
```

If the sibling folder is missing, drafts go to `artifacts/contributions/pending/`.

## Start

```bash
cd MorganTraveler
npm run dev
```

### Submit UI (loading + result)

On **Submit for review**:
1. Choose **GitHub account (Recommended)** or **Bot account**
2. Site blurs and **Submitting…** shows
3. Result popup: Success / Failed
4. **Visit your PR** (GitHub) or **View local draft** (no PR)
5. **Download JSON copy** / **Copy JSON** (manual — not auto-download)

### Submit modes

| Mode | Who opens the PR | Needs |
|------|------------------|--------|
| **GitHub account** (default) | Contributor’s fork → PR as them | OAuth App + user login |
| **Bot account** | Site token on upstream | `OVERRIDES_GITHUB_TOKEN` |

#### OAuth (recommended)

1. Create a [GitHub OAuth App](https://github.com/settings/developers):
   - **Homepage URL:** `http://127.0.0.1:5173` (and production origin)
   - **Authorization callback URL:** `http://127.0.0.1:5173/api/auth/callback`
2. Put secrets in `.env` (not committed):

```bash
GITHUB_OAUTH_CLIENT_ID=Iv1.xxxxxxxx
GITHUB_OAUTH_CLIENT_SECRET=xxxxxxxx
# optional explicit callback:
# GITHUB_OAUTH_REDIRECT_URI=http://127.0.0.1:5173/api/auth/callback
```

3. Restart `npm run dev`, open Contribute, click **Log in with GitHub**, then Submit.

Dev mirrors production routes: `/api/auth/github`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`.

#### Bot mode

```bash
# .env
OVERRIDES_GITHUB_TOKEN=github_pat_xxxxxxxx
OVERRIDES_REPO=UNGemini/morgan-travelers-overrides
OVERRIDES_BASE_BRANCH=main
```

Restart `npm run dev`, pick **Bot account**, Submit — popup should show **Visit your PR**.

Without a bot token (and not using OAuth), drafts still save to `pending/` and the popup links to  
`/api/overrides/review/<id>` (merge button on that page).

Open the app, then check the local API:

```bash
curl -s http://127.0.0.1:5173/api/overrides/status | jq
```

You should see `overrides_repo_path`, `published_routes`, and `pending_files`.

## Flow

### 1. Fetch published shapes

In **dev**, the app loads:

`/api/overrides/bus-shapes.json` → `../morgan-travelers-overrides/bus-shapes.json`

Console: `[overrides] bus shapes N (local-dev-api)`.

### 2. Contribute (Submit for review)

Use **About → Contribute**, load/edit a path, **Submit**.

Dev server writes:

- `../morgan-travelers-overrides/pending/<id>.json`
- `artifacts/contributions/<id>.json`

```bash
curl -s http://127.0.0.1:5173/api/overrides/pending | jq
```

### 3. Merge pending → published

**HTTP:**

```bash
curl -s -X POST http://127.0.0.1:5173/api/overrides/merge \
  -H 'Content-Type: application/json' \
  -d '{"file":"pending/kmb_e42_pok_hong_airport_gtc.json"}' | jq
```

Dry-run:

```bash
curl -s -X POST http://127.0.0.1:5173/api/overrides/merge \
  -H 'Content-Type: application/json' \
  -d '{"file":"pending/….json","dry_run":true}' | jq
```

**CLI:**

```bash
npm run overrides:merge -- pending/<id>.json
# or from the overrides repo:
cd ../morgan-travelers-overrides
node scripts/merge-pending.mjs pending/<id>.json
```

Merge also copies into `public/overrides/bus-shapes.json`.

### 4. Reload app shapes

Hard-refresh the browser (or restart dev). Status should show the new route count.

Optional:

```bash
curl -s -X POST http://127.0.0.1:5173/api/overrides/reload-public
npm run sync:bus-shapes   # from GitHub raw instead
```

## API summary (dev only)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/auth/me` | Session + whether OAuth is configured |
| GET | `/api/auth/github` | Start OAuth (`?return_to=/`) |
| GET | `/api/auth/callback` | OAuth callback → session cookie |
| POST | `/api/auth/logout` | Clear session |
| GET | `/api/overrides/status` | Paths, pending list, route count |
| GET | `/api/overrides/bus-shapes.json` | Published shapes |
| GET | `/api/overrides/pending` | List pending drafts |
| POST | `/api/contribute-path` | Save draft → `pending/` (+ PR). Body: `submit_mode: "oauth"\|"bot"` |
| POST | `/api/overrides/merge` | `{ "file": "pending/x.json" }` |
| POST | `/api/overrides/reload-public` | Copy shapes → `public/overrides/` |

## Env

| Variable | Effect |
|----------|--------|
| `OVERRIDES_REPO_PATH` | Absolute path to overrides repo (default: sibling folder) |
| `VITE_OVERRIDES_BUS_SHAPES_URL` | Force fetch URL (skip local API / use GitHub raw) |
| `OVERRIDES_GITHUB_TOKEN` | Bot-mode PAT for opening PRs |
| `OVERRIDES_REPO` | Target repo (default `UNGemini/morgan-travelers-overrides`) |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | OAuth App for “GitHub account” submit |
| `GITHUB_OAUTH_REDIRECT_URI` | Optional fixed callback URL |

See `.env.development` and `.env.example`.

## Production (Cloudflare Pages)

Secrets:

| Secret | Purpose |
|--------|---------|
| `OVERRIDES_REPO` | e.g. `UNGemini/morgan-travelers-overrides` |
| `OVERRIDES_GITHUB_TOKEN` | Bot PAT (Contents + PRs on overrides repo) |
| `GITHUB_OAUTH_CLIENT_ID` | OAuth App client id |
| `GITHUB_OAUTH_CLIENT_SECRET` | OAuth App secret |
| `GITHUB_OAUTH_REDIRECT_URI` | `https://YOUR_DOMAIN/api/auth/callback` |

OAuth App callback must match production URL. Contributors pick **GitHub account** (fork PR as them) or **Bot account** in the contribute UI.
