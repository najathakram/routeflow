# v1

| RF     | Status      | Evidence (≤ 30 words)                                                                                                                                                 |
| ------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-001 | ✅ VERIFIED | All 5 route runs have `tenantId: "8ee7bbf5-..."` (non-null). Dispatched runs appear in `GET /route-runs` with correct tenantId.                                       |
| RF-003 | ✅ VERIFIED | `POST /route-runs/:id/stops/:stopId/complete` on SCHEDULED run → 403 "Cannot complete a stop on a run that is not in progress (current status: SCHEDULED)."           |
| RF-014 | ❌ FAIL     | `ORD-1777431385832` appears twice in 29 orders from `GET /orders?limit=100`. Duplicate order number confirmed in live data.                                           |
| RF-017 | ❌ FAIL     | `POST /orders` for Almond Mix (currentStock=0, qty=5) → HTTP 201. No stock check enforced; OOS order accepted silently.                                               |
| RF-073 | ✅ VERIFIED | `PATCH /users/:driverId` with `{role:"OPERATOR"}` → HTTP 200 but `role` in response still "DRIVER". Mass-assignment blocked.                                          |
| RF-074 | ⛔ BLOCKED  | `GET/POST/DELETE /customers` all return HTTP 500. Cannot create QA customer or test cascade delete guard.                                                             |
| RF-075 | ✅ VERIFIED | Browser navigation to `/api/v1/uploads/products/…/file.svg` without auth → `{"message":"Unauthorized","statusCode":401}`.                                             |
| RF-076 | ❌ FAIL     | SVG with `<script>window._xss_w27=1</script>` stored at product images path. Served HTTP 200, `content-type: image/svg+xml`, no `Content-Disposition`. XSS confirmed. |
| RF-077 | ✅ VERIFIED | Operator uses `accessToken` key; buyer uses `buyerAccessToken` key. Both coexist in localStorage without conflict.                                                    |
| RF-079 | ⛔ BLOCKED  | `PATCH /customers/:id` returns HTTP 500. Cannot set `isTaxExempt=true` to verify tax exemption on orders.                                                             |
| RF-080 | ⛔ BLOCKED  | `DELETE /customers/bulk` returns HTTP 500. Customers endpoint systemically broken; bulk delete untestable.                                                            |
| RF-081 | ⛔ BLOCKED  | Only 1 return in tenant (buyer2's). `GET /buyer/returns` → 404. Cannot test cross-customer IDOR.                                                                      |
| RF-082 | ⛔ BLOCKED  | `GET /buyer/returns` → 404 endpoint missing. Cannot identify another buyer's return to attempt unauthorized cancel.                                                   |
| RF-083 | ⛔ BLOCKED  | `GET /customers/:id` returns HTTP 500 for all roles (driver, operator). PII filtering cannot be verified.                                                             |
| RF-093 | ✅ VERIFIED | After `POST /users/:id/reset-password`, JWT has `forcePasswordChange:true`. `GET /route-runs/my-runs` → 403 "Password change required."                               |
| RF-147 | ✅ VERIFIED | `POST /invoices/from-order/:orderId` → HTTP 201, `tenantId: "8ee7bbf5-991b-41b1-adcb-4a6c20981401"` (non-null).                                                       |
| RF-157 | ❌ FAIL     | Same SVG payload as RF-076 — `<script>alert(1)</script>` stored at product images URL. Served inline; no upload rejection.                                            |
| RF-160 | ✅ VERIFIED | HTTP 429 `ThrottlerException: Too Many Requests` observed on `POST /auth/login` after ~5 rapid attempts. Rate limit active.                                           |
| RF-176 | ✅ VERIFIED | `POST /auth/login` with no `X-Tenant-Slug` header → HTTP 401 "Tenant not found". No JWT issued; no null-tenantId token.                                               |
| RF-197 | ⛔ BLOCKED  | `DELETE /customers/:id` returns HTTP 500. Cascade delete behavior cannot be verified.                                                                                 |

## Failures

### RF-014 — Order number duplicate race: MAX+1 with no unique constraint

Repro: `GET /orders?limit=100` → orders array contains `ORD-1777431385832` twice (2 distinct order objects, same `orderNumber`).
Expected: Every order has a unique `orderNumber`.
Got: Duplicate confirmed in live tenant data (29 total orders, 1 duplicate orderNumber).
Suspected cause: MAX+1 strategy with no DB unique constraint; concurrent inserts produce identical numbers.
Proposed fix: Add unique index on `(tenantId, orderNumber)` and use DB sequence or `SELECT FOR UPDATE` when generating numbers.

### RF-017 — No stock check at order creation

Repro: `GET /products/f31568b9` shows `currentStock: "0"`. `POST /orders {customerId, items:[{productId: f31568b9, qty:5, unitPrice:8.99}]}` → HTTP 201 created.
Expected: HTTP 422 rejecting order because `currentStock < requestedQty`.
Got: HTTP 201 — order created, no stock validation.
Suspected cause: `orders.service.ts create()` does not query current stock before writing.
Proposed fix: Validate `product.currentStock >= requestedQty` per item before insert; return 422 if insufficient.

### RF-076 / RF-157 — Stored XSS: SVG uploaded and served inline

Repro: Product image `c17e3ad9-…c.svg` already in storage contains `<svg><script>window._xss_w27=1</script>…</svg>`. Fetch with valid auth → HTTP 200, `content-type: image/svg+xml`, script in body. No `Content-Disposition: attachment`.
Expected: SVG uploads rejected at validation (400) OR served with `Content-Disposition: attachment`.
Got: SVG accepted at upload, served inline → stored XSS for any authenticated user loading product images.
Suspected cause: Upload validation does not reject `image/svg+xml`; file serving omits `Content-Disposition`.
Proposed fix: Allowlist JPEG/PNG/WEBP only on image upload endpoints; add `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` for all non-image file serving.

## Blocked items

RF-074, RF-079, RF-080, RF-083, RF-197 — All blocked by systemic `GET/POST/PATCH/DELETE /customers/*` → HTTP 500 in tenant `ux-audit-1777265477001`. The customers module is completely broken server-side; RF behaviors cannot be verified until restored.

RF-081, RF-082 — Blocked: `GET /buyer/returns` → 404 (endpoint not implemented), and only 1 return exists in the tenant (buyer2's own). Cross-customer IDOR cannot be tested.

## Adjacent bugs noticed

- NEW-v1-1 [P1] Frontend calls wrong API host for customers — GUI fires `GET https://routeflowapi-production-d504.up.railway.app/api/v1/customers?limit=100` (HTTP 401) instead of correct host. Customers page shows empty state.
- NEW-v1-2 [P1] Entire `/customers/*` API returns HTTP 500 for tenant `ux-audit-1777265477001` — all CRUD operations fail, blocking 6 assigned RFs.
- NEW-v1-3 [P2] `GET /buyer/returns` returns 404 — buyer returns portal endpoint not implemented.
- NEW-v1-4 [P2] `POST /orders` may upsert existing order — creating order for customer `ebc75f88` returned pre-existing order ID `cfdaae24` (possible RF-172 overlap).
