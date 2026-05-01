# W8 — Real-Time Update Mechanisms Audit

**Audited:** 2026-04-29
**Scope:** WebSocket gateway, SSE, EventEmitter, polling intervals, push notifications, cross-role event chains
**Status:** Read-only audit — no files modified

## Summary

The API has a **fully implemented Socket.io gateway** (`apps/api/src/gateways/routeflow.gateway.ts`) backed by a Redis pub/sub adapter for horizontal scaling. The web dashboard connects via `socket.io-client` and invalidates React Query caches on every relevant server event — no polling needed for the web. The mobile app does **not** connect to the WebSocket gateway at all; it relies entirely on polling + FCM push notifications. Seven findings were identified including one critical defect: push tokens are the wrong format — **100% of push notifications silently fail**.

---

## Findings

### W8-001 — Operator dispatch (createRun) emits no WebSocket event and no push to the driver
- **Severity:** P1
- **Issue:** When an operator dispatches a route run (`POST /route-runs`), `routes.service.ts::createRun()` creates the run and links orders but never calls any `gateway.emit*()` method and never calls `notifications.sendToDriver()`. The driver's mobile app has no real-time path to learn about a newly dispatched run.
- **Evidence:** `apps/api/src/routes/routes.service.ts` lines 490–606 — `createRun()` completes with zero gateway or notification calls. `apps/api/src/gateways/routeflow.gateway.ts` line 142 — a `driver:${userId}` room exists but no service ever emits into it. `apps/api/src/notifications/notifications.service.ts` line 167 — `sendToDriver()` method exists but is never called from `routes.service.ts`.
- **Impact:** Driver does not receive real-time notification when dispatched. They only learn about it when `useScheduledRouteRuns` re-fetches (staleTime 60s, no `refetchInterval` — effectively only on focus or manual refresh). A driver could miss a same-day dispatch entirely.
- **Fix:** Add `gateway.emitRouteDispatched(tenantId, { runId, driverId, routeName })` emitting to `tenant:X:driver:${userId}`. Call from `createRun()` after the transaction, alongside `notifications.sendToDriver(driverId, "New route assigned", ...)`.

---

### W8-002 — Mobile buyer orders list has no `refetchInterval` — relies on staleTime only
- **Severity:** P2
- **Issue:** `useBuyerOrders()` (`apps/mobile/lib/api/buyer.ts` lines 142–150) sets `staleTime: 30_000` but has no `refetchInterval`. In React Native there is no "window focus" event — the query stays stale until the user navigates away and back. The customer orders screen uses pull-to-refresh only.
- **Evidence:** `apps/mobile/lib/api/buyer.ts` lines 142–150 — no `refetchInterval`. `apps/mobile/app/(customer)/(tabs)/orders.tsx` lines 53–56 — no auto-refetch argument.
- **Impact:** After operator confirms an order, the customer's mobile orders list shows "Pending" indefinitely until manual pull-to-refresh.
- **Fix:** Add `refetchInterval: 30_000, refetchIntervalInBackground: false` to `useBuyerOrders()`. Add `useFocusEffect` in the orders screen to call `refetch()` on screen focus.

---

### W8-003 — Driver route home has no `refetchInterval` on `useActiveRouteRun` / `useScheduledRouteRuns`
- **Severity:** P2
- **Issue:** `useActiveRouteRun()` (`apps/mobile/lib/api/routes.ts` lines 91–100) uses `staleTime: 30_000`, no `refetchInterval`. `useScheduledRouteRuns()` (lines 102–110) uses `staleTime: 60_000`, no `refetchInterval`. By contrast, the operator's `useLiveRoutes()` correctly uses `refetchInterval: 15_000` (line 394).
- **Evidence:** `apps/mobile/lib/api/routes.ts` lines 91–110. `apps/mobile/app/(driver)/route/index.tsx` lines 66–68 — no supplemental polling.
- **Impact:** After dispatch, driver's route home doesn't auto-update. Combined with W8-001 (no push on dispatch), driver can sit on "No route assigned" until manual refresh.
- **Fix:** Add `refetchInterval: 30_000, refetchIntervalInBackground: false` to both hooks.

---

### W8-004 — Push tokens are Expo proxy tokens but server sends via Firebase FCM directly — 100% push delivery failure
- **Severity:** P1
- **Issue:** Mobile app calls `Notifications.getExpoPushTokenAsync()` which returns an `ExponentPushToken[...]` string — an Expo-managed proxy that must be sent to Expo's push service. The server (`notifications.service.ts`) feeds these tokens directly into `firebase-admin`'s `sendEachForMulticast()` which requires raw FCM registration tokens. FCM rejects every Expo token with `messaging/invalid-registration-token`. The server's cleanup code (lines 89–96) then deletes the token on first failure.
- **Evidence:** `apps/mobile/lib/auth.ts` line 86 — `Notifications.getExpoPushTokenAsync()`. `apps/api/src/notifications/notifications.service.ts` lines 78–84 — `admin.messaging().sendEachForMulticast({ tokens: [...] })`. Lines 89–96 — token cleanup on `invalid-registration-token`.
- **Impact:** All push notifications (order confirmed, out for delivery, delivered, partial delivery) are silently dropped for **all** mobile users. Zero push ever delivered.
- **Fix Option A:** Switch mobile to `Notifications.getDevicePushTokenAsync()` (requires `google-services.json`/`GoogleService-Info.plist` per platform).
- **Fix Option B (recommended):** Replace `firebase-admin` multicast on the server with `expo-server-sdk` (`expo.sendPushNotificationsAsync()`). No Firebase Admin credentials needed; Expo manages the FCM/APNs routing.

---

### W8-005 — Push notification errors silently swallowed with `.catch(() => {})`
- **Severity:** P2
- **Issue:** In `orders.service.ts`, all three `notifications.sendToCustomer()` calls use `.catch(() => {})` — discarding all errors with no logging.
- **Evidence:** `apps/api/src/orders/orders.service.ts` lines 775, 1372, 1381.
- **Impact:** Combined with W8-004, there is zero observability into a system that currently delivers no push notifications. No one will know it is broken.
- **Fix:** Replace with `.catch((err) => this.logger.warn('Push notification failed', err?.message ?? String(err)))`.

---

### W8-006 — `routes.service.ts::completeStop()` marks orders DELIVERED but emits no WebSocket event and no push
- **Severity:** P2
- **Issue:** The operator-facing stop completion path (`routes.service.ts::completeStop()`, lines 958–1036) marks orders DELIVERED in a transaction but emits nothing to the gateway and calls no push notification. The driver-facing path (`orders.service.ts::completeStop()`) correctly emits `emitStopCompleted` and calls `notifications.sendToCustomer()`.
- **Evidence:** `apps/api/src/routes/routes.service.ts` lines 958–1037 — no gateway or notification calls. `apps/api/src/orders/orders.service.ts` lines 1348–1384 — correct emit+notify block present.
- **Impact:** When an operator completes a stop from the web UI, the customer gets no WebSocket event and no push. Their mobile app only updates at next poll.
- **Fix:** Replicate the emit+notify block from `orders.service.ts::completeStop()` into `routes.service.ts::completeStop()`, or extract a shared helper.

---

### W8-007 — Redis adapter async connect race — silent in-memory fallback on cold start
- **Severity:** P3
- **Issue:** `redis-io.adapter.ts` connects Redis pub/sub clients via async `Promise.all()` inside the constructor. NestJS calls `createIOServer()` synchronously before the promise resolves. On cold start, `this.adapterConstructor` is `null` and the server silently falls back to in-memory Socket.io, breaking WebSocket event distribution across multiple instances.
- **Evidence:** `apps/api/src/gateways/redis-io.adapter.ts` lines 25–35 (async constructor), lines 39–44 (synchronous `createIOServer` checks `adapterConstructor`).
- **Impact:** In multi-instance Railway deployment, WebSocket events may drop across instances during cold start. Silent — no error is surfaced.
- **Fix:** Move Redis connection to `onModuleInit()` and await it before the server starts accepting connections. Add a startup INFO log confirming adapter mode (Redis vs in-memory).

---

## Cross-Role Event Chain Trace

| Action | WS emit | Push to customer | Push to driver |
|--------|---------|-----------------|----------------|
| Customer places order | `emitOrderCreated` + `emitUrgentOrder` to operators | None | None |
| Operator confirms order | `emitOrderStatusChanged` to operators + customer room | Code correct; delivery broken (W8-004) | None |
| Driver marks stop DELIVERED (driver path) | `emitStopCompleted` to operators | Code correct; delivery broken (W8-004) | None |
| Operator marks stop complete (web dashboard) | **None — W8-006** | **None — W8-006** | None |
| Operator dispatches route | **None — W8-001** | None | **None — W8-001** |
| Driver starts/completes run | `emitDriverStatusUpdated` to operators | None | None |

---

## Verified-OK Items

- **Q1 — WebSocket gateway:** Full Socket.io gateway with JWT auth, per-tenant rooms, and typed emitters. Redis pub/sub adapter for scaling. OK (caveat W8-007).
- **Q2 — Web dashboard polling:** Uses `useRealtimeUpdates()` hook (socket.io) in dashboard layout — invalidates React Query on all key events. No polling needed. OK.
- **Q5 — Driver stop → order status update:** `orders.service.ts::completeStop()` updates order status atomically in the same Prisma transaction. OK.
- **Q6 — Operator confirm → buyer notification:** `changeStatus()` calls `gateway.emitOrderStatusChanged()` and `notifications.sendToCustomer()`. Code path correct; push delivery broken by W8-004. Partial OK.
- **Q8 — Push tokens per-device:** `DeviceToken.upsert({ where: { token } })` — one row per physical device, multiple devices per user. OK.
- **Q10 — Sub-5s real-time path:** `driver.location.update` → `driver.location.updated` is a pure WebSocket relay with no DB round-trip. `order.created`, `order.statusChanged`, `route.stop.completed` all emit immediately post-write. OK.
