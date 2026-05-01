# W28 — Phase 9 Corners: Search/Sort, Clock, Bulk Ops, Multi-Address, Driver Corners

**Worker:** W28
**Date:** 2026-04-30
**Tenant:** ux-audit-1777265477001
**API Base:** https://routeflowapi-production.up.railway.app/api/v1
**Status:** Complete

---

## 9.H — Search, Sort, Pagination

### API Search

| Test | Result | Notes |
|------|--------|-------|
| GET /products?search=bread | PASS | Returns "Multigrain Bread" — partial match, case-insensitive |
| GET /products?search=BUTTER | PASS | Returns "Butter 500g" — case-insensitive confirmed |
| GET /customers?search=cafe | PASS | Returns "UX Empty Cafe" — no diacritics test data available |
| GET /products?search=xyz_not_exist | PASS | 200 empty array (not 404) |
| GET /products?search= | PASS | Returns all 12 products |
| GET /orders?sortBy=createdAt&order=asc | **FAIL — BUG-1** | 400: "property sortBy should not exist" — server-side sort rejected entirely |
| GET /orders?sortBy=total&order=desc | **FAIL** | Same 400 |
| Pagination stability | PASS | No overlap between page=1 and page=2 with limit=5 |
| GET /orders?limit=200 | INFO | Accepted, returned 19 orders — no cap enforced |
| GET /products?page=9999 | PASS | 200 empty array (not error) |
| GET /orders?status=PENDING | PASS | 4 results, all PENDING |
| status + sortBy combo | FAIL | 400 due to sortBy rejection |

### Browser Search

| Test | Result | Notes |
|------|--------|-------|
| Search "bread" on /products | PARTIAL BUG | Pre-selected "Low Stock" filter hides the one bread product — UI shows "No products match" even though API returns it. Filter state not cleared when new search is entered. |
| Special char "&butter" search | PASS | No crash — clean empty state |
| Clear search restores list | PASS | |
| Back button preserves filters | PASS | "Pending" filter survived navigation to detail and back |
| Console messages during search | CLEAN | Only: [expo-notifications] push token web warning (non-blocking) |

---

## 9.K — Clock Simulation

| Test | Result | Notes |
|------|--------|-------|
| POST /invoices dueDate=2026-01-20 | PASS | 201 Created — backdated invoice accepted |
| GET /invoices/:id — isOverdue? | PARTIAL — BUG-4 | status="SENT", isOverdue=true (computed field). Server does NOT auto-transition status to OVERDUE. |
| GET /invoices?status=OVERDUE | **FAIL — BUG-4** | Returns 0 invoices. "OVERDUE" is not a valid status enum. Correct query is `?isOverdue=true` (returns 3). UI Overdue tab fires `?status=OVERDUE` → always empty. |
| GET /analytics or /finance/dashboard | INFO | Both 404 — no analytics API endpoint exists |
| dueDate = today (2026-04-30) | INFO | isOverdue=true — due-today treated as already overdue, no grace period |
| POST /orders requestedDeliveryDate:"2026-02-29" | **FAIL — BUG-3** | 201 Created with requestedDeliveryDate=null. Feb 29, 2026 doesn't exist (not leap year). Should return 400. |
| POST /orders requestedDeliveryDate:"2026-04-30T23:30:00Z" | INFO | 201 Created, date stored as null — see BUG-2 complication |

### Browser Date Display

- Dashboard correctly shows "3 Overdue invoices" using isOverdue computed field
- Invoices list "Overdue" tab fires `?status=OVERDUE` → returns 0 (BUG-4 confirmed in UI)
- Dates displayed as UTC ISO strings — UTC offset rendering bug (W17-003) confirmed still present

---

## 9.L — Bulk Operations

| Test | Result | Notes |
|------|--------|-------|
| POST /orders x10 for same customer | **FAIL — BUG-2** | All 10 returned same order ID. Only 1 order created. Each call updated the existing PENDING order instead of creating a new one. |
| GET /orders?limit=20 | PASS | 19 orders, response under 2s |
| DELETE /orders {ids:[...]} | GAP | 404 — no bulk delete API |
| POST /orders/bulk-delete | GAP | 404 — no endpoint |
| GET /orders/export | GAP | 404 — "export" treated as order ID |
| GET /orders?format=csv | GAP | 400 — "property format should not exist" |
| GET /orders/download | GAP | 404 |
| Browser: bulk checkboxes | GAP | No checkboxes in order list. No bulk export button. |

---

## 9.M — Multi-Address / Shipping vs Billing

| Test | Result | Notes |
|------|--------|-------|
| POST /customers with billingAddress + shippingAddress top-level | FAIL | 400 — wrong schema. Correct field is `addresses` array. |
| POST /customers with addresses array (billing + shipping) | PASS (with BUG-5) | Customer created, but "Shipping" address stored with addressType="BILLING". Type not inferred from label. |
| Order for multi-address customer — which address? | INFO | deliveryAddress=null — no address inherited from customer on order create |
| Invoice for multi-address customer — which address? | INFO | Invoice embeds only customer name/contact, no address fields |

---

## 9.O — Driver Workflow Corners

| Test | Result | Notes |
|------|--------|-------|
| Complete stop 3 before stop 2 (out-of-order) | **GAP** | 201 — no sequential enforcement. Out-of-order allowed. |
| Geofence bypass {lat:0.0, lng:0.0} | **GAP** | 201 — no geofence validation. Null island accepted. |
| Overpayment (invoice total + $100) | PASS | 400: "Payment exceeds remaining balance" — correctly blocked |
| Mileage fields in run response | GAP | No mileage/distance fields in run schema |
| PATCH /route-runs/:id {mileage:100} | GAP | 200 response but value not persisted — silently ignored |
| GET /route-runs/:id/mileage | GAP | 404 |

---

## E2E-9 — Large Dataset Smoke

| Metric | Result |
|--------|--------|
| /orders page load | 299ms — PASS |
| /home page load | 198ms — PASS |
| Pagination stability | PASS — no duplicates across pages |
| Loading indicators | Spinner present, no skeleton screens |
| Console errors during navigation | NONE |

---

## Bugs

### BUG-1 (P2): Server-side sort completely unsupported on /orders
`GET /orders?sortBy=createdAt&order=asc` → 400: "property sortBy should not exist". Sort query params are whitelisted out of the DTO. No server-side sorting is possible on orders. Operators cannot sort by Total, Date, Status, Customer.

### BUG-2 (P1): POST /orders upserts existing PENDING order instead of creating new one
All 10 operator-side `POST /orders` calls for the same customer returned the same order ID. The API updates/upserts the existing PENDING order rather than creating a new one. Operators cannot create multiple simultaneous orders for the same customer if one is already PENDING. Likely the same `mergeAllPendingForCustomer()` mechanism as RF-148.

### BUG-3 (P2): Invalid dates (e.g. Feb 29 in non-leap year) accepted with 201, stored as null
`POST /orders {requestedDeliveryDate:"2026-02-29"}` returns 201 with the date stored as null. The date parser silently coerces the invalid date to null instead of returning 400.

### BUG-4 (P2): GET /invoices?status=OVERDUE returns 0 — "OVERDUE" is not a valid status enum
The correct query is `?isOverdue=true`. The UI Overdue tab fires `?status=OVERDUE` which always returns an empty list, making the Overdue filter completely broken. Dashboard count is correct (uses isOverdue computed field), but the list is always empty.

### BUG-5 (P3): Customer addresses always stored as addressType=BILLING regardless of label
When creating a customer with an address labelled "Shipping", it is stored with addressType="BILLING". The address type is not inferred from the label. There is no way to create a SHIPPING-typed address.

---

## Gaps (Missing Features)

| Gap | Description |
|-----|-------------|
| GAP-1 | No bulk delete API for orders |
| GAP-2 | No CSV export API for orders (format param rejected) |
| GAP-3 | No sequential stop enforcement — out-of-order completion allowed |
| GAP-4 | No geofence validation on stop completion |
| GAP-5 | No mileage tracking (no schema field, no endpoint, PATCH silently ignored) |
| GAP-6 | No analytics/finance dashboard API — all variants 404 |

---

## Additional Observations

- `POST /customers` response is `{customer:{...}, user:{...}, tempPassword:"..."}` — nested, not flat
- `POST /invoices` items field: requires `qty` not `quantity` (returns 400 if wrong name)
- Anomalous order ORD-1777431385834 shows total=$25,664,510.89 — from W9 concurrent test qty overflow
- App calls `routeflowapi-production-d504.up.railway.app` (not documented URL) — confirms RF-146
- Buyer 2 credentials (`ux_buyer2_1777265477001@ux-audit.test`) returned 401 — may be tenant data decay

---

## Test Data Created

| Type | ID | Notes |
|------|-----|-------|
| Invoice | b61c5cb2-df68-4acd-b0e9-752b601bff78 | INV-2026-0012, SENT, dueDate=2026-01-20 (backdated) |
| Invoice | a10030f0-3220-42a7-9ae9-e5f49410c2ea | INV-2026-0014, SENT, dueDate=2026-04-30 |
| Customer | dff6f7ac-2381-4322-80d8-43ba89e996a9 | W28 MultiAddr Test |
| Order | d204cea4-6b6f-4abf-ac46-51d3c4956da6 | UX Empty Cafe — updated ~10x by BUG-2 test |
| Order | 74867a48-8409-402d-9c2e-226fa160af96 | W28 MultiAddr Test, PENDING |
