# v2

| RF | Status | Evidence (≤ 30 words) |
|---|---|---|
| RF-167 | ✅ VERIFIED | GET /route-runs/my-runs returns HTTP 200 with 1 IN_PROGRESS run for ux_driver_a. |
| RF-180 | ❌ FAIL | GET /buyer/standing-orders returns HTTP 500 "Internal server error" for buyer with standing orders. |
| RF-200 | ✅ VERIFIED | GET /buyer/products response includes `inStock` and `stockStatus` fields on every product object. |
| RF-204 | ✅ VERIFIED | "Voided" tab sends ?status=VOID → HTTP 200; 3 voided invoices displayed. Network panel confirms correct param. |
| RF-217 | ✅ VERIFIED | GET /buyer/me returns HTTP 200 with businessName: "UX Delivered Deli" after buyer login. |
| RF-086 | ❌ FAIL | buyer-api-client.ts redirects to /buyer/login on 401; that route returns "Unmatched Route" 404. |
| RF-087 | ❌ FAIL | Navigating to /customer-login with active operator session redirects to /home (operator dashboard). |
| RF-088 | ⚠️ PARTIAL | Source: [id].tsx shows spinner when isLoading or !invoice with no error state. /buyer/login redirect broken so 401 leaves page stuck. GUI exercise blocked. |
| RF-089 | ⚠️ PARTIAL | Source: cart.tsx onError calls showToast. If token missing, mobile interceptor rejects with error → toast should appear. Cannot confirm in GUI. |
| RF-090 | ❌ FAIL | /settings/users returns "Unmatched Route — Page could not be found." Confirmed in GUI. |
| RF-094 | ❌ FAIL | Same as RF-180: GET /buyer/standing-orders → HTTP 500. |
| RF-008 | ⚠️ PARTIAL | Source: generateDailyOrders() (@Cron) calls this.prisma.forTenant() with no tenant ALS context set — API-only RF. |
| RF-010 | ✅ VERIFIED | POST /credit-notes with amount 500 against $5 invoice → HTTP 400 "Credit note amount (500) would exceed invoice total (5)." |
| RF-011 | ❌ FAIL | POST /invoices/{order-linked-id}/duplicate → HTTP 201 creates duplicate INV-2026-0028. Should be 400. |
| RF-012 | ❌ FAIL | PATCH /invoices/{id} with {discount:50} on $100 invoice → HTTP 200, total still "100". Not recalculated. |
| RF-084 | ✅ VERIFIED | POST /vendor-bills/{received-id}/receive → HTTP 409 "Bill already received". Idempotency guard works. |
| RF-085 | ✅ VERIFIED | Create bill → receive (stock 0→1) → void (stock 1→0). Stock reversal confirmed. |
| RF-172 | ❌ FAIL | POST /orders with customer having PENDING order → HTTP 201 returns same order ID (upsert not new). |
| RF-013 | ❌ FAIL | Source: buyerLogout() never calls cartStore.clear(). In-memory Zustand cart persists across logout. |
| RF-015 | ⚠️ PARTIAL | Source: routes.service.ts::createRun() has no sendToDriver, push, or WebSocket emit. API-only confirmation. |

## Failures

### RF-180/RF-094 — Buyer standing-orders returns 500
Repro: Login as ux_buyer2, call GET /buyer/standing-orders with valid buyer token.
Expected: HTTP 200 with buyer's active standing order templates.
Got: HTTP 500 "Internal server error".
Suspected cause: Standing orders service throws unhandled exception, likely a forTenant() scoping issue or missing join.
Proposed fix: Add try/catch to controller; investigate orderTemplate.findMany with buyer context.

### RF-086 — Buyer 401 redirects to broken /buyer/login
Repro: Let buyer JWT expire; buyer-api-client interceptor fires redirect.
Expected: Redirect to /customer-login.
Got: Redirect to /buyer/login → "Unmatched Route" 404.
Suspected cause: buyer-api-client.ts line 78 hardcodes /buyer/login which has no matching Expo router route.
Proposed fix: Change line 78 to window.location.href = "/customer-login".

### RF-087 — /customer-login inaccessible with operator session
Repro: Login as operator (sets accessToken). Navigate to /customer-login.
Expected: Customer login form renders (checks only buyerAccessToken).
Got: Redirected to /home (operator dashboard).
Suspected cause: Route guard on customer-login checks accessToken (operator token) instead of buyerAccessToken.
Proposed fix: In (auth)/customer-login route guard, check buyerAccessToken exclusively; ignore operator accessToken.

### RF-090 — Settings Users tab missing
Repro: Login as operator, navigate to /settings/users.
Expected: User management interface.
Got: "Unmatched Route — Page could not be found."
Suspected cause: /settings/users route not defined in Expo router file structure.
Proposed fix: Create settings/users route/screen with user CRUD functionality.

### RF-011 — Duplicate order-linked invoice allowed
Repro: POST /invoices/{id}/duplicate where invoice has orderId set.
Expected: HTTP 400 "Order-linked invoices cannot be duplicated."
Got: HTTP 201, new duplicate INV-2026-0028 created.
Suspected cause: duplicate() method doesn't check orderId before duplicating.
Proposed fix: In invoices.service.ts::duplicate(), throw BadRequestException if invoice.orderId is not null.

### RF-012 — Invoice discount/shippingFee update doesn't recalculate total
Repro: PATCH /invoices/{id} with {discount:50} on $100 invoice (no items in payload).
Expected: total becomes $50.
Got: HTTP 200, discount:50 saved but total remains "100".
Suspected cause: update() only recalculates total when items is in the payload.
Proposed fix: In invoices.service.ts::update(), trigger recalculation whenever discount or shippingFee changes.

### RF-172 — POST /orders upserts existing PENDING order
Repro: Customer ebc75f88 has PENDING order cfdaae24. POST /orders with same customerId.
Expected: New order created with new ID.
Got: HTTP 201 returns same order ID cfdaae24 (upsert).
Suspected cause: orders.service.ts::create() finds and updates existing PENDING order.
Proposed fix: Remove upsert logic in create(). Always insert a new order record.

### RF-013 — Cart not cleared on buyer logout
Repro: Login as buyer, add items to cart, sign out via More > Sign out.
Expected: Cart cleared on logout.
Got: buyerLogout() only clears auth tokens; cartStore items persist in Zustand memory.
Suspected cause: signOut() in buyer-session-store.ts doesn't call useCartStore().clear().
Proposed fix: In buyer-session-store.ts::signOut(), call useCartStore.getState().clear() after buyerLogout().

## Adjacent bugs noticed
- NEW-v2-1 [P2] Vendor bill receive adds only 1 unit regardless of quantity — created bill with quantity:10, receive increased stock by 1 not 10.
- NEW-v2-2 [P1] /buyer/login route completely missing from Expo router — buyer-api-client.ts 401 redirect always lands on "Unmatched Route".
- NEW-v2-3 [P2] accessToken (operator) and buyerAccessToken (buyer) coexist in same localStorage — RF-077 session stomping risk persists on web.
