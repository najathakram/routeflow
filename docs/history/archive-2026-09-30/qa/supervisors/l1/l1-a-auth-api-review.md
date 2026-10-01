# L1-A Supervisor Review — Auth & API Contract

**Workers reviewed:** W1 (Auth & Security), W2 (API Contract)
**Date:** 2026-04-29
**Reviewer:** L1-A

---

## W1 Assessment

- **Completeness:** Medium
- **Accuracy:** Mostly verified; two findings require correction (see below)
- **Controllers spot-checked:** W1 did not enumerate which controllers it actually reviewed. Spot-check of `@Controller` decorators found 35+ controllers across the codebase. W1's narrative covers auth, users, credit-notes, and tenant guards — but does not mention estimates, vendor-bills, import, recurring-invoices, messages, notifications, or uploads controllers. Coverage of the finance-adjacent modules is unverified.

### W1 Finding Corrections

**W1-001 — Credit Notes GET Endpoints Partially Disputed**
W1 flagged `GET /credit-notes` and `GET /credit-notes/:id` as missing `@UseGuards(RolesGuard) + @Roles()`. This is **partially correct but overstates the risk**.

Source verification (`apps/api/src/credit-notes/credit-notes.controller.ts`):

- The controller class carries `@UseGuards(JwtAuthGuard)` — every endpoint requires a valid JWT. Authentication is enforced.
- `GET /credit-notes` calls `creditNotesService.findAllForUser(user, ...)`. The service branches on `user.role === "CUSTOMER"` and scopes the query to that customer's records only. Operators see all records. This is **intentional role-based scoping inside the service**, not a missing guard.
- `GET /credit-notes/:id` calls `creditNotesService.findOneForUser(id, user)` which presumably applies the same pattern.
- **Real issue:** Any authenticated user whose role is DRIVER or OPERATOR (non-admin) can call `GET /credit-notes` and receive the full unfiltered list, because `findAllForUser` only filters for `role === "CUSTOMER"`. No RolesGuard is restricting non-customer, non-operator callers. A DRIVER JWT can enumerate all credit notes tenant-wide. This is a **real but narrower** finding than W1 described.
- **Revised severity:** P2 (information disclosure to DRIVER role), not P1.

**W1-005 — canActAsDriver Restriction Corrected**
W1 stated "OPERATOR can grant driver permissions without explicit validation." This is **inaccurate**.

Source verification (`apps/api/src/users/users.controller.ts` line 100-105, `users.service.ts` line 217-256):

- `PATCH /users/:id/driver-permit` is guarded by `@UseGuards(RolesGuard) @Roles(UserRole.OPERATOR)`.
- `TENANT_ADMIN` satisfies `OPERATOR` per the role hierarchy in `roles.guard.ts` lines 20-21.
- `toggleDriverPermit()` in the service checks that the **target user** is `OPERATOR` or `TENANT_ADMIN` before granting the permit.
- No plain DRIVER or CUSTOMER can call this endpoint or receive the `canActAsDriver` flag.
- **Verdict:** This finding is a false positive. The control is correctly implemented. **Dismiss W1-005.**

**W1-003 — TenantStatusGuard Fails Open: Confirmed with nuance**
Source verification (`apps/api/src/tenant/tenant-status.guard.ts` lines 95-100):

- The guard does fail open on DB exceptions (returns `true`).
- However, there is an in-memory cache (60 s TTL). If the last known status was cached as SUSPENDED before the DB error occurred, the cache entry is stale and the guard will still query the DB — and then fail open. The cache does NOT help on the error path because the guard reads cache first and only hits the DB on a cache miss; a DB error on a cache miss means the request goes through.
- W1's finding is confirmed. The recommended fix (fail closed; use cache if available) is correct and feasible: if a cache entry exists at the time of the DB error, use it; if no cache entry exists, the safest choice is to block with a 503 and log.
- **Severity remains P2.**

**W1-006 — Access Tokens Valid After Password Reset: Corrected**
W1 said "Password change doesn't invalidate access tokens (~15 min window)."

Source verification (`apps/api/src/auth/auth.service.ts` lines 322-344):

- `changePassword()` does call `await this.prisma.refreshToken.deleteMany({ where: { userId } })` — all refresh tokens are revoked.
- Access tokens are short-lived JWTs; they cannot be individually revoked without a blocklist. The ~15-min window gap is real but is standard JWT behavior.
- W1's finding is **partially accurate**: refresh tokens ARE revoked (the most important protection), but outstanding access tokens remain valid for their remaining TTL. This is the standard trade-off and the code explicitly comments on it.
- **Revised severity:** P3 (accepted risk), not a missed fix. The recommendation to shorten access token TTL to 5-10 min is valid but is an enhancement, not a bug fix.

### W1 Missed Issues

1. **No self-service password reset flow exists.** There is no `POST /auth/forgot-password` or `POST /auth/reset-password` endpoint in `auth.controller.ts`. For accounts that lose their password and have no Google link, the only recovery path is an operator-initiated `POST /users/:id/reset-password`. Buyers/customers with no operator contact have no recovery path. This is a UX gap that also has security implications (no way for users to self-remediate a compromised password without operator involvement).

2. **`PATCH /users/me/preferences` has no input validation DTO.** (`users.controller.ts` line 57) The body type is `Record<string, string>` with no class-validator pipe, no key whitelist, and no size limit. A malicious or buggy client can write arbitrary key/value pairs of unbounded length to `UserPreference`. This could be used for denial-of-service (storage exhaustion) or to smuggle application-level state into the preferences store.

3. **Redis throttler fails open silently on errors** (`apps/api/src/common/redis-throttler.storage.ts` line 98). If Redis is unavailable, `increment()` returns `totalHits: 1` which is always below any limit, making rate limiting completely ineffective. The login endpoint's 30-req/min limit disappears silently during a Redis outage. The log line is the only signal. This compounds W1-003 if a Redis outage triggers both: suspended tenant can log in AND rate limiting is disabled simultaneously.

---

## W2 Assessment

- **Completeness:** High for happy-path endpoint matching; Low for error-path and buyer-side verification
- **Accuracy:** The 3 flagged items are all correctly classified as low-risk/by-design
- **Missed issues:** See below

### W2 Finding Verification

**W2-001 (Payment Method Enum):** Confirmed low-risk. Server-side Prisma validation rejects invalid enum values.

**W2-002 (Order Creation DTO Subset):** Confirmed by-design. Mobile intentionally omits operator-only fields (`customerId`, `routeRunId`). No contract violation.

**W2-003 (Complete Stop Endpoint):** Confirmed correct. `POST /route-runs/{runId}/stops/{stopId}/complete` aligns between mobile (`apps/mobile/lib/api/routes.ts:204`) and API (`apps/api/src/routes/routes.controller.ts:158-161`).

### W2 Verified: Buyer-Side Endpoints

W2 listed `GET /buyer/products`, `GET /buyer/orders`, `POST /buyer/orders`, `GET /buyer/invoices` as OK. Source verification of `apps/api/src/buyer/buyer.controller.ts` confirms these endpoints exist under `@Controller("buyer")` with `@UseGuards(BuyerJwtAuthGuard)`. W2's claim is correct.

`GET /customers/me` exists at `apps/api/src/customers/customers.controller.ts` line 104 with `@Roles(UserRole.CUSTOMER)`. Verified present and correctly guarded.

### W2 Verified: Mobile 401/403/500 Error Handling

Source verification of `apps/mobile/lib/api-client.ts`:

- **401 handling:** The response interceptor correctly intercepts 401s, attempts a token refresh via `POST /auth/refresh`, replays the original request, and on refresh failure deletes tokens and defers navigation to the auth store. This is a correct implementation.
- **403 handling:** Not explicitly handled — 403 errors are rejected as-is (`Promise.reject(error)`). Individual screens/hooks are responsible for handling them. This is acceptable but means no unified "access denied" UX.
- **500 handling:** Not explicitly handled — 500 errors propagate to callers. No global error boundary in the API client.
- **Network errors on GET:** The offline queue only captures mutating requests (POST/PATCH/PUT/DELETE). GET failures on network loss are not queued; screens must handle them via loading/error states in their own hooks.

### W2 Missed Issues

1. **Mobile does not handle HTTP 429 (Too Many Requests) from the throttler.** The API returns 429 when rate limits are exceeded. The `api-client.ts` interceptor has no 429 branch — the error propagates raw to UI components that are unlikely to show a user-friendly "slow down" message.

2. **The `GET /auth/google` endpoint is not rate-limited.** It generates a nonce and persists it to Redis. There is no `@Throttle` decorator on this endpoint (verified in `auth.controller.ts`). An attacker can flood this endpoint to fill Redis with OAuth nonces, contributing to Redis memory pressure. The nonce TTL (10 min) limits the blast radius but a sustained flood is still possible.

3. **W2 did not verify the driver app's API client** — only the mobile (operator/customer) app was referenced. The driver app likely has its own API client and auth interceptor; a separate audit is warranted.

---

## Cross-reference Findings

### Credit Notes — W1 + W2 Intersection

W1 flagged `GET /credit-notes` as missing role guards (W1-001). W2 listed `GET /credit-notes` as verified OK. These are contradictory assessments of the same endpoint.

**Resolution:** Both workers were looking at different things. W2 verified the HTTP path and method match between mobile and API — which is correct. W1 identified a missing role restriction — which is partially correct (DRIVER role can call this endpoint). The actual risk is: a driver user with a valid JWT can enumerate all credit notes in the tenant. The mobile app only calls this endpoint from the operator context, so there is no current mobile attack path — but it is a backend exposure if any DRIVER-role token is obtained.

### Auth Tokens — W1 + W2 Intersection

W1 identified the access token validity window after password change (W1-006). W2's 401-refresh flow (verified above) correctly deletes refresh tokens on a failed refresh and clears stored tokens. These findings are complementary: W1 describes the server-side gap, W2's client behavior means a stolen access token is still valid for its TTL even after the legitimate user changes their password.

---

## L1-A Added Findings

### L1A-001 — GET /auth/google Nonce Endpoint Has No Rate Limit

- **Severity:** P3
- **File:** `apps/api/src/auth/auth.controller.ts` lines 138-165
- **Issue:** `GET /auth/google` generates a one-time nonce and writes it to Redis with a 10-minute TTL. No `@Throttle` decorator is present. An unauthenticated attacker can call this endpoint at the global 100 req/60 s limit, which means up to 100 nonces/min per IP can be created. Over a sustained period this fills Redis with `oauth:nonce:*` keys (each alive for 10 min = up to 1000 live nonce keys per attacking IP) and increases Redis memory pressure.
- **Repro:** Send `GET /api/v1/auth/google?tenant=any` in a loop without delay until Redis nonce keys accumulate.
- **Recommended fix:** Add `@Throttle({ default: { ttl: 60_000, limit: 10 } })` to `googleAuthUrl()`, matching the `verify-email` endpoint limit.
- **Expected after fix:** Nonce creation is capped at 10/min per IP, limiting Redis pollution to ~100 live keys per IP.

### L1A-002 — Redis Throttler Fails Open Silently During Outage

- **Severity:** P2
- **File:** `apps/api/src/common/redis-throttler.storage.ts` line 98
- **Issue:** When Redis is unreachable, `increment()` catches the error, logs a warning, and returns `{ totalHits: 1, isBlocked: false }`. This makes every request appear to be the first in the window, so no rate limit is ever enforced. The login endpoint's brute-force protection (30 req/min) and all other throttle limits silently disappear during a Redis outage. Since `TenantStatusGuard` also fails open on DB errors (W1-003), a dual-outage scenario (Redis + DB) leaves the API with neither tenant status enforcement nor rate limiting.
- **Repro:** Disconnect Redis; attempt login in a tight loop beyond 30 requests per minute — all succeed without 429 responses.
- **Recommended fix:** On Redis error, track hits in a per-process in-memory fallback map (LRU, small max-size) so rate limiting degrades gracefully rather than failing completely. Alternatively, emit a metric/alert so on-call is paged during Redis outages.
- **Expected after fix:** Rate limiting remains functional (possibly less accurate under distributed load) even when Redis is temporarily unavailable.

### L1A-003 — PATCH /users/me/preferences Accepts Unbounded Arbitrary Keys

- **Severity:** P3
- **File:** `apps/api/src/users/users.controller.ts` line 57; `apps/api/src/users/users.service.ts` lines 271-275
- **Issue:** The body is typed as `Record<string, string>` with no class-validator pipe, no key whitelist, and no per-request size cap. Any authenticated user can write an unlimited number of arbitrarily named keys of arbitrary length. Each key becomes a `UserPreference` row. There is no cap on total preferences per user or on string length.
- **Repro:** Authenticate as any user; `PATCH /api/v1/users/me/preferences` with a body containing 10,000 keys each with a 1 KB value string.
- **Recommended fix:** Introduce a `UpdatePreferencesDto` with `@IsObject()`, `@MaxProperties(50)`, and value length validation. Add a service-layer guard rejecting requests with more than 50 keys or any value over 500 chars.
- **Expected after fix:** Preferences endpoint cannot be used for storage exhaustion or unbounded writes.

### L1A-004 — No Self-Service Password Reset Flow

- **Severity:** P2
- **File:** `apps/api/src/auth/auth.controller.ts` (absent)
- **Issue:** There is no `POST /auth/forgot-password` or equivalent endpoint. Users who forget their password and have no linked Google account cannot recover their account without operator intervention. For tenants where the only OPERATOR is also locked out, or for CUSTOMER-role users who have no direct operator contact, there is no recovery path. This is also a security gap: an operator resetting a password (`POST /users/:id/reset-password`) does not notify the account owner by email, meaning an operator can silently reset any user's password.
- **Repro:** Create a user with only password auth, forget the password, attempt recovery — there is no user-facing flow.
- **Recommended fix:** Implement `POST /auth/forgot-password` (accepts email, sends time-limited reset token) and `POST /auth/reset-password` (accepts token + new password). The reset token should be a short-lived JWT (15 min) stored or validated server-side.
- **Expected after fix:** Users can self-service recover accounts; operators resetting passwords do not create silent account takeover risk.

### L1A-005 — Legacy Google OAuth Path Tokens Passed in URL Query String

- **Severity:** P2
- **File:** `apps/api/src/auth/auth.controller.ts` lines 288-305 (legacy `GET /auth/google/:tenantSlug/callback`)
- **Issue:** The legacy tenant Google callback at line 300-303 redirects to `${webUrl}/auth/callback?accessToken=...&refreshToken=...`. Both tokens are in URL query params. Modern browsers log query params in history, and many reverse proxies / CDNs log full URLs. This leaks both tokens in browser history, server access logs, and any analytics or APM tools that capture query strings. The primary (non-legacy) callback at lines 236-255 uses the same pattern. This affects all OAuth sign-in flows.
- **Repro:** Complete Google OAuth sign-in; inspect browser history / server access logs — the raw `accessToken` and `refreshToken` are visible.
- **Recommended fix:** Redirect to a frontend URL that contains only a one-time `code` param (exchange code → tokens in a server-side or short-lived in-memory store), or use the `fragment` (#) instead of query string (fragments are not sent to servers or logged). At minimum, tokens in query params should be consumed and removed from URL immediately on the frontend.
- **Expected after fix:** Tokens are not present in server logs or browser history.

### L1A-006 — Mobile API Client Does Not Handle HTTP 429

- **Severity:** P3
- **File:** `apps/mobile/lib/api-client.ts` lines 63-143
- **Issue:** The response interceptor handles 401 (token refresh) and network errors (offline queue) but has no branch for 429 (Too Many Requests). When the API throttles a mobile client, the raw axios error propagates to UI components that will likely show a generic error toast rather than "please slow down." This could also cause an infinite retry loop if any UI layer auto-retries on error without checking status code.
- **Repro:** Trigger rate limiting on any endpoint; observe that the mobile UI receives an unhandled error rather than a user-friendly message.
- **Recommended fix:** Add a 429 branch in the response interceptor that extracts the `Retry-After` header and either waits + retries automatically, or surfaces a user-friendly "too many requests" message.
- **Expected after fix:** Users see a meaningful message and the app does not hammer the API when throttled.

---

## Final Priority List (Auth & API Domain)

1. **[P2] W1-003 / L1A-002 — Dual fail-open on Redis + DB outage** — TenantStatusGuard fails open AND rate limiter fails open simultaneously during infrastructure stress. These two issues compound each other and represent the worst-case scenario where both suspended-tenant blocking and brute-force protection disappear. Fix the Redis throttler fallback first; address TenantStatusGuard fail-closed second.

2. **[P2] L1A-004 — No self-service password reset** — Users with no Google link and no operator contact are permanently locked out. Operator-initiated reset has no notification, enabling silent account takeover. This is both a UX and security gap.

3. **[P2] L1A-005 — Access and refresh tokens exposed in OAuth redirect URL query string** — Both the primary and legacy OAuth callback paths pass raw tokens in URL query parameters, leaking them into browser history and server access logs. Affects all Google sign-in users.

4. **[P2] W1-001 (revised) — DRIVER role can enumerate all credit notes** — `GET /credit-notes` is accessible to any authenticated DRIVER-role user. The service filters for CUSTOMER role but not DRIVER role. Tenant-wide financial data (credit note numbers, amounts, customer IDs) is exposed to drivers.

5. **[P2] W1-002 — JWT claims not validated in OAuth callback** — Unvalidated claims before redirect URL construction. W1's finding; source code confirms the concern in the legacy path (`auth.controller.ts` lines 288-305).

6. **[P2] W1-003 — TenantStatusGuard fails open on DB error** — Suspended tenants can continue making API calls if the DB is unavailable. Addressed partially above; the cache-on-error fix is the specific remediation.

7. **[P3] L1A-001 — GET /auth/google has no rate limit** — Nonce endpoint can be used to flood Redis. Low exploitability but easy to fix.

8. **[P3] L1A-003 — Preferences endpoint accepts unbounded arbitrary writes** — Storage exhaustion vector for any authenticated user. Easy to fix with a DTO and size cap.

9. **[P3] L1A-006 — Mobile API client does not handle HTTP 429** — UX degradation when throttled; potential retry amplification.

10. **[P3] W1-006 — Access tokens valid for remaining TTL after password change** — Standard JWT trade-off; refresh tokens are correctly revoked. Mitigation is shortening access token TTL.

11. **[P3] W2-001 — Payment method enum drift risk** — Low risk today due to runtime validation; add shared types package to prevent future drift.

---

## Notes for L2 Supervisor

- W1 claimed 8 "verified OK" items; items 4 ("Refresh token rotation prevents reuse") and 8 ("Email verification uses JWT with expiration") are correctly verified against the source.
- W2's "47/50 endpoints correct" claim is plausible but the methodology for counting 50 endpoints was not documented. The actual API has 35+ controllers with many more than 50 routes total. W2's sample should be treated as a representative check, not exhaustive coverage.
- Controllers not reviewed by either worker: `estimates`, `vendor-bills`, `import`, `recurring-invoices`, `messages`, `notifications`, `uploads`, `billing`, `billing-webhook`, `platform-admin`. These should be assigned to a follow-up worker.
- The driver app (`apps/driver-app/`) was not audited by W2. Its API client and auth flow need separate coverage.
