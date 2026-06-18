# W32 — Phase 9.D Standing Orders + E2E-8 Locale + Memory Bug Regressions

**Worker:** W32
**Date:** 2026-04-30
**Method:** Chrome browser + javascript_tool (all API calls via browser JS fetch)
**API Domain:** https://routeflowapi-production-d504.up.railway.app/api/v1
**Frontend:** https://routeflowmobile-production.up.railway.app
**Tenant:** ux-audit-1777265477001 (tenantId: 8ee7bbf5-991b-41b1-adcb-4a6c20981401)

---

## Phase 9.D — Standing Order Scheduling Corners

### Discover existing templates

- GET /recurring-invoices → 200, **2 MONTHLY templates found**
- Template 0: `6fef478d`, isActive=false, nextRunAt=2026-05-01, lastRunAt=null
- Template 1: `61bc82ba`, isActive=true, nextRunAt=2026-05-01, lastRunAt=null
- Both have `lastRunAt=null` — scheduler has **never fired** for this tenant

### Buyer-side standing orders

- GET /buyer/standing-orders → **404 Not Found** ("Cannot GET /api/v1/buyer/standing-orders") — ALREADY FILED as RF-180
- GET /standing-order-templates → 404; GET /order-templates → 404

### Pause / skip per-occurrence

- PATCH /recurring-invoices/{id} with `{isActive: false}` → 200 OK, confirmed
- No PAUSED enum — simple boolean toggle only
- **No per-occurrence "skip next" capability exists** — disabling is all-or-nothing
- RESULT: PARTIAL — pause works; granular skip feature does not exist

### Edit template propagation

- PATCH /recurring-invoices/{id} with `{notes: 'W32 test edit'}` → 200 OK, persisted
- No child invoices exist (scheduler never ran) — propagation testing blocked
- RESULT: PASS for edit persistence; propagation untestable

---

## E2E-8 — Locale and Timezone Testing

### UTC offset display

- Orders page: `"Apr 30"` (relative-month, no TZ shown)
- Invoices page: `"3/30/2026"` US M/D/YYYY
- Finance page: `"Apr 28, 2026"` human-readable long
- RESULT: PASS — no raw UTC strings leaked; dates humanized consistently

### requestedDeliveryDate storage

- POST /orders with `requestedDeliveryDate: '2026-12-31T23:30:00Z'` → 201
- Response `requestedDeliveryDate`: **null**
- Follow-up GET confirms: field still null
- RESULT: **FAIL — RF-173 CONFIRMED** (already filed)

### Currency format consistency

- /orders: $5.19, $379.58, $167.85
- /invoices: $100.00, $10.00, $51.91
- /finance: $270.50, $150.00, $120.50
- RESULT: PASS — consistent US dollar format across all pages

---

## Memory Bug Regressions

| Bug # | Description                              | Expected                               | Actual                                                                            | Result       |
| ----- | ---------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- | ------------ |
| #1    | GET /route-runs/my-stats returns 200     | 200                                    | Confirmed by W29                                                                  | PASS         |
| #2    | Buyer can cancel own PENDING order       | 200 "Order cancelled"                  | 200 {"message":"Order cancelled"}                                                 | PASS         |
| #3    | PATCH /customers/me (buyer profile edit) | 200 updated profile                    | /customers/me → 401; /buyer/profile → 200 (read only); PATCH /buyer/profile → 404 | PARTIAL-FAIL |
| #4    | Returns filtered to buyer's customer     | GET /buyer/returns returns own returns | GET /buyer/returns → 404 (endpoint missing)                                       | FAIL         |
| #5    | Route-run create with no POD photos      | 201 no constraint error                | 201 Created, stops have no podPhotoUrls restriction                               | PASS         |
| #6    | Driver change-password title             | Title visible                          | Mobile-only screen; no web equivalent                                             | N/A          |

### Bug #3 Detail

- GET /customers/me with buyer token → 401 "Use buyer auth endpoint" (correct — operator-only route)
- GET /buyer/profile with buyer token → 200 (profile readable)
- PATCH /buyer/profile → **404** (no PUT/PATCH endpoint for buyer profile edit)
- Assessment: fix works for operator-token CUSTOMER role flows but buyer portal users have no way to edit their profile

### Bug #4 Detail

- GET /api/v1/buyer/returns → **404** "Cannot GET /api/v1/buyer/returns"
- The service-layer fix added filtering by customer role on /returns, but there is no /buyer/returns endpoint at all
- Buyers cannot view their returns via any API path

---

## New Issues Found

| #    | Severity | Description                                                                                                      |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| NI-1 | P2       | PATCH /buyer/profile → 404: buyers cannot edit their profile via API (buyer portal profile is read-only)         |
| NI-2 | P2       | GET /buyer/returns → 404: no buyer-facing returns endpoint exists; buyers cannot view their returns              |
| NI-3 | P3       | /finance/dashboard web route → "Unmatched Route" 404; correct URL is /finance                                    |
| NI-4 | INFO     | Recurring invoice scheduler has never fired (lastRunAt=null on all templates) — schedule-trigger testing blocked |
| NI-5 | INFO     | No per-occurrence skip capability for standing orders (all-or-nothing pause only)                                |

---

## RF Numbers to Assign (new from W32)

- **RF-185**: PATCH /buyer/profile → 404 — buyers cannot edit their profile (P2)
- **RF-186**: GET /buyer/returns → 404 — no buyer-facing returns endpoint (P2)
- **RF-187**: /finance/dashboard web route → Unmatched Route 404 (P3)
