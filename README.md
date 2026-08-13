# MORGAN Travelers

<p align="center">
  <img src="public/logowithtext.png" alt="MORGAN Travelers" width="360" />
</p>

<p align="center">
  Hong Kong transit — trip planner, live ETAs, and a map that runs on your device.
</p>

<p align="center">
  <a href="https://travelers.morgandev.cc">Open the app</a>
  ·
  <a href="https://github.com/UNGemini/morgan-travelers">GitHub</a>
</p>

**MORGAN Travelers** is a free Progressive Web App for Hong Kong commuters. Nearby arrivals, door-to-door plans, and route maps all run in the browser — including a WASM RAPTOR router — so you can install it to the home screen without an app store.

English · 廣東話 · 繁體中文 · 简体中文 · 日本語 · 한국어

---

## What it does

- **Nearby** — routes around you (or a map tap), with live ETAs
- **Trip Plan** — From / Via / To, departure time, Usual or Holiday service, fare type
- **Route detail** — full stop list, opposite direction, branch switch, pin a stop
- **Pinned** — saved stops and trip plans
- **Offline** — optional on-device cache for the routing graph, fares, and basemap
- **Live buses (beta)** — predicted positions stitched from nearby ETAs (not official GPS)

Modes covered: **MTR**, **Light Rail**, **KMB / LWB**, **Citybus**, **NLB**, **GMB**, **MTR Bus**, **RBS**, plus walking and Airport Express where the graph has them.

---

## Stack

| Layer | Choice |
| --- | --- |
| App | Vite PWA · MapLibre GL · liquid-glass UI |
| Routing | [wheels-router-nano](https://github.com/wheelstransit/wheels-router-nano) (Rust → WASM, RAPTOR) |
| Map | Protomaps / PMTiles from OpenStreetMap |
| Transit data | Hong Kong open data, compiled to a dense routing graph |
| Hosting | Cloudflare Pages (plus thin proxies for geocode, ETA, OSRM) |

There is no always-on application server. The planner runs locally after the graph download.

---

## Quick start

```bash
git clone https://github.com/UNGemini/morgan-travelers.git
cd morgan-travelers
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

- **`npm run dev`** — hot reload. Service worker and offline cache are **off** on the Vite port.
- **`npm run build && npm run preview`** — production build, including the service worker. Use this to test install / offline.
- **`npm run check`** — syntax-check `src/`, `scripts/`, `functions/` and run a production build.

Node 20+ recommended.

---

## How to use it

**Nearby** — allow location, or tap the map. Search a route number or `@MTR` / `@LRT` / `@Bus`. Open a card for the stop list and live arrivals.

**Trip Plan** — set From and To (search or map). Add one or more **Via** stops to meet someone. Pick departure time (Hong Kong, UTC+8), Usual vs Holiday, ticket type, and which operators you want. Open a result for the full itinerary; **Show route details** jumps to that line’s stop list.

**Pin** — pin a stop from route detail, or a whole plan from the results / trip page. They show up under **Pinned**.

**Install** — in Safari or Chrome, Add to Home Screen. Onboarding covers language, terms, ticket type, optional offline data, and beta toggles.

---

## Project layout

```
index.html          App shell
src/                UI, planner wrapper, ETA, fares, i18n
src/pkg/            Bundled WASM router
public/             Icons, manifest, static GTFS-derived files, overrides
functions/          Cloudflare Pages functions (geocode, ETA, OSRM, contribute)
scripts/            Fare / shape / schedule builders and `check`
docs/               Overrides and contributor workflow
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local Vite server |
| `npm run build` | Production bundle → `dist/` |
| `npm run preview` | Serve `dist/` with the service worker |
| `npm run check` | Syntax + production build |
| `npm run build:fares` | Rebuild fare tables |
| `npm run collect:open-data` | Pull government open data used by the pipeline |

Generated files (`dist/`, `public/fares/hk-fares.json`, `artifacts/`) should be regenerated, not hand-edited.

---

## Data & licensing

- **Main app** © UNLOOP MORGAN 2026, [Apache License 2.0](LICENSE).
- **Live Position Engine** (`src/busPositionEngine.js`, `src/trafficSpeed.js`, `src/busSchedules.js`) is [GNU GPLv3](licenses/GPL-3.0.txt) only.
- **Branding is not licensed.** Apache 2.0 §6 does not grant trademarks. “MORGAN”, “UNLOOP MORGAN”, “Travelers”, logos, and product naming may not be used for a fork or other product without written permission.
- Routing engine: wheels-router-nano (MIT).
- Basemap: OpenStreetMap contributors · [Protomaps](https://github.com/protomaps/basemaps).
- Transit and fare inputs: Transport Department, MTR, and other Hong Kong open-data sources. Their terms still apply to the data itself.

The GTFS *compiler* used in CI is a separate pipeline (wheels-router-nano / community-gtfs ecosystem) and is not shipped in this repo.

---

## Contributing path data

Wrong bus alignment on the map? **About → Contribute route path** (desktop). Reviewed paths live in [`morgan-travelers-overrides`](https://github.com/UNGemini/morgan-travelers-overrides).

Local fetch → edit → merge without Cloudflare is documented in [`docs/local-overrides.md`](docs/local-overrides.md). Bundled override files are described in [`public/overrides/README.md`](public/overrides/README.md).

---

## Links

- App: [travelers.morgandev.cc](https://travelers.morgandev.cc)
- Overrides: [UNGemini/morgan-travelers-overrides](https://github.com/UNGemini/morgan-travelers-overrides)
- Product notes: [`MORGAN Travelers PRD.md`](MORGAN%20Travelers%20PRD.md)
