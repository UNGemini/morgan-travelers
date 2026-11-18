# UNLOOP ID — Handover Brief (self-contained)

**For:** the team/agent taking over the identity system · **From:** Travelers 2.0 · **Date:** 2026-11-12

This file is written to be handed over **without access to the Travelers repo**. It contains the mission, the frozen interface contract Travelers codes against, the build order, the security acceptance tests, and the decisions still open. The long-form spec lives in [`unloop-id.md`](./unloop-id.md); the machine-readable contract is [`unloop-id.openapi.yaml`](./unloop-id.openapi.yaml).

---

## 1. Mission

Build a **password-less identity provider** for UNLOOP services. Travelers 2.0 is the first relying party; the Roblox AXiS cross-game system is the second. Passwords must not exist anywhere in the system — not in the schema, not in a recovery flow.

## 2. Non-negotiables

1. **No passwords, no SMS OTP, no security questions.** Sign-in = passkey, email one-time code, Google OAuth, Apple OAuth.
2. **Guest-first.** Nothing in Travelers may require an account. Accounts add cross-device sync and Pro; they are never a gate.
3. **Least-privilege tokens.** An access token carries `sub`, `handle`, scopes and a Pro flag. **No email, no provider ids, no AID list.**
4. **AIDs are untrusted handles.** AXiS IDs are client-generated (FNV-1a per PRD v2.1) and therefore forgeable. Any AID→UID merge or moderator escalation must verify a server-side HMAC signature; see §10.
5. **No public AID→UID index.** Resolution is server-side only (PRD §5).
6. **Privacy by default.** Minimal fields, documented retention, self-serve export and delete.

## 3. The frozen contract (what Travelers depends on)

Travelers will ship against **exactly these shapes**. Changing them breaks the launch; adding fields is fine.

| # | Endpoint | Behaviour |
| --- | --- | --- |
| 1 | `POST /auth/otp/request` `{email}` | 204 always — never reveal whether the address exists |
| 2 | `POST /auth/otp/verify` `{email, code}` | 200 `{session}` or 400/429; generic errors |
| 3 | `POST /auth/passkey/register` | requires a fresh session (step-up < 10 min) |
| 4 | `POST /auth/passkey/login` | 200 `{session}`; discoverable credentials |
| 5 | `GET /auth/{provider}/start` → 302 | PKCE + `state` + `nonce`; providers `google`, `apple` |
| 6 | `GET /auth/{provider}/callback` | 302 to app with session |
| 7 | `GET /v1/me` | `{uid, handle, roles[], entitlements{travelers_pro}}` · **401 when signed out** |
| 8 | `GET /v1/entitlements` | `{travelers_pro: {active, expires_at, source}}` |
| 9 | `GET /v1/sync/{scope}?since=` | `{items[], cursor, tombstones[]}`; scopes `pinned`, `settings`, `planPrefs` |
| 10 | `PUT /v1/sync/{scope}` | batch, idempotent, `ETag`; per-item `updatedAt` + tombstones |
| 11 | `POST /auth/logout`, `/auth/logout-all` | revoke session(s) |
| 12 | `DELETE /account` | 30-day soft delete; `GET /account/export` = JSON |

**Error convention (must match the app's `/eta` proxies):**
```json
{ "ok": false, "error": "machine_readable_code", "correlationId": "eta-…" }
```
plus an `x-correlation-id` response header.

**Auth transport.** Web: `__Host-` session cookie (HttpOnly, Secure, SameSite=Lax) + short-lived access JWT. Native: refresh token in Keychain/Keystore, access JWT in memory only.

## 4. Identity model (short form)

```
users            UN-00000001 · handle · status
 ├─ identities   google | apple | roblox | tactico   (provider_uid, email, email_verified)
 ├─ passkeys     WebAuthn credentials (discoverable, attestation "none")
 ├─ sessions     cookie sessions / device refresh tokens (rotating, reuse-detected)
 ├─ roles        user, verified_contributor:{path|fares|stops}, moderator, admin
 ├─ entitlements travelers_pro (source: appstore | play | stripe | grant)
 └─ axis_links   AID → UID pointers (PRD v2.1 shape, unchanged)
```

Rules: a UID always has ≥ 1 credential; linking a provider is always explicit; email equality never merges two UIDs; handle changes max twice per 12 months.

## 5. Build order

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| **A0** | D1 schema, email OTP, passkey sign-up/sign-in, sessions, `/v1/me`, audit log, rate limits | Passkey-only sign-up works on Safari + Chrome; OTP returns 204 for unknown addresses |
| **A1** | OIDC authorize/token/userinfo + JWKS, PKCE, session cookie + native refresh, sync `pinned` | A third-party RP can complete PKCE login; `PUT` then `GET ?since=` round-trips |
| **A2** | Roles (`verified_contributor:*`), entitlements mirror from Stripe, admin approval console | A granted role appears in `/v1/me` within one token refresh |
| **A3** | OAuth client registry, consent screen, Tactico dashboard integration, signed webhooks | Tactico links/unlinks and receives `user.linked` / `user.unlinked` |
| **A4** | Roblox linking + AID signature verification | Forged AID is rejected; valid AID merges lazily |

## 6. Security acceptance tests (must all pass before A1 ships)

1. Unknown email → identical response and timing to known email.
2. OTP: 5 wrong attempts invalidates the challenge; 6th request within 60 s → 429.
3. Refresh-token reuse → **whole family revoked**, both tokens dead.
4. Session fixation: pre-auth session id never survives sign-in.
5. Redirect URI: any non-exact match is rejected (no wildcards, no subpath).
6. Access token contains no email and no provider subject id.
7. Step-up required for: adding a passkey, export, delete, provider link.
8. CSRF: cookie-authenticated mutations without the double-submit token → 403.
9. Enumeration: `/auth/{provider}/callback` errors never reveal account existence.
10. Audit: every role/entitlement change writes an append-only row with actor + reason.

## 7. Privacy (HK PDPO)

Stored: email (if any), provider subject ids, handle, passkey public keys, session hashes, country from security logs. Retention: sessions 180 d, audit 24 mo, OTP challenges purged 24 h after expiry, deleted accounts purged after 30 d. Contributions (Travelers) are a **separate consent** and must never be joined to a UID in published aggregates.

## 8. OAuth portal (third parties)

Client registry with exact redirect allowlists + PKCE; consent screen localised; revocable grants at `/account/connections`. Webhooks HMAC-signed (5-min tolerance, retried with backoff): `user.linked`, `user.unlinked`, `entitlement.changed`, `account.deleted`. Scopes: `openid profile`, `travelers.sync`, `travelers.pro`, `roblox.link`, `tactico.profile`.

## 9. Pro must not depend on this work (de-risking rule)

Travelers' Pro subscription is keyed to the **store receipt** (StoreKit 2 / Play / Stripe), with its own signed entitlement token. When UNLOOP ID lands, migrate those records onto UIDs. Do **not** make UID creation a precondition for Pro — the clients ship on one day across web/iOS/Android.

## 10. AID hardening (a change to PRD v2.1)

Keep the AID format; stop treating it as identity:

```
AID       = base32(HMAC-SHA256(network_salt, roblox_user_id)[0..10])
signature = HMAC-SHA256(network_secret, AID|universe_id|issued_at)
```
AXiS sends `AID + signature + issued_at`; the API verifies before merge/escalation. Per-buyer salts keep cross-network correlation impossible (PRD §3).

## 11. Open decisions (need an owner answer)

1. `@handle` public, or opaque `UN-XXXXXXXX` + display name?
2. Transactional email provider (Resend / Postmark / SES) and bounce handling?
3. Who approves manual account recovery, and on what evidence?
4. Roblox OAuth in this scope, or with the AXiS commercial release?
5. Does Tactico manage its own OAuth client, or do we expose an admin API?

## 12. Paste-ready kickoff prompt

> You are taking over **UNLOOP ID**, a password-less identity provider (D1 + Workers). Read `unloop-id-handoff.md` §2–§6 and `unloop-id.openapi.yaml`. Build phase **A0** first: D1 schema, email OTP, WebAuthn passkey sign-up/sign-in, rotating sessions, `GET /v1/me`, audit log, rate limits, generic anti-enumeration responses. Treat the endpoints and error shape in §3 as frozen — Travelers codes against them. No passwords anywhere. Prove §6's ten security tests before moving to A1. Report decisions you need back on from §11.
