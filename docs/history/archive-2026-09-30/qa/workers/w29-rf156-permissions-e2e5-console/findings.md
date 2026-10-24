# W29 — RF-156 Verification, Permission Matrix, E2E-5, Console Audit

Worker: W29
Date: 2026-04-30
Method: Chrome browser + javascript_tool (all API calls via browser JS fetch/XHR)
API Domain (correct, used by frontend): https://routeflowapi-production-d504.up.railway.app/api/v1
Frontend: https://routeflowmobile-production.up.railway.app
Tenant: ux-audit-1777265477001 (tenantId: 8ee7bbf5-991b-41b1-adcb-4a6c20981401)

---

## Task 1: RF-156 Cross-Tenant Verification

**Verdict: CLEAN**

### All Invoices (GET /invoices)

- Total returned: 14
- Unique tenantIds: ["8ee7bbf5-991b-41b1-adcb-4a6c20981401"] — ux-audit tenant only
- <live product A> / <live product B> records found: 0

### SENT Invoices (GET /invoices?status=SENT)

- Total returned: 2
- Unique tenantIds: ["8ee7bbf5-991b-41b1-adcb-4a6c20981401"] — ux-audit tenant only

### Customer Search (GET /customers?search=Blue+Dreamz)

- HTTP 200, 0 results returned

No cross-tenant data leakage detected. All invoice and customer records correctly scoped to ux-audit tenant.

---

## Task 2: Permission Matrix

### Buyer Role (ux_buyer1 — BUYER token type, auth via /buyer/auth/login)

| Endpoint                             | Expected | Actual | Result                                                        |
| ------------------------------------ | -------- | ------ | ------------------------------------------------------------- |
| GET /orders                          | 403      | 401    | Access denied (BUYER JWT rejected by operator guard with 401) |
| GET /route-runs                      | 403      | 401    | Access denied                                                 |
| GET /users                           | 403      | 401    | Access denied                                                 |
| GET /customers                       | 403      | 401    | Access denied                                                 |
| GET /invoices                        | 403      | 401    | Access denied                                                 |
| GET /products                        | any      | 401    | Access denied                                                 |
| GET /returns                         | 403      | 401    | Access denied                                                 |
| GET /drivers                         | 403      | 401    | Access denied                                                 |
| GET /buyer/orders (+x-tenant-slug)   | 200      | 200    | PASS                                                          |
| GET /buyer/invoices (+x-tenant-slug) | 200      | 200    | PASS                                                          |
| GET /buyer/profile (+x-tenant-slug)  | 200      | 200    | PASS                                                          |

Note: BUYER tokens return 401 (not 403) on operator endpoints because they are a different JWT type. Access is correctly denied — this is a code style issue not a security bug.

### Driver Role (ux_driver_a)

| Endpoint                 | Expected | Actual | Result                          |
| ------------------------ | -------- | ------ | ------------------------------- |
| GET /orders              | 403      | 403    | PASS                            |
| GET /route-runs          | 200      | 200    | PASS                            |
| GET /users               | 403      | 403    | PASS                            |
| GET /customers           | 403      | 403    | PASS                            |
| GET /invoices            | 403      | 403    | PASS                            |
| GET /products            | 200      | 200    | PASS                            |
| GET /returns             | 403      | 200    | FAIL — Driver can read /returns |
| GET /drivers             | 403      | 403    | PASS                            |
| GET /route-runs/my-stats | 200      | 200    | PASS                            |

BUG: Driver role receives HTTP 200 on GET /returns. Data returned: 1 return record (id: bb19da5d, reason: DAMAGED). Drivers should not have access to the returns list endpoint.

---

## Task 3: E2E-5 Multi-Stop Dispatch Corners

Run used: 5dd3bcf5-b190-4c36-8f77-1c94a234a5d3 (SCHEDULED, 4 stops: 1/2/4 PENDING, 3 SKIPPED)

| Test | Action                                                     | HTTP Status | Expected          | Result |
| ---- | ---------------------------------------------------------- | ----------- | ----------------- | ------ |
| 1    | Complete stop 4 before stops 1,2,3 (out-of-order)          | 201         | 400/422           | FAIL   |
| 2    | Complete stop 2 before stop 1 (out-of-order)               | 201         | 400               | FAIL   |
| 3    | Complete stops on SCHEDULED (not started) run              | 201         | 400/409           | FAIL   |
| 4    | Add stop to active run (POST /route-runs/{id}/stops)       | 404         | 404 (no endpoint) | PASS   |
| 5    | Re-complete already-COMPLETED stop                         | 400         | 400               | PASS   |
| 6    | In-order completion (last PENDING stop on IN_PROGRESS run) | 201         | 201               | PASS   |

Additional: Run f1beec5b remained SCHEDULED after 2 stops were manually completed — run status does not auto-transition to IN_PROGRESS when stops are completed out-of-band.

---

## Task 4: Console & Security Audit

### Console Messages by Page

| Page       | Errors | Warnings                                    |
| ---------- | ------ | ------------------------------------------- |
| /home      | 0      | 1 (expo-notifications web — known/expected) |
| /orders    | 0      | 1 (expo-notifications web)                  |
| /customers | 0      | 1 (expo-notifications web)                  |
| /products  | 0      | 1 (expo-notifications web)                  |
| /invoices  | 0      | 1 (expo-notifications web)                  |
| /routes    | 0      | 1 (expo-notifications web)                  |
| /dispatch  | 0      | 1 (expo-notifications web)                  |

Console is clean across all pages. The only warning is the Expo push notification stub message which is an expected framework limitation on web.

### Network Requests

- No 4xx/5xx responses on normal page navigation
- All API calls correctly target routeflowapi-production-d504.up.railway.app

### Security Headers

Security headers cannot be verified from browser JavaScript. CORS exposes only content-type and content-length in responses (Access-Control-Expose-Headers is not set). Direct server-side inspection required for:

- Content-Security-Policy
- X-Content-Type-Options
- X-Frame-Options
- Strict-Transport-Security
- Referrer-Policy
- Permissions-Policy

### API Domain Observation

Two API hostnames share the same database:

- routeflowapi-production.up.railway.app (documented in memory)
- routeflowapi-production-d504.up.railway.app (what the frontend actually calls)

Likely same Railway service with generated + custom hostname. Mutations on either domain appear on both. Confirm in Railway dashboard.

---

## Bug Summary

| #   | Severity | Description                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------ |
| 1   | P2       | Driver role: GET /returns returns HTTP 200 — should be 403                                       |
| 2   | P2       | Out-of-order stop completion not enforced (stop N before stop N-1 allowed)                       |
| 3   | P2       | Stop completion allowed on SCHEDULED runs (run must be IN_PROGRESS first)                        |
| 4   | P3       | Run status does not auto-transition to IN_PROGRESS when stops completed on SCHEDULED run         |
| 5   | P3       | Security headers not verifiable from browser (CORS does not expose them) — requires server audit |
| 6   | INFO     | Buyer BUYER-type JWT returns 401 (not 403) on operator endpoints — minor HTTP semantics issue    |

RF-156 VERDICT: CLEAN — no cross-tenant data leakage detected.
