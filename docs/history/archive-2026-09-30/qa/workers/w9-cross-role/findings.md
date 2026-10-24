# W9 — Cross-Role Real-Time Interaction QA Findings

**Agent:** W9
**Date:** 2026-04-29
**App URL:** https://routeflowmobile-production.up.railway.app
**Tenant:** `ux-audit-1777265477001`
**Roles tested:** Operator (`ux_admin`), Driver (`ux_driver_a`), Buyer (`ux_buyer2`)

---

## Summary

| ID     | Title                                                                               | Severity |
| ------ | ----------------------------------------------------------------------------------- | -------- |
| W9-001 | Frontend never receives real-time events — Socket.IO gateway exists but no client   | P0       |
| W9-002 | RouteRun created via API gets `tenantId: null` — driver cannot see assigned run     | P0       |
| W9-003 | Concurrent orders allow oversell — no stock reservation at order creation           | P1       |
| W9-004 | UI updates require SPA navigation — no polling, no push                             | P1       |
| W9-005 | Stop completion does not update linked order status                                 | P2       |
| W9-006 | `PATCH /route-runs/:id` with User ID as `driverId` returns opaque 500               | P2       |
| W9-007 | Buyer order placed, operator home count stale until navigation                      | P2       |
| W9-008 | Cross-role session isolation relies on separate localStorage keys (works correctly) | INFO     |

---

## Findings

### W9-001 — Socket.IO backend gateway has no frontend client connected

- **Severity:** P0
- **Scenario:** Scenario 6 — Real-time mechanism detection
- **Action:** Installed a fetch interceptor on the operator `/home` page and monitored all network activity for 60 seconds. Inspected the frontend JS bundle for `socket.io`, `io(`, `EventSource`, and `setInterval` patterns.
- **Observer:** Operator tab (network monitor)
- **Expected:** Frontend establishes a WebSocket or SSE connection to receive server-pushed events (`order.created`, `order.statusChanged`, `route.stop.completed`, etc.).
- **Actual:** Zero background network calls detected in 60 seconds. No `socket.io` client is loaded anywhere in the frontend. The app is a pure REST-on-navigate SPA. All data is fetched only when the user navigates to a screen.
- **Evidence:**
  - Backend `apps/api/src/gateways/routeflow.gateway.ts` implements a full Socket.IO gateway with rooms `tenant:{id}:operators`, `tenant:{id}:driver:{userId}`, `tenant:{id}:customer:{userId}`.
  - Gateway emitters are wired into `orders.service.ts` at lines 648, 659, 730, 1028, 1357 — the backend broadcasts events correctly.
  - Fetch interceptor log over 60 seconds: 7 calls total, all test-initiated (zero app-initiated).
  - No `socket.io.js` script tag, no `io(` call, no `EventSource` instantiation found in the frontend.
- **Fix:** Add a `socket.io-client` connection in the web/mobile frontend (e.g., in a `useSocket` hook or a global app provider). Subscribe to the tenant room on login and dispatch events into local state (React Query `queryClient.invalidateQueries` or Zustand store). The backend gateway is production-ready; only the client-side wiring is missing.

---

### W9-002 — New RouteRun created via API has `tenantId: null`; driver cannot see it

- **Severity:** P0
- **Scenario:** Scenario 4 — Operator assigns driver to new run; driver checks their schedule
- **Action:** Operator called `POST /route-runs` with `{routeId, scheduledDate, driverId}`. Verified the resulting run by fetching it with the operator token and comparing tenantId fields.
- **Observer:** Driver (`ux_driver_a`) calling `GET /route-runs/my-runs`
- **Expected:** Driver sees the newly assigned run in their schedule.
- **Actual:** Driver receives an empty list. The new run has `tenantId: null`. Prisma `forTenant()` filter uses `WHERE tenantId = '{tenantId}'`, which excludes null-tenantId rows.
- **Evidence:**
  - Old seeded run `140784f6`: `tenantId: "8ee7bbf5-..."` — visible to driver.
  - New run `f1beec5b`: `tenantId: null` — invisible to driver.
  - Root cause in `apps/api/src/routes/routes.service.ts` `createRun()`: `tx.routeRun.create({ data: { routeId, driverId, scheduledDate, stops: { create: route.stops.map(...) } } })` — stops receive `tenantId` but the RouteRun record itself does not.
  - `apps/api/prisma/schema.prisma`: `RouteRun.tenantId String?` is nullable, so Prisma accepts null without error.
- **Fix:** In `routes.service.ts` `createRun()`, add `tenantId: this.prisma.getTenantId()` to the `data` object passed to `tx.routeRun.create()`. Also backfill existing null-tenantId RouteRun rows with a migration.

---

### W9-003 — Concurrent orders allow oversell — no stock reservation at order creation

- **Severity:** P1
- **Scenario:** Scenario 5 — Two buyers order the same last-in-stock item simultaneously
- **Action:** Set product stock to 1 unit via inventory adjustment. Then used `Promise.all` to fire two simultaneous `POST /buyer/orders` requests from two different buyer sessions, each ordering 1 unit of the same product.
- **Observer:** Operator checking inventory after both orders confirmed
- **Expected:** One order succeeds with HTTP 201; the second fails with HTTP 409 or 400 (out of stock).
- **Actual:** Both orders returned HTTP 201 Created. Stock level unchanged. Effective stock went negative.
- **Evidence:**
  - Both responses: HTTP 201, both `orderId` values distinct and valid.
  - `GET /inventory?productId=...` after both orders: stock still at 1 (orders do not reserve or decrement stock at creation time).
  - No `stockLevel` check in the buyer order creation path.
- **Fix:** Add a stock check with a database-level lock inside the order creation transaction. Either (a) reject orders when `availableStock < requestedQty`, or (b) implement a soft-reservation model that decrements a `reservedStock` counter atomically and releases on cancellation/expiry.

---

### W9-004 — UI updates require SPA navigation — no polling or push

- **Severity:** P1
- **Scenario:** Scenarios 1, 2, 3 — Any cross-role action that should update another role view
- **Action:** After each cross-role API action (order created, stop completed, status changed), waited 60+ seconds on the observer page without navigating.
- **Observer:** Operator on `/home`, Driver on route screen, Buyer on orders screen
- **Expected:** Observer UI refreshes within a reasonable time window (30 seconds) without user interaction.
- **Actual:** Pages never auto-refresh. Data updates appear only when the user navigates away and back.
- **Evidence:**
  - Scenario 1: Order status changed via API — operator home showed old count for 60s; correct count appeared after tab navigation.
  - Scenario 3: Buyer placed new order — operator `/home` pending count stayed at 3 for 60s; showed 4 after navigation.
  - Fetch interceptor: zero background fetches in 60s monitoring window.
- **Fix:** (a) Implement WebSocket event handling (see W9-001) to invalidate React Query caches on push events. (b) As a short-term mitigation, add `refetchInterval: 30000` on critical queries (order counts, route run status) while WebSocket client work is in progress.

---

### W9-005 — Driver completing a route stop does not update the linked order status

- **Severity:** P2
- **Scenario:** Scenario 2 — Driver completes stop; buyer/operator expect order status to advance
- **Action:** Driver called `PATCH /route-runs/:runId/stops/:stopId` with `{ status: "COMPLETED", podNote: "Delivered" }` for stop `d7523aeb` on run `140784f6`.
- **Observer:** Buyer checking order `14b8ba63`; Operator checking order list
- **Expected:** Order `14b8ba63` advances from `OUT_FOR_DELIVERY` to `DELIVERED` when its stop is marked completed.
- **Actual:** Order status remained `OUT_FOR_DELIVERY` after stop completion.
- **Evidence:**
  - `GET /orders/14b8ba63` before stop completion: `status: "OUT_FOR_DELIVERY"`.
  - `PATCH /route-runs/140784f6/stops/d7523aeb`: HTTP 200.
  - `GET /orders/14b8ba63` after: `status: "OUT_FOR_DELIVERY"` (unchanged).
  - Stop record inspection: `orderId` field is `null` on stop `d7523aeb`. The service stop-completion logic cannot look up the linked order without `orderId`.
- **Fix:** (a) Ensure `RouteRunStop.orderId` is populated when stops are created from route stops that have associated orders. (b) In the stop-completion handler in `routes.service.ts`, add logic: if `stop.orderId` is set and all stops for that order customer are completed, advance the order to `DELIVERED`. The backend Socket.IO gateway already has a `route.stop.completed` event — also emit `order.statusChanged` when applicable.

---

### W9-006 — `PATCH /route-runs/:id` with User ID as `driverId` returns opaque HTTP 500

- **Severity:** P2
- **Scenario:** Scenario 4 — Operator reassigns driver to a route run
- **Action:** Called `PATCH /route-runs/:runId` with `{ driverId: "<userId>" }` where the value was `User.id` (from the JWT `sub` field) instead of `Driver.id` (separate record in the Driver table).
- **Observer:** Operator; API response
- **Expected:** API returns HTTP 400 with a message like "driverId must be a valid Driver record ID".
- **Actual:** API returns HTTP 500 with no useful error body. The Prisma foreign-key constraint violation is not caught and translated into a client-friendly error.
- **Evidence:**
  - `PATCH /route-runs/{runId}` with User ID: HTTP 500, body: `{}`.
  - Correct call using Driver table ID (`d79a6f4a`): HTTP 200 OK.
  - The two IDs (`User.id` and `Driver.id`) are entirely different UUIDs — nothing in the API or docs indicates which ID type to use.
- **Fix:** (a) In `routes.service.ts` `updateRun()`, catch `PrismaClientKnownRequestError` with code `P2003` (foreign key constraint) and return `400 Bad Request` with a descriptive message. (b) Consider accepting `userId` as an alternative input and resolving it to `Driver.id` server-side.

---

### W9-007 — Buyer order creation, operator pending count stale until navigation

- **Severity:** P2
- **Scenario:** Scenario 3 — Buyer places order; operator monitors dashboard
- **Action:** Buyer `ux_buyer2` placed a new order via `POST /buyer/orders`. Operator was on `/home` screen.
- **Observer:** Operator on `/home` dashboard
- **Expected:** Operator pending-orders count increments within seconds.
- **Actual:** Count stayed at 3 for the full 60-second observation window. Count showed 4 only after navigating away and back.
- **Evidence:**
  - API immediately consistent: `GET /orders?status=PENDING` returned 4 items within 137ms of order creation.
  - UI showed 3 for 60+ seconds.
  - This is a UI manifestation of W9-001 (no WebSocket client) and W9-004 (no polling).
- **Fix:** Same as W9-001 and W9-004. Specifically for the dashboard: add `refetchInterval: 15000` to the pending-orders query as an immediate mitigation.

---

### W9-008 — Cross-role session isolation via separate localStorage keys (working correctly)

- **Severity:** INFO
- **Scenario:** Session setup — all 3 roles active simultaneously in same browser
- **Action:** Logged in as Operator, Driver, and Buyer across tabs in the same browser.
- **Observer:** All roles
- **Expected:** Separate localStorage keys allow coexistence without session conflicts.
- **Actual:** Operator and Driver both use `accessToken` key and overwrite each other if logged in sequentially in the same tab. Buyer uses `buyerAccessToken` (separate key) and coexists correctly with operator/driver.
- **Evidence:**
  - Operator login: `localStorage.accessToken = <operator-JWT>`.
  - Driver login in same tab: overwrites `localStorage.accessToken = <driver-JWT>`, logging out the operator.
  - Buyer login: `localStorage.buyerAccessToken = <buyer-JWT>` — no conflict with operator/driver.
- **Note:** By design for mobile (single-role per device). For web testing, operator and driver roles require separate browser tabs or profiles. Document this limitation clearly in testing guides.

---

## Root Cause Summary

Three independent architectural gaps account for most findings:

1. **Missing WebSocket client** (W9-001, W9-004, W9-007): The backend Socket.IO gateway is fully implemented with event emissions in `orders.service.ts`. The frontend has never been connected. All real-time UX gaps trace back to this single missing integration.

2. **Missing `tenantId` in `RouteRun.create()`** (W9-002): A one-line omission in `routes.service.ts` causes all new route runs to be invisible to tenant-scoped queries, breaking driver assignment entirely.

3. **No transactional stock reservation** (W9-003): Order creation does not check or decrement available stock atomically, allowing concurrent orders to exceed inventory.

---

## Recommended Fix Priority

| Priority | Finding                                                                | Estimated effort                              |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| P0       | W9-002 — Add `tenantId` to `RouteRun.create()`                         | 15 min (one-liner + backfill migration)       |
| P0       | W9-001 — Wire socket.io-client in frontend                             | 1-2 days (hook + query invalidation)          |
| P1       | W9-003 — Add stock reservation on order create                         | 0.5-1 day (Prisma transaction + lock)         |
| P1       | W9-004 — Add polling fallback while WS pending                         | 2 hours (refetchInterval on critical queries) |
| P2       | W9-005 — Populate orderId on RunStop; advance order on stop completion | 0.5 day                                       |
| P2       | W9-006 — Translate FK constraint error to 400                          | 1 hour                                        |
| P2       | W9-007 — Dashboard stale count                                         | Resolved by W9-001/W9-004                     |
