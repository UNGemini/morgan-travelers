# UNLOOP ID — Identity, AuthN & OAuth Portal Plan

**Status:** Draft for review · **Owner:** UN_Gemini · **Last updated:** 2026-10-14

Companion: [`travelers-2.0.md`](./travelers-2.0.md) · Extends: *UNLOOP STUDIO | Identity Ecosystem & AXiS Framework PRD v2.1*.

---

## 1. Where this fits

PRD v2.1 already defines the **Roblox-side** identity model:

- **AXiS ID (AID)** — anonymous, deterministic, client-generated (`AID-79B4A2EF8C`), zero handshake.
- **UNLOOP ID (UID)** — the master web profile (`UN-00000001`, `@username`) that AIDs lazily merge into via OAuth 2.0.
- Read/write isolation, Network Lite CDN, appeal pipeline, MemoryStore cooldown.

**This document adds the consumer-facing identity provider**: how a human actually signs in to UNLOOP services (Travelers first, Roblox cross-game syncing next), how credentials and sessions work, how entitlements/roles are issued, and how third parties (Tactico now, Roblox later) connect through an OAuth portal.

It does **not** replace the AID/UID tiering: AIDs remain anonymous runtime handles; UID remains the master profile; merging stays lazy and user-initiated.

---

## 2. Goals / non-goals

**Goals**

1. **Password-less by construction** — no password column exists; no password reset flow can be phished.
2. **One identity across surfaces** — web, iOS, Android, Roblox.
3. **Federated but not dependent** — Google/Apple/Roblox are *credential providers*, never the source of truth; a UID survives unlinking any of them (as long as one credential remains).
4. **Least-privilege for relying parties** — Travelers gets sync + entitlement; Tactico gets profile + link status; nothing gets the AID graph.
5. **PDPO-clean** — exportable, deletable, minimal, auditable.

**Non-goals (2.0)**

- Social graph / follows / public profiles.
- Password login, SMS OTP, or security questions.
- Payments processing — entitlements are *recorded* here, money moves in the stores.

---

## 3. Identity model

```
users                UN-00000001   handle, status, created_at
  ├─ identities      google | apple | roblox | tactico   (provider_uid, verified email)
  ├─ passkeys        WebAuthn credentials (discoverable, multi-device)
  ├─ sessions        web cookie sessions / app device tokens
  ├─ roles           user, verified_contributor:{path,fares,stops}, moderator, admin
  ├─ entitlements    travelers_pro (source: appstore|play|stripe, expires_at)
  └─ axis_links      AID → UID pointers (PRD §2.2, unchanged shape)
```

**Rules**

- A UID always has ≥ 1 credential. Removing the last credential requires deleting the account.
- Provider linking is **explicit** (`/account/link/:provider`), never implicit by matching email.
- Email equality alone never merges two UIDs; merging requires proof of control of both.
- `handle` is unique, case-insensitive, reserved-word-filtered, changeable twice per 12 months.
- AIDs stay opaque (see §12) and are **never** returned by user-facing APIs.

---

## 4. Authentication methods

| Method | Role | Notes |
| --- | --- | --- |
| **Passkey (WebAuthn)** | Primary, default | Discoverable credentials; `userVerification: required`; attestation `none`; conditional-UI autofill (`autocomplete="webauthn"`); synced passkeys (iCloud Keychain / Google Password Manager) give cross-device for free |
| **Email one-time code** | Primary fallback | 6 digits, 10-minute TTL, single use, hashed at rest, ≤ 5 attempts; generic responses (no “account not found”); per-email + per-IP + per-device limits |
| **Google OAuth** | Convenience | OIDC authorization code + PKCE; `email` + `email_verified` required; no offline access beyond sign-in |
| **Apple OAuth** | Convenience (required by App Store when other socials exist) | `Sign in with Apple`; handle private-relay emails as valid but non-recoverable |
| **Roblox OAuth** | Linking only (paper phase) | Links a Roblox account to an existing UID (AXiS cross-game); never creates a UID alone |
| **Tactico OAuth** | Third-party connect | Partner RP; see §10 |

**Deliberate omissions:** SMS (SIM-swap), passwords, magic links sent to the same inbox as OTP (redundant).

### 4.1 Passkey details

- Registration requires a signed-in session (step-up: fresh auth < 10 min) — passkeys are added to an existing UID, not the initial factor except during sign-up.
- Sign-up path A: email OTP → create UID → immediately prompt “Add a passkey”.
- Sign-up path B: passkey-first (platform creates a discoverable credential with `user.name = handle`, `userHandle = uid`) → then verify email to unlock sync.
- Credential metadata stored: credential id, public key, sign counter, transports, AAGUID, nickname, last used. No biometric data ever leaves the device.
- Account recovery: passkey **or** verified email OTP; if both lost, manual support with a 7-day hold + notification to the old email.

### 4.2 Email OTP details

- Codes generated from a CSPRNG, hashed (SHA-256 + per-challenge salt) before storage.
- Delivery via transactional email with a short, brand-neutral template; rate: 1 per 60 s, 5 per hour per email, 20 per IP per hour.
- On success: create session, mark challenge consumed, invalidate sibling challenges.
- Never reveal whether the address exists — form a new UID silently only after code verification.

---

## 5. Protocol & sessions

**Relying-party surface (Travelers, Wristwatch dashboards, etc.)**

- First-party web: **Authorization Code + PKCE (S256)** → exchange at `/oauth/token` → session cookie `__Host-uid` (HttpOnly, Secure, SameSite=Lax, 30 days, rotating) + short-lived access JWT.
- Native apps: same flow with an RFC 8252 loopback / universal-link redirect → **refresh token** stored in Keychain / Keystore (device-bound), access JWT in memory only.
- Access JWT: ES256, 10-minute TTL, claims `{sub, handle, scopes[], ent:{pro:bool}, iat, exp, jti}`; **no email, no AID list**.
- Refresh tokens: opaque, rotating on every use, **reuse detection** (family revoke), 30-day idle / 180-day absolute.
- Revocation: `/oauth/revoke` + global “sign out everywhere”; sessions listed per device with last-seen IP city (never full IP in UI).

**Third-party OAuth provider (Tactico, Roblox dashboards)**

- Full OAuth 2.0 authorization server: `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, `/oauth/revoke`, OIDC discovery + JWKS.
- Only **confidential clients** (server-to-server) may request `offline_access`; PKCE mandatory for public clients.
- Consent screen enumerates scopes in the user's language; each grant is revocable at `/account/connections`.

---

## 6. Authorization

**Scopes**

| Scope | Grants |
| --- | --- |
| `openid profile` | UID + handle + avatar seed |
| `travelers.sync` | read/write `pinned`, `settings`, `planPrefs` |
| `travelers.pro` | entitlement lookup (no billing data) |
| `roblox.link` | AID↔UID resolution for the caller's own network |
| `tactico.profile` | handle + link status for the partner dashboard |

**Roles** are server-side only and never trusted from a token claim beyond a signed `roles_version`. Changes bump the version, forcing a token refresh (immediate effect within 10 min, or instantly on `/oauth/introspect` for third parties).

**Entitlements** (`travelers_pro`) carry `{source, product_id, expires_at, auto_renew, environment}` mirrored from StoreKit 2 / Play / Stripe webhooks. Clients treat the signed entitlement claim as advisory; the server always re-checks before starting a watcher (§ travelers 6.2).

---

## 7. Data model (Cloudflare D1 + KV + R2)

```sql
users(id TEXT PK, handle TEXT UNIQUE, status TEXT, created_at, deleted_at)
identities(id PK, user_id FK, provider TEXT, provider_uid TEXT, email TEXT,
           email_verified INTEGER, linked_at, UNIQUE(provider, provider_uid))
webauthn_credentials(id PK, user_id FK, public_key BLOB, sign_count INTEGER,
                     transports TEXT, aaguid TEXT, name TEXT, created_at, last_used_at)
otp_challenges(id PK, email_hash TEXT, code_hash TEXT, expires_at, attempts, consumed_at)
sessions(id PK, user_id FK, kind TEXT/*cookie|refresh*/, device_name TEXT,
         token_hash TEXT, family_id TEXT, created_at, last_seen_at, revoked_at)
roles(user_id FK, role TEXT, scope TEXT, granted_by, granted_at, revoked_at)
entitlements(user_id FK, product TEXT, source TEXT, expires_at, auto_renew,
             environment TEXT, updated_at, PRIMARY KEY(user_id, product))
axis_links(aid TEXT PK, user_id FK NULL, network_id TEXT, merged_at)

oauth_clients(client_id PK, name, redirect_uris JSON, scopes JSON,
              confidential INTEGER, logo_url, created_at, status)
oauth_grants(id PK, client_id FK, user_id FK, scopes JSON, created_at, revoked_at)
audit_log(id PK, at, actor_user_id, action, subject, meta JSON, ip_country)
```

KV: rate-limit counters, JWKS cache, session lookups (short TTL). R2: nightly encrypted exports, audit archives.

---

## 8. API surface (first-party)

```
POST /auth/otp/request        {email}
POST /auth/otp/verify         {email, code}          → session
POST /auth/passkey/register   (session, step-up)     → credential
POST /auth/passkey/login      (assertion)            → session
GET  /auth/:provider/start    → 302 (PKCE, state, nonce)
GET  /auth/:provider/callback → session
POST /auth/logout             POST /auth/logout-all
GET  /account                 → profile, connections, sessions
POST /account/link/:provider  DELETE /account/connections/:id
GET  /account/export          DELETE /account          (30-day soft delete)
GET  /v1/sync/:scope?since=   PUT /v1/sync/:scope
GET  /v1/entitlements         → {travelers_pro:{active,expires_at}}
```

All mutating endpoints: CSRF double-submit for cookie clients, idempotency keys, per-account + per-IP limits, structured errors with a correlation id (same convention as the existing `/eta` proxy).

---

## 9. Sign-in UX

- One sheet, three doors: **“Continue with passkey”** (primary, detected via conditional UI), “Continue with Google / Apple”, “Email me a code”.
- After first sign-in: “Add a passkey?” → “Turn on sync for pinned routes?” (never bundled with consent for contribution).
- **Account switcher** for multi-account users; guest state is always visible as “Not signed in — data stays on this device”.
- Recovery copy avoids revealing whether an account exists.
- All strings land in the six dictionaries (en, zh-hk, zh-tw, zh-cn, ja, ko).

---

## 10. OAuth portal (Tactico now, Roblox later)

**Client registry** — partner requests a client at `developers.unloop.studio`; we issue `client_id` + `client_secret` (confidential only), allowlist redirect URIs (exact match, https-only, no wildcards beyond subdomain), scopes, and a logo for the consent screen.

**Tactico dashboard integration**

1. Tactico adds a “Connect UNLOOP ID” module → redirect to `https://id.unloop.studio/oauth/authorize?...&scope=openid profile tactico.profile`.
2. User consents; we return `code` → Tactico exchanges it server-side for tokens.
3. Tactico stores the UID + refresh token (if granted) and displays link status.
4. Unlink from Tactico's dashboard calls our `/oauth/revoke` + fires `user.unlinked`; unlink from our side shows up in Tactico via a signed webhook.

**Webhooks** (HMAC-signed, 5-minute tolerance, retried with backoff): `user.linked`, `user.unlinked`, `entitlement.changed`, `account.deleted`.

**Roblox** — the AXiS runtime keeps using the PRD's flow (NetworkID handshake, MemoryStore cooldown). New: the same OAuth server exposes `roblox.link` so a player can attach a Roblox identity to their UID from the Travelers/Roblox side; resolution stays **server-side only** (never an AID→UID index in a public repo, per PRD §5).

---

## 11. Security

| Area | Control |
| --- | --- |
| Credential theft | Passkeys (phishing-resistant) + short access tokens + rotating refresh with reuse detection |
| Session fixation | Rotate session id on auth; `__Host-` cookies; SameSite=Lax + CSRF token on mutations |
| Account enumeration | Generic OTP responses, uniform timing, uniform error bodies |
| Brute force | Per-email/IP/device limits, exponential lockouts, CAPTCHA threshold (Turnstile) |
| OAuth abuse | Exact redirect matching, PKCE, `state`+`nonce`, consent bound to a session, short code TTL (60 s) |
| Token leakage | No tokens in URLs (except the one-time code), no refresh tokens in localStorage on web |
| Privilege escalation | Roles/entitlements server-side only; signed `roles_version`; step-up (fresh auth) for linking, export, deletion |
| Insider/abuse | Append-only `audit_log`; admin actions require a second approver for role grants |
| Availability | Rate limits at the edge; D1 + KV caching for hot reads; no synchronous third-party calls on the auth path beyond the provider exchange |

---

## 12. AID hardening (a change to PRD v2.1)

PRD v2.1 generates AIDs client-side with **FNV-1a 64-bit** and treats them as identity. FNV-1a is trivially forgeable — anyone can claim another player's AID.

**Recommendation:** keep the AID format and client generation, but treat it as an **untrusted handle** and require a server-verifiable binding:

```
AID = base32(HMAC-SHA256(network_salt, roblox_user_id)[0..10])
signature = HMAC-SHA256(network_secret, AID|universe_id|issued_at)
```

The AXiS runtime sends `AID + signature + issued_at`; the UNLOOP API verifies before any merge/moderator escalation. Network salts remain per-buyer (PRD §3), so cross-network correlation stays impossible. This is a **security fix**, not a scope change, and it does not affect the lazy-merge UX.

---

## 13. Privacy (HK PDPO)

- **Minimisation:** email (if OTP/Google), provider subject ids, handle. No phone, no address, no IP history beyond country for the security log.
- **Purpose:** authentication, sync, entitlements. Contribution data is a separate consent (Travelers §7) and is never joined to the UID in published aggregates.
- **Retention:** sessions 180 days; audit 24 months; OTP challenges purged 24 h after expiry; deleted accounts purged after 30 days (exports retained 7 days).
- **Rights:** self-serve export (JSON) and delete in-app and on web; deletion cascade documented and tested.
- **Transparency:** one-page data map published on `id.unloop.studio/privacy`.

---

## 14. Roadmap

| Phase | Content | ~Weeks |
| --- | --- | --- |
| **A0 — Skeleton** | D1 schema, OTP + passkey sign-up/sign-in, sessions, `/account`, audit, rate limits, Turnstile | 4–5 |
| **A1 — First-party RP** | OIDC authorize/token/userinfo + JWKS, PKCE, session cookie + device refresh, Travelers sign-in sheet, sync scope `pinned` | 4–6 |
| **A2 — Roles & entitlements** | verified_contributor roles per capability, `travelers_pro` mirror from Stripe (then StoreKit/Play), admin console for manual approval | 3–4 |
| **A3 — Partner OAuth** | Client registry, consent screen, Tactico integration + dashboard module, signed webhooks, `/account/connections` | 4–6 |
| **A4 — Roblox linking** | Roblox OAuth, `roblox.link` scope, AID signature verification (§12), cross-game sync endpoints | 3–5 |

Phase A0–A1 lands alongside Travelers P0 so the first release already has real accounts; A2 gates the verified-contributor workstream.

---

## 15. Open questions

1. **Handle policy:** are UIDs `@handle` (public) or opaque `UN-XXXXXXXX` with an optional display name? (Affects Tactico's dashboard display and abuse surface.)
2. **Email deliverability:** which provider (Resend / Postmark / SES)? Bounce handling changes the OTP UX.
3. **Account recovery slack:** who approves manual recoveries, and what identity evidence is acceptable?
4. **Roblox linkage timing:** does Roblox OAuth land in 2.0 or with the AXiS commercial release?
5. **Tactico secrets rotation:** do we own the client registry UI, or does Tactico manage their own client via an admin API?
6. **Pro gifting:** can a verified contributor receive Pro via an entitlement with `source = grant`? (Travelers open question §14.4.)
