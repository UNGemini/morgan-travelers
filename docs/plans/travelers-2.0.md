# Travelers 2.0 — Product & Engineering Plan

**Status:** Draft for review · **Owner:** UN_Gemini · **Last updated:** 2026-10-14

Companion document: [`unloop-id.md`](./unloop-id.md) (identity, auth, entitlements, OAuth portal).

---

## 1. Thesis

Travelers today is a **single-file-logic PWA** with a very strong offline/data core: a WASM RAPTOR graph, MapLibre + PMTiles, per-operator ETA proxies, a staged offline cache, six languages, and a beta on-device live-position engine.

2.0 turns that core into **three surfaces (web, iOS, Android)** with **four new capabilities** layered on it:

| New capability | One-line value |
| --- | --- |
| **Predicted positions** | Every route has a day-tested timetable of segment/dwell times, so the app can show plausible bus positions with **zero live requests**. |
| **Pro (HK$18/mo)** | Live per-route calculation on demand; a watcher runs only while Pro users are actually looking at a route. |
| **GPS-track contribution** | Riders contribute segment times + dwell (not their location) to improve prediction; averages only. |
| **UNLOOP ID accounts** | Pro, pinned routes, settings and plan preferences sync — while every non-signed-in feature keeps working exactly as today. |

Plus two smaller but real workstreams: **Liquid Glass UI** across web + native, and **verified contributors** with editable section fares.

### Design principles

1. **Local-first stays.** Signing in is an additive upgrade, never a gate. Guest = 2.0 feature-complete except Pro.
2. **Data contracts over shared code.** Web and native share JSON/pack contracts and fixtures, not a monolith.
3. **No continuous location collection.** Contribution is aggregated per segment before it leaves the device.
4. **Cheap by default, expensive on demand.** Baseline predictions are precomputed and CDN-served; live work only runs for Pro with an active viewer and stops by itself.

---

## 2. Current state (what we build on)

| Area | Today | 2.0 impact |
| --- | --- | --- |
| Frontend | Vite 6, **vanilla JS** (no React), ~17k-line `main.js`, CSS-variable glass system | Glass refactor must not require a framework |
| Map | MapLibre GL JS + PMTiles basemap | Native apps need MapLibre Native + PMTiles |
| Routing | `wheels-router-nano` WASM RAPTOR graph (built in the external pipeline repo) | Native needs the same engine as a native lib |
| ETA | Cloudflare Pages Functions proxies (`kmb`, `ctb`, `nlb`, `mtr`, `gmb`, `mtr-open`, `mtr-alert`) | Same proxies serve the watcher + collector |
| Offline | Staged SW precache, per-route packs, offline manifest | Predicted-position packs join the same manifest |
| Position engine | Beta **on-device** live-position engine (`busPositionEngine.js`) | Becomes the free-tier renderer fed by predicted packs |
| Contribution | `contributePath.js` → `functions/api/contribute-path.js` → GitHub PR + `pipeline-rs` rebuild | Section fares + verified roles extend this |
| Identity | None (GitHub OAuth only, for contribution) | UNLOOP ID becomes the identity layer |
| Known gaps | Walking geometry uses the **car** OSRM profile (no pedestrian graph) | Out of 2.0 scope; keep the chord/“interchange or full walk” policy |

---

## 3. Workstream A — Liquid Glass UI (web, mobile & desktop)

### 3.1 Library decision

| Library | What it is | Verdict |
| --- | --- | --- |
| [`0kzh/glisse`](https://github.com/0kzh/glisse) | React/TSX components ("iOS 26 Liquid Glass for the web"), MIT | **Not a dependency** — our app has no React. Use as a **visual/behaviour reference** and for the component spec (press squish, tint, edge highlight) |
| [`gentpan/liquidglass`](https://github.com/gentpan/liquidglass) | Vanilla **web components** + zero-dependency refraction engine (SVG `feDisplacementMap` on the element's **own** pixels); Chrome/Safari/Firefox; `createGlass()` core API; MIT | **Primary dependency** — matches our stack exactly |

Key technical property to design around: refraction only works over an image/canvas the engine can re-sample; over **arbitrary page content** Safari/Firefox fall back to **frosted blur** (Chromium refracts). Our app is a full-bleed WebGL map, so:

- **Over the map → frosted blur** (never `backdrop-filter: url()`, which only Chromium renders).
- **Over panels/images → true refraction**, using `data-lg-backdrop` regions.
- Keep the existing hard rule from v1: **floating alert cards get no backdrop blur** (motion cost + it smeared content). Glass is for chrome, not for notifications.

### 3.2 Token architecture

Extend today's `--glass-rgb` / `--glass-border` into a two-layer system:

```
primitive  --lg-blur, --lg-refraction, --lg-dispersion, --lg-tint-rgb, --lg-tint-alpha,
           --lg-edge-light, --lg-shadow, --lg-radius, --lg-spring-*
semantic   --surface-{dock|sheet|card|menu|toast}-{fill|edge|shadow},
           --control-{fill|edge|press-scale}, --focus-ring
component  --dock-*, --sheet-*, --btn-*, --segmented-*
```

Rules: every glass surface also defines an **opaque fallback** (`prefers-reduced-transparency`, battery saver, unsupported engine) and a **reduced-motion** variant (no spring/refraction). Contrast checked against the worst-case map tile behind it.

### 3.3 Component mapping

| Today | 2.0 |
| --- | --- |
| `.offline-banner` / `.beta-banner` | `--surface-toast` (solid, no blur — unchanged behaviour) |
| `.main-toolbar` + `.sheet-chrome` | `--surface-sheet`; grabber + title row become a glass "rod" with edge highlight |
| `.app-bottom-nav` tabs | `--surface-dock` + `<lg-segmented>`-style sliding lens for the active tab |
| `.panel-profile-btn`, dir-switch buttons | `--control-*` capsules with press squish |
| `.profile-menu`, `.eta-*` cards | `--surface-menu`, `--surface-card` |
| Onboarding toggles/selects | Reuse `lg-switch` / `lg-slider` visual spec (keep our iOS-style toggle CSS as the fallback) |

### 3.4 Rollout

1. Tokens + fallbacks (no visual change yet).
2. Chrome surfaces (dock, sheet header, buttons) behind a `?glass=2` flag; screenshot-compare in Chrome/Safari/Firefox.
3. Map-overlay surfaces (cards, menus, toasts) with frosted-blur fallback.
4. Remove legacy glass CSS once parity is confirmed on iOS PWA (the strictest target).

**Exit criteria:** 60 fps during sheet drag on an iPhone 11-class device; no glass on a surface that scrolls a long list; all 6 languages unaffected.

---

## 4. Workstream B — Native apps (iOS & Android)

### 4.1 Options

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Capacitor wrapper** | Days, reuses everything, offline already solved | Not "native"; no real Liquid Glass; WebView map perf | Fallback only |
| **React Native + MapLibre RN** | One codebase, big ecosystem | WASM RAPTOR can't run on Hermes; a second JS runtime for the map; still no native glass | No |
| **Native shells + shared Rust core** | True Liquid Glass (iOS 26 `glassEffect`, Android RenderEffect), MapLibre Native, best perf, same graph | Two UIs to build; core must be compiled per platform | **Recommended** |

### 4.2 Recommended shape

```
                  ┌───────────────────────────────┐
  Web (Vite PWA)  │  contracts/  (JSON schemas +    │  iOS (SwiftUI)  Android (Compose)
  ───────────────►│  generated fixtures)            │◄─────────────── ─────────────────
                  └───────────────────────────────┘
        │                    ▲                                   ▲
        │                    │                                   │
   WASM RAPTOR        core/ (Rust, UniFFI) ───────────────────────┘
   (same graph)       · RAPTOR plan + ranking      · fare engine
                      · fare/interchange rules     · predicted-position interpolation
```

- **`core/` (new, Rust)** — extract the routing-adjacent logic that must be identical on all three surfaces: graph query, plan ranking, fare/interchange rules, predicted-position interpolation. Exposed via **UniFFI** (Swift + Kotlin bindings) and compiled to WASM for web. CI builds all three targets from one commit.
- **Web** keeps its current JS domain code initially; it migrates to `core/` surface-by-surface, guarded by **conformance fixtures** (real OD pairs + expected plans/fares).
- **Native UI** — SwiftUI (iOS 17+, Liquid Glass on iOS 26+) and Jetpack Compose (Material 3 + custom refractive surfaces on API 31+, frosted fallback below). MapLibre Native + PMTiles, same style JSON as web.
- **Offline** — identical pack contracts as the PWA; the download manager reuses the manifest.

### 4.3 Sequencing

1. `core/` extraction + conformance harness (web still shipping WASM).
2. iOS app: routes/stops/ETA/fares/plan/pinned/offline → TestFlight.
3. Android app: parity with iOS, glass adapted to Material.
4. Retire web-only code paths that `core/` replaced.

**Non-goal for 2.0:** feature parity on day one. Ship iOS first with the 80% that matters (plan, live ETA, pinned, offline), Android ~6 weeks behind.

---

## 5. Workstream C — Pre-calculated positions (predicted timetable)

### 5.1 The key decision: store **statistics**, not positions

Storing a day of raw positions per route is large and brittle. Instead store, per directed stop-pair:

- **travel time** percentiles (p50/p85) per time-of-day bucket,
- **dwell time** p50 per stop,
- **sample counts** per bucket (so the client knows the confidence).

The client already has the interpolation engine and the bus-shape polylines — it converts statistics into an animated marker with no extra geometry.

### 5.2 Pack format

```
public/packs/positions/v1/{operator}/{routeKey}.json.gz      (~1–8 KB gz per direction)

{
  "v": 1,
  "routeKey": "kmb:1A:outbound",
  "generatedAt": "2026-10-14T00:10:00Z",
  "windowDays": 1,
  "bucketMinutes": 30,
  "segments": [
    { "from": "A1", "to": "A2", "distM": 412,
      "dwellP50": 18,
      "travelP50": [95, 92, 110, 260, 240, ...],   // per bucket, seconds
      "n":          [ 44, 40,  31,  12,  19, ...] }
  ],
  "quality": { "coverage": 0.87, "p50AbsErrorSec": 42 }
}
```

Served from R2/CDN with a manifest (`positions/v1/index.json`) listing route keys + hashes; the existing offline downloader adds a **“predicted positions”** scope so users can pre-download the routes they care about.

### 5.3 Collection pipeline (daily Cron Worker)

For each route+direction: fetch the operator's full stop-list ETA on a schedule, and **derive segment times from consecutive stop arrivals** — no vehicle tracking needed. Dwell is inferred from consecutive arrival/departure deltas at the same stop.

- Sampling policy: 06:00–24:00 HKT, every 10 min for **all** routes (coarse), every 3 min for a **hot-list** (top ~200 routes by usage).
- Budget guard: per-operator rate limits, jittered scheduling, backoff on 429/5xx; a hard daily request ceiling.
- Aggregation: robust median per bucket (MAD outlier rejection, clamp to plausible speeds), require `n ≥ 5` before publishing a bucket; otherwise fall back to the adjacent bucket or the all-day median.
- Publishing: atomic R2 write + manifest swap; old packs kept for one version (rollback).

### 5.4 Client behaviour

- Free/guest: marker positions interpolate from the nearest downloaded pack; badge the card “Estimated” with the pack's `generatedAt` age. No live round-trip.
- If a route has no pack, fall back to today's on-device engine behaviour.
- Pro: the same UI switches to the live watcher (§6) — the pack becomes the fallback while live data loads.

**Exit criteria:** ≥ 90% of actively planned routes have a pack; predicted-vs-actual p50 error < 90 s in peak, < 45 s off-peak.

---

## 6. Workstream D — Pro plan (HK$18/month)

### 6.1 Entitlement matrix

| Capability | Free / guest | Pro |
| --- | --- | --- |
| Plan, ETA, fares, offline download, pinned (local) | ✅ | ✅ |
| Predicted positions from packs (no live calc) | ✅ | ✅ |
| **Server-side live calculation per route** | – | ✅ |
| Route watcher (30–60 s cadence, live ETA + positions) | – | ✅ |
| Sync across devices (pinned/settings/prefs) | – (local only) | ✅ |
| Contribution / verified status | ✅ | ✅ |

### 6.2 The watcher

- **Registry**: D1 `route_watch(route_key PK, subscribers, last_viewed_at, started_at, status)`.
- **Runtime**: one **Durable Object per watched route** (`RouteWatcher`) with an alarm every 30–60 s. It polls the operator ETA, folds in pack statistics, and writes a compact live snapshot to KV (`live:{routeKey}`, 20 s cache).
- **Lifecycle**: `start` on a Pro client opening the route view; each view refreshes `last_viewed_at`; the alarm self-cancels when `now − last_viewed_at > 3 days` and the DO is evicted. **No cron scanning needed.**
- **Fan-out**: clients read the KV snapshot (CDN-friendly). WebSocket/SSE is optional later; polling is enough at this cadence and much cheaper.
- **Fair-use**: ≤ 20 concurrently watched routes per account, ≤ 200 watch-starts/day; abuse → cooldown.

### 6.3 Billing

- **iOS / Android**: StoreKit 2 auto-renewable subscription + Play Billing. Apple requires **in-app purchase** for digital subscriptions inside the app; a web-only purchase that unlocks in-app is a review risk (reader-app exception does not apply here).
- **Web**: Stripe Checkout (web purchases are fine; don't deep-link to it from iOS).
- **Entitlement mirror**: App Store Server Notifications V2 / Play RTDN / Stripe webhooks → UNLOOP ID `entitlements` table → short-lived signed entitlement token the clients verify. RevenueCat is an acceptable shortcut for month 1 if it saves two integrations.
- Price shown as **HK$18/month**, with the store's local price tier equivalent for non-HK storefronts; include trial (e.g. 7 days) and proration/refund policy.

### 6.4 Cost model (must be modelled before launch)

Per watched route: 1 DO alarm + ~1 ETA fetch/min + 1 KV write/min. With 500 Pro users and ~150 concurrently watched routes that is ~216k ETA fetches/day — fine for a Worker + D1/KV budget, but the **ETA upstream** limits (public endpoints) are the real constraint. Mitigations: shared cache per route (one fetch serves all viewers), per-operator rate budget, and the 3-day decay so idle routes cost nothing.

---

## 7. Workstream E — GPS-track contribution (segment timing)

**What we collect** (never a continuous location stream):

```
{ routeKey, directionKey, fromStopId, toStopId,
  departedAt, arrivedAt, dwellSec, distanceM,
  mode, accuracyBucket, appVersion, anonDeviceId }
```

- Recorded **only while the user opts in** and is riding; the recorder aggregates **on device** per stop-pair and uploads a batch (Wi-Fi/charging preferred, 1 upload/hour max).
- **No live sharing**, no map display of contributors, no account linkage in the aggregate.

**Server-side aggregation** (`contribute-times` consumer):

1. Validate (speed plausibility 3–25 m/s for buses, dwell 0–300 s), drop the trip if any segment fails.
2. Bucket by `(routeKey, segment, weekday/weekend, 30-min bucket)`.
3. Robust median + MAD; require **≥ 5 distinct anon devices** before a bucket is published (k-anonymity).
4. Blend with ETA-derived statistics: contributed data gets a weight that grows with `n` and with agreement with the ETA series (disagreement → lower weight, logged for review).
5. Publish into the same pack format (§5.2) — one code path for the client.

**Retention & privacy:** raw batches ≤ 30 days, then only aggregates; `anonDeviceId` rotates every 90 days; opt-out deletes pending batches and the device's rows. Documented in-app before any recording.

---

## 8. Workstream F — Contribution mode: editable section fares

Today: path contribution → `functions/api/contribute-path.js` → GitHub PR → pipeline rebuild.

Add a **fare-edit** mode:

- UI: in section-fare tables, values become editable fields **only for verified contributors**; everyone else sees read-only values plus “Suggest a correction”.
- Payload: `{ routeKey, sectionId, fromStopId, toStopId, ticketType, amount, currency, effectiveFrom?, sourceNote }`.
- Server enforcement (never UI-only):
  - unverified → appended to a **suggestion queue** (review UI, can be promoted to a PR);
  - verified → validated against the operator's fare bounds, written to a `pending-fares` branch, PR opened automatically, `pipeline-rs` rebuild triggered;
  - every action audited (who, when, old → new, PR link).
- Guardrails: rate limits per contributor, two-person review for values above a delta threshold, and a revert path (the pack version is pinned in the PR).

---

## 9. Workstream G — Verified contributors

- **Role** `verified_contributor` lives in UNLOOP ID (see §10 and `unloop-id.md`), optionally linked to a GitHub account for the PR flow.
- **Application portal** (web + in-app): form → rationale + evidence (screenshots, operator source links) → manual review queue.
- **Entry criteria:** ≥ 3 accepted contributions with no reverts in 90 days, or manual grant for operator/staff.
- **Badges:** profile badge + “verified” chip next to edits; **revocation** on bad edits with an audit trail.
- Verified status is **per capability** (`path`, `fares`, `stops`) so trust is scoped.

---

## 10. Workstream H — Accounts & sync (UNLOOP ID)

- **Guest mode is the default** and stays feature-complete (§6.1). Sign-in only adds sync + Pro.
- **Sync scopes**: `pinned`, `settings`, `planPrefs` (home/work, ticket type, walk speed, preferences).
- **Model**: per-item documents with `updatedAt` + tombstones; last-writer-wins per field; deterministic tie-break by device id. No merge UI for v1 — conflicts surface only for destructive deletes.
- **Transport**: `GET /v1/sync/{scope}?since=` / `PUT /v1/sync/{scope}` (batch, idempotent, ETag). Offline queue in IndexedDB, flushed on reconnect.
- **Privacy**: pinned routes are personal; allow **optional E2E encryption** of the `pinned` scope with a key derived from the user's passkey (phase 2) — the server then cannot read it.

---

## 11. Cross-cutting

| Concern | Plan |
| --- | --- |
| **Security** | All entitlements/roles enforced in Workers; signed entitlement tokens; no secrets in the app; rate limits per IP + per account |
| **Privacy (HK PDPO)** | Data minimisation, purpose limitation, documented retention, export + delete in-app; contribution consent screen |
| **Operator data** | Keep data.gov.hk attribution; respect operator ToS for ETA polling; the collector must be polite (jitter, backoff, ceilings) |
| **i18n** | New strings land in all six dictionaries (en + zh-hk/zh-tw/zh-cn/ja/ko); `npm run check` gates dict alignment |
| **Telemetry** | Pack coverage, predicted-vs-actual error, watch duration, conversion; no PII; opt-out toggle |
| **Testing** | Contract fixtures per pack/API; golden tests for fare + plan conformance across web/native; manual device matrix (iPhone 11/13/15, Pixel 6/8, mid Android) |
| **Release** | Web: Cloudflare Pages on `main`. iOS: TestFlight → App Store. Android: internal → closed → production |

---

## 12. Roadmap

Estimates assume **2–3 engineers** (one native-focused); they are indicative, not commitments.

| Phase | Ships | Content | ~Weeks |
| --- | --- | --- | --- |
| **P0 — Foundations** | Web | Glass tokens + chrome surfaces; `core/` extraction scaffold + fixtures; UNLOOP ID alpha (passkey + email OTP) sign-in; sync for `pinned` only; verified-contributor role plumbing | 6–8 |
| **P1 — Data & Pro (web)** | Web | Predicted-position collector + packs + client renderer; Pro entitlements + Stripe (web) + watcher (single-route); section-fare editing + suggestion queue; contributor portal | 8–10 |
| **P2 — iOS** | iOS | Native shell (SwiftUI + MapLibre Native + UniFFI core), Liquid Glass on iOS 26, offline packs, StoreKit 2, sync + live watcher | 12–16 |
| **P3 — Android + ecosystem** | Android | Compose shell, Play Billing, Material-adapted glass; Tactico OAuth portal; Roblox linkage | 10–14 |

**Milestone gates:** P1 ends with predicted packs for ≥ 90% of planned routes and a working paid watch on web. P2 ends with App Store submission. Every phase keeps **guest parity** — no feature regressions for signed-out users.

---

## 13. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Native UI is a second product | 2× design/QA cost | iOS first, 80/20 scope, shared contracts + `core/`; Cap/wrapper fallback if timeline slips |
| Public ETA endpoints rate-limit the collector | No fresh packs | Sample coarse; hot-list only; backoff; shared cache; negotiate/host fallback |
| Apple rejects web-purchased Pro | Lost revenue, review loop | StoreKit 2 in-app; no cross-links from iOS; clear entitlement wording |
| Glass perf on old devices | Janky drag | Frosted-only on the map, refraction only over images/panels, 60 fps gate, opaque fallback |
| Contribution abuse / bad data | Wrong positions | k-anonymity ≥ 5, MAD rejection, plausibility bounds, weighted blend, revert path |
| Prediction quality in incidents | Trust damage | Detour/incident detection (MTR status feed already exists), “Estimated” labelling, automatic fallback to live for Pro |
| Account takeover without passwords | Reputational | WebAuthn-only sign-in, generic OTP responses, device binding, step-up for sensitive actions, audited recovery |

---

## 14. Open questions

1. **Native scope:** is iOS parity with the PWA required for 2.0, or is “plan + live + pinned + offline” enough for launch?
2. **Pro scope on web:** is web Pro sold with Stripe from day one, or StoreKit-only until the native apps ship?
3. **Pack distribution:** per-route downloads only, or also a “top 100 routes” bundle for new installs?
4. **Contribution pricing:** do verified contributors get Pro for free as an incentive?
5. **Walking routing:** fix the car-profile walk gap (pedestrian profile) in 2.0, or leave it post-2.0?
