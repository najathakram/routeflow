# RouteFlow Pre-Release Audit Report

**Date**: 2026-04-09  
**Deployment**: https://routeflowweb-production.up.railway.app  
**API**: https://routeflowapi-production-d504.up.railway.app/api/v1  
**Tenant**: legacy  
**Auditor**: Automated (Claude Opus 4.6)

---

## Executive Summary

The audit tested 228 planned test cases across 25 categories, plus 15 adversarial vulnerability entries. Testing was conducted against the live Railway production deployment using API-level verification (curl) and browser automation.

### Verdict: **NOT READY FOR RELEASE**

**3 Critical blockers** must be fixed before shipping:

1. Payment recording is completely broken (500 Internal Server Error)
2. Driver role has excessive API access (can read all customers, invoices, credit notes)
3. No rate limiting on login endpoint (brute-force vulnerable)

---

## Results Summary

| Category                   | Pass    | Fail   | Blocked | N/A     | Notes                                                               |
| -------------------------- | ------- | ------ | ------- | ------- | ------------------------------------------------------------------- |
| Authentication (AUTH)      | 14      | 2      | 0       | 4       | Rate limiting + lockout missing                                     |
| Operator Dashboard (DASH)  | 12      | 0      | 0       | 3       | All sections render correctly                                       |
| Customer Dashboard (CDASH) | 4       | 0      | 0       | 4       | Role-gating NOT deployed to Railway                                 |
| Driver Dashboard (DDASH)   | 3       | 0      | 0       | 3       | Role-gating NOT deployed to Railway                                 |
| Orders (ORD)               | 12      | 0      | 0       | 13      | Status transitions, pagination, filtering all work                  |
| Invoices (INV)             | 14      | 1      | 3       | 7       | Payment recording broken; send/void/revert/write-off/duplicate work |
| Credit Notes (CN)          | 5       | 0      | 0       | 3       | List, detail, zero/negative validation work                         |
| Estimates (EST)            | 1       | 0      | 0       | 7       | List works; no test data to verify lifecycle                        |
| Returns (RET)              | 4       | 0      | 0       | 8       | List, detail, validation work                                       |
| Routes (RTE)               | 5       | 0      | 0       | 13      | List, detail, driver access correct                                 |
| Customers (CUST)           | 3       | 0      | 0       | 12      | List, search, pagination work                                       |
| Drivers (DRV)              | 2       | 0      | 0       | 4       | List works                                                          |
| Products (PROD)            | 3       | 0      | 0       | 9       | List, search work                                                   |
| Suppliers (SUP)            | 1       | 0      | 0       | 3       | List works                                                          |
| Inventory (INV2)           | 0       | 1      | 0       | 7       | Purchase orders endpoint missing (404)                              |
| Finance (FIN)              | 1       | 3      | 0       | 8       | Reports endpoints missing (404); expenses works                     |
| Settings (SET)             | 1       | 0      | 0       | 9       | Settings endpoint exists                                            |
| Platform Admin (PADM)      | 0       | 2      | 0       | 6       | /tenants and /audit-logs return 404                                 |
| Security (SEC)             | 12      | 4      | 0       | 4       | IDOR blocked; driver scope too broad; no rate limit                 |
| Edge Cases (EDGE)          | 5       | 1      | 0       | 9       | Double-click creates duplicates                                     |
| UX Fixes (UX)              | 0       | 0      | 0       | 10      | Role-gating changes not deployed                                    |
| Financial Accuracy (FINA)  | 1       | 0      | 5       | 2       | Blocked by payment 500                                              |
| **TOTAL**                  | **102** | **14** | **8**   | **148** |                                                                     |

---

## CRITICAL BLOCKERS (Must Fix Before Release)

### BUG-001: Payment Recording Returns 500 Internal Server Error

- **Severity**: CRITICAL (PRODUCTION BLOCKER)
- **Tests affected**: INV-008, INV-017, INV-018, FINA-002, FINA-003, WK-001
- **Endpoint**: `POST /invoices/:id/payments`
- **Root cause**: Missing `tenantId` in `InvoicePayment.create()` call in `invoices.service.ts` (line ~759). The multi-tenant migration added tenantId to all models but `recordPayment()` was not updated.
- **Secondary cause**: `PaymentCounter` uses hardcoded `id: "singleton"` without tenant awareness — will cause cross-tenant payment number collisions.
- **Fix location**: `apps/api/src/invoices/invoices.service.ts`, lines 741-760
- **Fix**: Add `tenantId` to `InvoicePayment.create()` data object, and use tenant-scoped PaymentCounter query.

### BUG-002: Driver Role Has Excessive API Access

- **Severity**: HIGH
- **Tests affected**: SEC-004, SEC-005, DRV-006
- **Findings**:
  - Driver CAN read: `/customers` (200), `/invoices` (200), `/credit-notes` (200), `/returns` (200), `/products` (200)
  - Driver CAN create: `POST /orders` returns 400 validation (not 403), `POST /invoices` returns 400 (not 403), `POST /returns` returns 400 (not 403)
  - Driver blocked from: `/suppliers` (403), `/estimates` (403), `/settings` (403), `POST /products` (403), `POST /customers` (403)
- **Impact**: A malicious driver could read all customer contact info, view all invoices, and potentially create orders/invoices with valid data.
- **Fix**: Add role guards to orders, invoices, and returns controllers for create operations. Consider restricting customer read access for drivers.

### BUG-003: No Rate Limiting on Login Endpoint

- **Severity**: HIGH
- **Tests affected**: AUTH-018, AUTH-019
- **Findings**: 20 consecutive failed login attempts all returned 401, no 429 throttle or account lockout.
- **Impact**: Brute-force password attacks possible.
- **Fix**: Implement rate limiting on `POST /auth/login` (e.g., 10 failures per 60 seconds per IP + exponential backoff).

---

## HIGH-PRIORITY ISSUES (Fix Before or Shortly After Release)

### BUG-004: Purchase Orders Endpoint Missing (404)

- **Severity**: MEDIUM
- **Endpoint**: `GET /purchase-orders` returns 404
- **Impact**: Inventory management (purchase orders) is non-functional via API.

### BUG-005: Finance Reports Endpoints Missing (404)

- **Severity**: MEDIUM
- **Endpoints**: `/reports/ar-aging`, `/reports/sales-by-customer`, `/reports/profit-and-loss`, `/analytics/dashboard` — all return 404
- **Impact**: Finance dashboard and reports are non-functional via API. May be client-side computed.

### BUG-006: Platform Admin Endpoints Missing (404)

- **Severity**: MEDIUM
- **Endpoints**: `/tenants`, `/audit-logs` return 404
- **Impact**: SUPER_ADMIN cannot manage tenants or view audit logs via API. Platform admin panel non-functional.

### BUG-007: No Idempotency Protection on Order Creation

- **Severity**: MEDIUM
- **Test**: EDGE-011
- **Finding**: Two concurrent `POST /orders` with identical data both succeed, creating 2 separate orders (ORD-1775714298456, ORD-1775714298460).
- **Impact**: Network retries or double-clicks can create duplicate orders.

### BUG-008: UX Audit Changes Not Deployed to Railway

- **Severity**: MEDIUM
- **Finding**: Role-gated dashboard, confirmation modals, invoice icon visibility changes, and other UX fixes from the previous session are NOT present in the Railway deployment. Driver users see the full operator dashboard with errors.

---

## PASSING TEST RESULTS (Key Verifications)

### Authentication & Authorization

| Test     | Result | Details                                              |
| -------- | ------ | ---------------------------------------------------- |
| AUTH-001 | PASS   | Operator login returns JWT with role=OPERATOR        |
| AUTH-002 | PASS   | Wrong password returns 401 "Invalid credentials"     |
| AUTH-003 | PASS   | Nonexistent user returns same 401 (no info leak)     |
| AUTH-005 | PASS   | Customer JWT has role=CUSTOMER                       |
| AUTH-006 | PASS   | Driver JWT has role=DRIVER                           |
| AUTH-011 | PASS   | Token refresh returns new accessToken + refreshToken |
| AUTH-015 | PASS   | Google OAuth button present on login page            |
| AUTH-020 | PASS   | Without X-Tenant-Slug, login rejected                |
| SEC-009  | PASS   | API without token returns 401                        |
| SEC-012  | PASS   | Tampered JWT rejected with 401                       |

### IDOR & Cross-Tenant Isolation

| Test     | Result | Details                                              |
| -------- | ------ | ---------------------------------------------------- |
| SEC-002  | PASS   | harbor_cafe sees own orders only                     |
| SEC-011  | PASS   | north_deli cannot access harbor_cafe's order (403)   |
| SEC-013  | PASS   | Cross-customer delete blocked (403)                  |
| IDOR-INV | PASS   | north_deli cannot access harbor_cafe's invoice (403) |
| SEC-003  | PASS   | Customer cannot create invoices (403)                |
| SEC-008  | PASS   | SQL injection returns empty results, no error        |

### Order Management

| Test     | Result | Details                                     |
| -------- | ------ | ------------------------------------------- |
| ORD-001  | PASS   | Pagination: total=10, limit=5, totalPages=2 |
| ORD-012  | PASS   | PENDING -> CONFIRMED                        |
| ORD-013  | PASS   | CONFIRMED -> OUT_FOR_DELIVERY               |
| ORD-014  | PASS   | OUT_FOR_DELIVERY -> DELIVERED               |
| ORD-016  | PASS   | Cannot cancel DELIVERED (400)               |
| ORD-017  | PASS   | Demotion requires reason                    |
| ORD-023  | PASS   | Customer sees own orders only               |
| EDGE-007 | PASS   | Negative quantity rejected (400)            |
| EDGE-014 | PASS   | Invalid UUID returns 404 (not 500)          |

### Invoice Management

| Test     | Result | Details                                                   |
| -------- | ------ | --------------------------------------------------------- |
| INV-001  | PASS   | Pagination: total=14, totalPages=3                        |
| INV-007  | PASS   | Send: DRAFT -> SENT                                       |
| INV-009  | PASS   | Void via POST works                                       |
| INV-010  | PASS   | Revert to draft works                                     |
| INV-011  | PASS   | Write-off works, status=WRITTEN_OFF                       |
| INV-012  | PASS   | Duplicate creates new DRAFT                               |
| INV-015  | PASS   | Cannot edit non-DRAFT (400)                               |
| INV-019  | PASS   | Cannot send VOID invoice (400)                            |
| INV-024  | PASS   | Customer sees own invoices only (2)                       |
| INV-025  | PASS   | Unvoid: VOID -> DRAFT                                     |
| EDGE-010 | PASS   | Overpayment blocked: "exceeds remaining balance of 86.93" |

### Credit Notes & Returns

| Test    | Result | Details                                    |
| ------- | ------ | ------------------------------------------ |
| CN-001  | PASS   | 3 credit notes listed                      |
| CN-003  | PASS   | Detail shows number, status, amount        |
| CN-007  | PASS   | Zero amount rejected (400)                 |
| CN-008  | PASS   | Negative amount rejected (400)             |
| RET-001 | PASS   | 5 returns listed                           |
| RET-003 | PASS   | Detail shows return number, status, reason |

### Routes & Dispatch

| Test    | Result | Details                            |
| ------- | ------ | ---------------------------------- |
| RTE-001 | PASS   | 10 routes listed                   |
| RTE-003 | PASS   | Route run detail loads with status |
| RTE-016 | PASS   | Driver sees own routes only (1)    |
| RTE-017 | PASS   | Driver cannot create routes (403)  |

### Entity Management

| Test     | Result | Details                          |
| -------- | ------ | -------------------------------- |
| CUST-001 | PASS   | 10 customers, pagination works   |
| CUST-002 | PASS   | Search "harbor" returns 1 result |
| PROD-001 | PASS   | 12 products listed               |
| PROD-011 | PASS   | Search "bread" returns 1 result  |
| SUP-001  | PASS   | 10 suppliers listed              |
| DRV-001  | PASS   | 10 drivers listed                |

---

## Vulnerability Catalog Status

| WK ID  | Issue                         | Status       | Notes                                                         |
| ------ | ----------------------------- | ------------ | ------------------------------------------------------------- |
| WK-001 | Double payment race condition | BLOCKED      | Cannot test — payments return 500                             |
| WK-002 | Driver can create invoices    | CONFIRMED    | POST /invoices returns 400 (not 403) for driver               |
| WK-003 | Receipt upload any file type  | NOT TESTED   | Upload endpoint not exercised                                 |
| WK-004 | Files served without auth     | INCONCLUSIVE | /uploads path returns 404                                     |
| WK-005 | No account lockout            | CONFIRMED    | 20 failed attempts, no lockout                                |
| WK-006 | Tokens in localStorage        | CONFIRMED    | Known design decision                                         |
| WK-007 | IDOR on customer endpoints    | RESOLVED     | Cross-customer access returns 403                             |
| WK-008 | Order demotion audit trail    | PARTIAL      | Demotion requires reason (captured)                           |
| WK-009 | Interrupted workflows         | NOT TESTED   | Requires browser interaction                                  |
| WK-010 | Credit note wrong invoice     | NOT TESTED   | Requires UI interaction                                       |
| WK-011 | Concurrent stop completion    | NOT TESTED   | Requires route run simulation                                 |
| WK-012 | POD URL validation            | NOT TESTED   | Requires route run completion                                 |
| WK-013 | Bulk delete confirmation      | NOT TESTED   | Requires UI interaction                                       |
| WK-014 | Invoice overpayment           | RESOLVED     | API validates: "Payment exceeds remaining balance"            |
| WK-015 | Payment idempotency           | NOT TESTED   | Payments broken; but EDGE-011 confirms no general idempotency |

---

## Pre-Ship Fix Priority

### Tier 1: MUST FIX (Blocks Release)

1. **BUG-001**: Fix payment recording — add `tenantId` to `InvoicePayment.create()` and `PaymentCounter` query
2. **BUG-002**: Add role guards for driver on orders/invoices/returns creation endpoints
3. **BUG-003**: Add rate limiting to login endpoint

### Tier 2: SHOULD FIX (First Week)

4. **BUG-004/005/006**: Deploy missing API endpoints (purchase orders, reports, platform admin)
5. **BUG-007**: Add idempotency protection on order/payment creation
6. **BUG-008**: Deploy UX audit changes (role-gated dashboard, confirmation modals)

### Tier 3: POST-LAUNCH

7. WK-006: Migrate from localStorage to HttpOnly cookies
8. WK-012: Validate POD photo URLs
9. WK-013: Enhanced bulk delete confirmation

---

## Test Environment Notes

- Browser automation (Chrome MCP) had persistent JavaScript execution failures ("Cannot access chrome-extension:// URL"). API-level testing via curl was used as primary method.
- 148 of 228 tests were marked N/A due to: feature not yet deployed, requires UI interaction not possible via API, or insufficient test data. These should be re-run manually or with functioning browser automation.
- CORS headers show `access-control-allow-credentials: true` with `Vary: Origin` — should be verified that it doesn't reflect arbitrary origins.
- All tests run against tenant `legacy` — cross-tenant isolation was not directly tested (only one tenant available).

---

## Recommended Next Steps

1. Fix BUG-001 (payment tenantId) — this is the #1 blocker
2. Fix BUG-002 (driver role guards) — security critical
3. Deploy UX audit changes to Railway (BUG-008)
4. Re-run this audit with functioning browser automation to cover the 148 N/A tests
5. Deploy platform admin endpoints (BUG-006) for tenant management
6. Add comprehensive API rate limiting (BUG-003)
