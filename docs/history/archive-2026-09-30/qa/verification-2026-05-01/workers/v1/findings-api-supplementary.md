# v1

| RF     | Status | Evidence (≤ 30 words)                                                                                                |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| RF-001 | ✅     | GET /route-runs/my-runs → run tenantId="8ee7bbf5-991b-41b1-adcb-4a6c20981401" (not null); driver sees dispatched run |
| RF-003 | ⛔     | All routes in tenant have 0 RouteStops; cannot create SCHEDULED run with stops to test guard                         |
| RF-014 | ❌     | ORD-1777431385832 appears for 2 distinct order IDs (28d3247b, 14b8ba63) created at identical timestamp               |
| RF-017 | ❌     | POST /orders with stock=0 product (Almond Mix f31568b9) → HTTP 201; no stock validation enforced                     |
| RF-073 | ✅     | Driver PATCH /users/:id with {"role":"OPERATOR"} → HTTP 200, role=DRIVER unchanged (field ignored)                   |
| RF-074 | ⛔     | GET/DELETE /customers/:id returns 500 Internal Server Error; customers module broken, cannot test                    |
| RF-075 | ✅     | GET /uploads/test.jpg without auth → HTTP 401; files not publicly accessible                                         |
| RF-076 | ⛔     | Multipart upload to /products/:id/images fails connection reset after SSL renegotiation; cannot test SVG blocking    |
| RF-077 | ⛔     | localStorage namespace isolation is frontend-only; cannot verify via API curl                                        |
| RF-079 | ⛔     | GET /customers/:id → 500 for all roles; isTaxExempt field inaccessible; cannot test order tax calc                   |
| RF-080 | ⛔     | DELETE /customers/bulk → 500 Internal Server Error; customers module broken, cannot test cascade                     |
| RF-081 | ❌     | Driver token GET /returns/bb19da5d → HTTP 200 with full customer return data (IDOR: drivers read any return)         |
| RF-082 | ✅     | Driver token POST /returns/bb19da5d/cancel → HTTP 403 Forbidden (ownership check enforced for cancel)                |
| RF-083 | ⛔     | GET /customers/:id → HTTP 500 for DRIVER and TENANT_ADMIN tokens; endpoint broken, cannot assess PII exposure        |
| RF-093 | ⛔     | PATCH /users rejects forcePasswordChange field (400 "property should not exist"); cannot set flag to test            |
| RF-147 | ✅     | POST /invoices/from-order/:orderId → invoice.tenantId="8ee7bbf5-991b-41b1-adcb-4a6c20981401" (not null)              |
| RF-157 | ⛔     | Same upload connectivity issue as RF-076; cannot deliver SVG payload to determine if blocked or accepted             |
| RF-160 | ✅     | 12 consecutive wrong-password attempts → all HTTP 429 (rate limiting active and working)                             |
| RF-176 | ⚠️     | POST /auth/login without X-Tenant-Slug → HTTP 401 "Tenant not found" (no null JWT issued; error code 401 not 400)    |
| RF-197 | ⛔     | DELETE /customers/:id → HTTP 500; cannot determine if cascade protection exists                                      |
| RF-228 | ⛔     | Concurrent session limit is client-side session storage; cannot verify via API curl                                  |

## Failures

### RF-014 — Order number duplicate race: MAX+1 with no unique constraint

Repro: 1) Two simultaneous POST /orders for same customer fired at 2026-04-30T03:39:31.055Z. 2) GET /orders?limit=50 shows two distinct records (28d3247b and 14b8ba63) sharing orderNumber ORD-1777431385832. · Expected: unique orderNumber per order. · Got: duplicate orderNumbers in production data. · Suspected cause: MAX+1 computed in application layer with no DB-level unique constraint. · Proposed fix: Unique index on (tenantId, orderNumber); use DB sequence or atomic counter.

### RF-017 — No stock check at order creation

Repro: 1) Product Almond Mix (f31568b9) confirmed stock=0 via GET /products. 2) POST /orders {"customerId":"ebc75f88","items":[{"productId":"f31568b9","qty":5}]} → HTTP 201, order.status=PENDING. · Expected: 422 Unprocessable Entity "Insufficient stock." · Got: HTTP 201 order created against zero-stock product. · Suspected cause: createOrder() does not query inventory before persisting. · Proposed fix: Stock check with pessimistic DB lock inside order creation transaction; return 422 if stock < qty.

### RF-081 — GET /returns/:id exposes customer returns to DRIVER role (IDOR)

Repro: 1) Return bb19da5d belongs to customer 0ebb607c. 2) ux_driver_a token: GET /returns/bb19da5d → HTTP 200 with full return JSON (orderId, customerId, reason, status, items). · Expected: HTTP 403 Forbidden for DRIVER role. · Got: HTTP 200 with complete return data. · Suspected cause: No role guard on GET /returns/:id, or DRIVER role included in allowed roles. · Proposed fix: Add @Roles('OPERATOR','TENANT_ADMIN','CUSTOMER') on GET /returns/:id; add customer ownership check for CUSTOMER role.

### RF-176 — Wrong error code when X-Tenant-Slug missing (no null JWT issued)

Repro: POST /auth/login with no X-Tenant-Slug header → HTTP 401 "Tenant not found." · Expected (per spec): HTTP 400 "tenantCode is required." · Got: HTTP 401. No null-tenantId JWT is issued; isolation is intact. Impact is low — wrong status code only. · Proposed fix: Return HTTP 400 with message "X-Tenant-Slug header is required" from the tenant middleware.

## Adjacent bugs noticed

- NEW-v1-1 [P0] GET /customers and GET/DELETE /customers/:id return 500 for all authenticated users — entire customers module is broken in ux-audit tenant, blocking RF-074/079/080/083/197 verification.
- NEW-v1-2 [P1] PATCH /users/:id rejects forcePasswordChange field (DTO validation error) — operators cannot programmatically set the force-password-change flag via API; RF-093 guard is therefore untestable and likely also unenforceable.
- NEW-v1-3 [P2] POST /products/:id/images multipart upload fails with SSL renegotiation reset from Railway CDN — product image uploads appear broken in production for this tenant (RF-076/157 blocked by same issue).
