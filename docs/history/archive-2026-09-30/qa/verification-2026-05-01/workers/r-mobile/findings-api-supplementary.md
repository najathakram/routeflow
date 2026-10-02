# r-mobile

Headline: ⛔ BLOCKED — driver happy-path could not be completed due to login throttle, credential mismatch, and concurrent-session collision.

| Step                       | Status     | Notes (≤ 25 words)                                                                                         |
| -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| 1. resize+viewport         | ✅         | Resized to 375×667 (Chrome rendered ~620×888 with scaling); mobile layout displayed correctly              |
| 2. Navigate + company code | ✅         | Company code screen appeared; `ux-audit-1777265477001` accepted; redirected to login showing "UX Audit Co" |
| 3. Driver login            | ⛔ BLOCKED | `ux_driver_a / UxDriver@123!` returns 401 Invalid Credentials; password does not match seeded value        |
| 3a. Throttle               | ⛔ BLOCKED | Auth endpoint throttled: 10 req / 5 min per IP (RF-160); repeated attempts reset the 5-min window          |
| 3b. Admin fallback         | ⚠️         | Logged in as `ux_admin` (operator); operator dashboard confirmed functional                                |
| 4. Run list (as admin)     | ⚠️         | Dispatch shows "UX Route A · ux_driver_a · 5 stops" — brief says 3 stops                                   |
| 5. Start run               | ⛔ BLOCKED | Could not reach driver surface                                                                             |
| 6. Mark stop delivered     | ⛔ BLOCKED | Could not reach driver surface                                                                             |
| 7. Capture signature       | ⛔ BLOCKED | Could not reach driver surface                                                                             |
| 8. Record CASH payment     | ⛔ BLOCKED | Could not reach driver surface                                                                             |

## Anomalies (NEW findings)

- NEW-rmob-1 [P2] No Retry-After header on 429 — /api/v1/auth/login throttle response lacks `Retry-After`/`X-RateLimit-Reset` headers; clients cannot know when to retry.

- NEW-rmob-2 [P1] Driver credentials invalid + admin reset ineffective — `ux_driver_a` returns 401 with seeded password `UxDriver@123!`. Admin-issued temp password (`838EA8-633D14`) via `POST /users/{id}/reset-password` also returns 401. Possible tenant DB routing issue.

- NEW-rmob-3 [P2] Concurrent worker session collision — Multiple QA workers share one Chrome/localStorage. R-Buyer worker wrote `buyerAccessToken` to same localStorage, erasing admin token; app auto-navigated to buyer routes mid-test. Workers need isolated browser profiles.

- NEW-rmob-4 [P2] Route A shows 5 stops, not 3 — Operator dispatch and Fleet views both show "UX Route A · ux_driver_a · 5 stops". Test brief specifies 3 stops. Seed or prior session may have added stops.

- NEW-rmob-5 [P3] Browser autofill corrupts driver login — Chrome fills `jordan.m` / `ux_admin` into the username field; React form state diverges from DOM; no `autocomplete="off"` on form inputs. Form submits cached admin credentials instead of typed driver credentials.

- NEW-rmob-6 [P3] Operator session triggers uncontrolled auto-navigation — When logged in as `ux_admin`, app navigated automatically through /orders, /catalog, /routes, /invoices without user input. Likely real-time socket events pushing route updates.

## Blockers

1. `ux_driver_a` login blocked: `UxDriver@123!` returns 401; admin-reset temp password also returns 401.
2. Rate limiter (10 req/5 min/IP) prevents retries; no Retry-After header; consecutive test runs permanently lock out the IP for 5+ minutes.
3. Single Chrome session shared by multiple workers causes localStorage collision and uncontrolled navigation.
