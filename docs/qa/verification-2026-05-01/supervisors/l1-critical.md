# L1-Critical Supervisor Report — 2026-05-01

## Coverage

| Worker | Pass | Fail | Partial | Blocked |
|--------|------|------|---------|---------|
| v1 (GUI+API) | 8 | 4 | 0 | 8 |
| v2 | 6 | 8 | 4 | 0 |
| v3 | 1 | 7 | 5 | 0 |
| r-web | 3 | 3 | 2 | 0 |
| r-mobile | 3 | 1 | 4 | 4 (API supp: all blocked) |

---

## RF Status Table (P0 + P1)

| RF | Sev | Verdict | Now | Worker | Notes |
|----|-----|---------|-----|--------|-------|
| RF-001 | P0 | Claimed fixed | VERIFIED | v1, v1-supp | tenantId non-null; dispatched runs visible to driver |
| RF-002 | P0 | Claimed fixed | FAIL | v3 | window.io undefined; zero wss:// entries after 30 s; Socket.IO never connects |
| RF-003 | P0 | Claimed fixed | VERIFIED | v1 | SCHEDULED run → 403 on stop-complete; guard confirmed |
| RF-073 | P0 | Claimed fixed | VERIFIED | v1, v1-supp | PATCH role field silently ignored; role unchanged in response |
| RF-074 | P0 | Claimed fixed | BLOCKED | v1 | /customers/* returns 500 for all operations; cascade guard untestable |
| RF-075 | P0 | Claimed fixed | VERIFIED | v1, v1-supp | Unauthenticated fetch → 401; auth guard confirmed |
| RF-076 | P0 | Claimed fixed | FAIL | v1 | Pre-existing SVG with embedded script served inline HTTP 200; no Content-Disposition |
| RF-077 | P0 | Claimed fixed | VERIFIED | v1 | Separate localStorage keys confirmed; no stomping on API key layer |
| RF-147 | P0 | Claimed fixed | VERIFIED | v1, v1-supp | Invoice from order carries correct tenantId |
| RF-157 | P0 | Claimed fixed | FAIL | v1 | Same SVG payload accepted and served inline; XSS confirmed (API supp: upload connectivity issue blocked direct test) |
| RF-176 | P0 | Claimed fixed | VERIFIED | v1, v1-supp | No null-tenantId JWT issued; 401 returned (minor: wrong code, should be 400) |
| RF-197 | P0 | Claimed fixed | BLOCKED | v1 | DELETE /customers/:id → 500; cascade behavior untestable |
| RF-203 | P0 | Claimed fixed | FAIL | v3 | /routes/create spinner 15 s → redirect /home; form never renders |
| RF-004 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-005 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-006 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-007 | P1 | Claimed fixed | PARTIAL | v3 | Load time improved (5–7 s vs 20–40 s); no skeleton shown; blank white remains |
| RF-008 | P1 | Claimed fixed | PARTIAL | v2 | Cron handler calls forTenant() with no ALS context; source-confirmed regression; no runtime test possible |
| RF-009 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-010 | P1 | Claimed fixed | VERIFIED | v2 | Credit note over-invoiceTotal → 400; guard works |
| RF-011 | P1 | Claimed fixed | FAIL | v2 | POST /invoices/:id/duplicate → 201 for order-linked invoice; double-billing live |
| RF-012 | P1 | Claimed fixed | FAIL | v2 | PATCH discount → 200 but total unchanged; recalc not triggered |
| RF-013 | P1 | Claimed fixed | FAIL | v2 | buyerLogout() never calls cartStore.clear(); source confirmed |
| RF-014 | P1 | Claimed fixed | FAIL | v1, v1-supp | Duplicate orderNumber ORD-1777431385832 confirmed in live data |
| RF-015 | P1 | Claimed fixed | PARTIAL | v2 | Source confirms no sendToDriver/WebSocket emit in createRun(); API-only check |
| RF-016 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-017 | P1 | Claimed fixed | FAIL | v1, v1-supp | POST /orders with stock=0 product → 201; no stock check |
| RF-018 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-019 | P1 | Not tested | NOT COVERED | — | No worker assigned; still open |
| RF-078 | P1 | Not tested | NOT COVERED | — | Related to RF-076/157; SVG inline serving confirms gap |
| RF-079 | P1 | Claimed fixed | BLOCKED | v1 | /customers/:id → 500; isTaxExempt untestable |
| RF-080 | P1 | Claimed fixed | BLOCKED | v1 | DELETE /customers/bulk → 500; untestable |
| RF-081 | P1 | Claimed fixed | FAIL | v1-supp | DRIVER token GET /returns/:id → 200 with full return data; IDOR confirmed |
| RF-082 | P1 | Claimed fixed | VERIFIED | v1-supp | DRIVER POST /returns/:id/cancel → 403; ownership check works |
| RF-083 | P1 | Claimed fixed | BLOCKED | v1 | /customers/:id → 500 for all roles; PII filtering untestable |
| RF-084 | P1 | Claimed fixed | VERIFIED | v2 | Duplicate receive → 409; idempotency guard works |
| RF-085 | P1 | Claimed fixed | VERIFIED | v2 | void after receive → stock reversal confirmed |
| RF-086 | P1 | Claimed fixed | FAIL | v2 | buyer-api-client.ts redirects to /buyer/login → "Unmatched Route" 404 |
| RF-087 | P1 | Claimed fixed | FAIL | v2 | /customer-login redirects to /home when operator accessToken present |
| RF-088 | P1 | Claimed fixed | PARTIAL | v2 | Spinner on isLoading/!invoice confirmed in source; GUI blocked by RF-086 |
| RF-089 | P1 | Claimed fixed | PARTIAL | v2 | Toast on error confirmed in source; GUI confirmation blocked |
| RF-090 | P1 | Claimed fixed | FAIL | v2, v3 | /settings/users → "Unmatched Route"; confirmed by two workers |
| RF-093 | P1 | Claimed fixed | VERIFIED | v1 | forcePasswordChange:true → 403 on protected routes; guard confirmed via GUI |
| RF-094 | P1 | Claimed fixed | FAIL | v2 | GET /buyer/standing-orders → 500 |
| RF-160 | P1 | Claimed fixed | VERIFIED | v1, v3 | 429 after ~5 rapid attempts; throttler active |
| RF-167 | P1 | Claimed fixed | VERIFIED | v2 | GET /route-runs/my-runs → 200 with IN_PROGRESS run |
| RF-172 | P1 | Claimed fixed | FAIL | v2, v1 | POST /orders returns same order ID for customer with PENDING order; upsert not removed |
| RF-180 | P1 | Claimed fixed | FAIL | v2 | GET /buyer/standing-orders → 500 (also RF-094; same endpoint) |
| RF-200 | P1 | Claimed fixed | VERIFIED | v2 | buyer/products includes inStock + stockStatus fields |
| RF-204 | P1 | Claimed fixed | VERIFIED | v2 | Voided tab → ?status=VOID → 200 with results |
| RF-211 | P1 | Claimed fixed | PARTIAL | v3 | /drivers renders list (redirect fixed); /drivers/add → "Unmatched Route" |
| RF-212 | P1 | Claimed fixed | PARTIAL | v3 | /returns renders tabs (Unmatched Route fixed); API return not displayed |
| RF-213 | P1 | Claimed fixed | FAIL | v3 | Settings shows only 3 items; Users/Branding/Integrations absent |
| RF-215 | P1 | Claimed fixed | PARTIAL | v3 | Add to Cart local state works; GET/POST /buyer/cart → 404 |
| RF-216 | P1 | Claimed fixed | FAIL | v3 | /invoices redirects to /orders; deep-link broken |
| RF-217 | P1 | Claimed fixed | VERIFIED | v2 | GET /buyer/me → 200 with businessName |
| RF-218 | P1 | Claimed fixed | FAIL | v3 | Buyer login lands /orders; no home/dashboard |
| RF-220 | P1 | Claimed fixed | VERIFIED | v3 | Buyer2 Total Spend $95 (not $0) |
| RF-228 | P2 | Claimed fixed | BLOCKED | v1-supp | Frontend-only; cannot verify via API curl; session collision observed in QA infra |

---

## Re-open List (FAIL/PARTIAL P0/P1)

**RF-002 (P0) — Socket.IO never connects**
Repro: Login as operator; wait 30 s on /home; `window.io === undefined`; zero wss:// network entries.
Cause: Socket.IO client not imported/wired in Expo web bundle root layout.
Fix: Import and initialize socket client in root layout; connect on auth token available.

**RF-076 / RF-157 (P0) — Stored XSS via inline SVG serving**
Repro: Fetch `/uploads/products/<id>.svg` with valid auth → HTTP 200, `content-type: image/svg+xml`, embedded `<script>` in body.
Cause: Upload validation allows `image/svg+xml`; file server omits `Content-Disposition: attachment`.
Fix: Allowlist JPEG/PNG/WEBP on image upload endpoints; add `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on all file responses.

**RF-203 (P0) — Create forms never render**
Repro: Navigate to `/routes/create` → spinner 15 s → redirect /home.
Cause: Auth guard loop before form render; secondary-data fetch blocks entire component.
Fix: Render form immediately; load secondary data async with Suspense boundary.

**RF-011 (P1) — Order-linked invoice can be duplicated**
Repro: `POST /invoices/{order-linked-id}/duplicate` → HTTP 201; duplicate invoice created.
Cause: `duplicate()` in invoices.service.ts does not check `orderId` before duplicating.
Fix: Throw `BadRequestException` in `duplicate()` if `invoice.orderId !== null`.

**RF-012 (P1) — Invoice discount/shippingFee update skips total recalculation**
Repro: `PATCH /invoices/{id}` `{discount:50}` on $100 invoice → HTTP 200; total still $100.
Cause: `update()` triggers recalculation only when `items` in payload.
Fix: Trigger recalculation whenever `discount` or `shippingFee` change.

**RF-013 (P1) — Cart not cleared on buyer logout**
Repro: Add items as buyer; sign out; cart persists in Zustand.
Cause: `signOut()` in buyer-session-store.ts does not call `useCartStore.getState().clear()`.
Fix: Call `useCartStore.getState().clear()` inside `signOut()` after `buyerLogout()`.

**RF-014 (P1) — Duplicate order numbers in production**
Repro: `GET /orders?limit=100` → two distinct orders share `ORD-1777431385832`.
Cause: MAX+1 in application layer; no DB unique constraint.
Fix: Add unique index on `(tenantId, orderNumber)`; use DB sequence or `SELECT FOR UPDATE`.

**RF-017 (P1) — No stock check at order creation**
Repro: `POST /orders` for product with `currentStock=0` → HTTP 201.
Cause: `orders.service.ts create()` does not query stock before insert.
Fix: Validate `product.currentStock >= qty` per item inside a pessimistic-lock transaction; return 422 if insufficient.

**RF-081 (P1) — IDOR: DRIVER reads any customer's return**
Repro: DRIVER token `GET /returns/{other-customer-returnId}` → HTTP 200 with full return.
Cause: No role guard on `GET /returns/:id`; DRIVER role included in allowed roles.
Fix: Add `@Roles('OPERATOR','TENANT_ADMIN','CUSTOMER')` on `GET /returns/:id`; add ownership check for CUSTOMER role.

**RF-086 (P1) — Buyer 401 redirects to non-existent /buyer/login**
Repro: Let buyer JWT expire; interceptor fires redirect to `/buyer/login` → "Unmatched Route".
Cause: `buyer-api-client.ts` line ~78 hardcodes `/buyer/login`.
Fix: Change redirect target to `/customer-login`.

**RF-087 (P1) — /customer-login blocked when operator session active**
Repro: Login as operator; navigate to `/customer-login` → redirected to /home.
Cause: Route guard checks `accessToken` (operator) instead of `buyerAccessToken`.
Fix: On customer-login guard, check `buyerAccessToken` exclusively.

**RF-090 (P1) — Settings Users tab absent** (confirmed by v2 + v3)
Repro: `/settings/users` → "Unmatched Route".
Cause: Route not registered in Expo router.
Fix: Register route and build Users management screen.

**RF-094 / RF-180 (P1) — GET /buyer/standing-orders → 500**
Repro: Authenticated buyer `GET /buyer/standing-orders` → HTTP 500.
Cause: Standing orders service throws unhandled exception (likely forTenant() scoping issue).
Fix: Investigate `orderTemplate.findMany` with buyer ALS context; add try/catch at controller.

**RF-172 (P1) — POST /orders upserts existing PENDING order**
Repro: Customer with PENDING order → `POST /orders` → returns same order ID.
Cause: `orders.service.ts create()` contains upsert logic on PENDING orders.
Fix: Remove upsert; always insert a new order record.

**RF-213 (P1) — Settings missing Users/Branding/Integrations tabs**
Repro: Operator /settings → only Business Profile + Invoicing tax rate + Notifications toggle.
Cause: Tabs not built/registered.
Fix: Implement missing settings screens and register routes.

**RF-216 (P1) — Buyer /invoices deep-links to /orders**
Repro: Navigate to `/invoices` → redirected to /orders; URL shows /orders.
Cause: Buyer router missing `/invoices` deep-link entry; catch-all sends to /orders.
Fix: Register `/invoices` in buyer stack; fix bottom-nav push target.

**RF-218 (P1) — No buyer home/dashboard**
Repro: Buyer login → /orders; /home → /orders; no dashboard.
Cause: Buyer stack has no home route; catch-all defaults to /orders.
Fix: Add buyer dashboard screen at buyer root with balance/order summary.

**RF-188 (P1-adjacent, v3 FAIL) — Invoice detail /invoices/:id redirects to /home**
Repro: Operator navigates to `/invoices/<uuid>` → immediate redirect to /home.
Cause: Route not registered in operator stack.
Fix: Register `/invoices/:id` route.

**RF-007 (P1) — Tab load PARTIAL: no skeleton during blank interval**
Repro: Click Dispatch/Warehouse → 5–7 s blank white before render.
Cause: Heavy fetch blocks render; no Suspense boundary.
Fix: Add skeleton placeholders with immediate display.

**RF-008 (P1) — Cron jobs run without per-tenant ALS context (source-confirmed)**
Cause: `generateDailyOrders()` and recurring-invoice cron call `forTenant()` with no ALS context set.
Fix: Iterate all active tenants; set ALS context per tenant before each cron invocation.

**RF-015 (P1) — Dispatch emits nothing to driver (source-confirmed)**
Cause: `routes.service.ts::createRun()` has no `sendToDriver`, push, or WebSocket emit call.
Fix: Emit WebSocket event to driver's socket room on run creation; send push notification via Expo proxy.

---

## New Regressions (NEW-* IDs)

**NEW-rweb-2 [P0]** GET /api/v1/buyer/orders → 500; buyers cannot see any orders. Repro: Login as any buyer; navigate to Orders tab; infinite spinner; API returns 500.

**NEW-rweb-3 [P0]** GET /api/v1/buyer/invoices → 500; buyers cannot view invoices. Repro: Login as buyer; Invoices tab spins indefinitely; API returns 500.

**NEW-v1-2 / NEW-rweb-1 [P1]** Entire /customers/* API → 500 for all operations in ux-audit tenant. Blocks 6 RF verifications (RF-074/079/080/083/197 + operator new-order flow). Repro: Any authenticated GET/POST/PATCH/DELETE to /customers → 500.

**NEW-v1-1 [P1]** Frontend fires GET to wrong API host (routeflowapi-production-d504... not routeflowapi-production...); customers page 401 → empty state. Repro: Operator → Customers page; network shows 401 to wrong hostname.

**NEW-rmob-1 / r-mobile [P1]** "No refresh token" toast blocks all payment submission on web driver app. Repro: Driver → stop detail → enter cash payment → tap "Receive payment & close" → OPTIONS 204 only; POST never fires; localStorage empty.

**NEW-v2-1 [P2]** Vendor bill receive adds only 1 unit regardless of bill quantity. Repro: Create bill qty:10; receive → stock increases by 1 not 10.

**NEW-v3-2 [P2]** GET /buyer/orders → 500 (corroborates NEW-rweb-2).

**NEW-v3-3 [P2]** GET /buyer/invoices → 500 (corroborates NEW-rweb-3).

**NEW-rweb-7 [P2]** Active run shows scheduledDate 2026-04-30 (yesterday) despite being dispatched on 2026-05-01; possible timezone offset bug.

**NEW-v2-3 [P2]** operator accessToken and buyerAccessToken coexist in same localStorage origin; RF-077 stomping risk persists at browser level even with separate key names.

---

## Domain Verdict

- **auth/security**: HOLD — RF-076/157 XSS (P0) confirmed live; RF-081 IDOR unresolved; /customers 500 blocks RF-074/083/197 verification. Cannot ship until SVG upload is blocked/sanitized and IDOR patched.
- **dispatch / driver-pod**: HOLD — RF-002 Socket.IO dead (P0); NEW-rmob-1 blocks payment submission; RF-015 dispatch emits nothing to driver; RF-203 route create form broken.
- **real-time**: HOLD — RF-002 confirmed; zero WebSocket activity on any surface.
- **finance / money**: RE-FIX — RF-011 duplicate invoice (P1 live); RF-012 total not recalculated (P1); NEW-rweb-2/3 buyer orders+invoices → 500 (P0-equivalent UX); NEW-v2-1 vendor bill receive quantity wrong.
- **buyer portal**: HOLD — NEW-rweb-2/3 (orders+invoices 500); RF-086/087 redirect loops; RF-094/180 standing-orders 500; RF-215 cart 404; RF-216/218 routing broken; RF-013 cart not cleared.
- **operator UI**: RE-FIX — RF-090/213 settings missing; RF-203 create forms broken; RF-188 invoice detail redirects; RF-212 returns empty; /customers 500 blocks new-order flow.
