# W25 Driver Dispatch and Real-Time QA Findings

Worker: W25
Date: 2026-04-30
Tenant: ux-audit-1777265477001
API: https://routeflowapi-production.up.railway.app/api/v1
App: https://routeflowmobile-production.up.railway.app

---

## Operator Dashboard Observation - PASS

- Logged in as ux_admin (TENANT_ADMIN, tenantId: 8ee7bbf5-991b-41b1-adcb-4a6c20981401)
- Initial state: Dispatch Readiness 33%, Pending orders 6, Active drivers 3, Low stock 8, Overdue invoices 79
- Routes Today: UX Route B unassigned No driver / UX Route A assigned ux_driver_a Scheduled
- No console errors captured

---

## Test 13.3 - PARTIAL

GET /route-runs (operator) HTTP 200:
- Run 3dac51c0-eaad-4dd6-a134-0cef7341b638: SCHEDULED, driverId d79a6f4a, tenantId 8ee7bbf5 (SET), date 2026-04-30
- Run 140784f6-be36-430b-8391-452d0b7bf005: IN_PROGRESS, driverId d79a6f4a, tenantId 8ee7bbf5 (SET)

RF-001 tenantId check: Both runs have tenantId set. RF-001 NOT confirmed - tenantId is correctly populated.

GET /route-runs/my-runs (Driver A) -> HTTP 404 {"message":"Route run not found"}

### BUG-1 (P1): GET /route-runs/my-runs returns 404 for all drivers

Driver A (userId 4db3d83b, driverProfileId d79a6f4a) assigned to 2 runs.
Direct GET /route-runs/:id returns HTTP 200 correctly.
GET /route-runs/my-runs returns HTTP 404 for both Driver A and Driver B.
Reproducible regardless of run status or assignment state.

Browser: Driver logged in as ux_driver_a via localStorage token injection.
Route page /route shows: Today Route UX Route A assigned, 5 stops, On route status. PASS.

---

## Test 13.4 - PARTIAL

POST /route-runs/:id/start -> HTTP 404 (endpoint does not exist)
PATCH /route-runs/:id {status:IN_PROGRESS} -> HTTP 200 but status NOT updated (still returns SCHEDULED)
WORKING: PATCH /route-runs/:id/status {status:IN_PROGRESS} -> HTTP 200, startedAt set, status IN_PROGRESS

Operator GET /route-runs/:id after start: {status: IN_PROGRESS} PASS

Browser real-time check (30 second wait):
- Dashboard text identical before and after additional stop completions via API
- Route A progress stayed at 50% despite more stops being completed
- No WebSocket connections: window._wsConnections = [] (intercepted constructor)
- typeof io === undefined - socket.io-client NOT loaded in browser
- No API polling network requests in 30-second observation window

### BUG-2 (P1): Dashboard has no real-time update mechanism

Socket.IO server IS running: GET /socket.io/?EIO=4&transport=polling -> HTTP 200
Response: {"sid":"5uKqBCxvMxsR2y2WAAAI","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000}
Browser has WebSocket constructor but never creates connections. All values frozen at page load.

Fleet page /fleet: 2 live, 0 drivers sharing GPS.
UX Driver Alpha: UX Route A, 2/5 stops left, waiting on GPS.
UX Driver Beta: UX Route B, 0/1 stops left, waiting on GPS. Requires manual refresh.

---

## Test 13.5 - PARTIAL

GET /route-runs/:runId/stops -> HTTP 404 (no dedicated endpoint; stops embedded in run detail)

POST /route-runs/:runId/stops/:stopId/complete with {status:DELIVERED, podPhotoUrls:[], notes:"W25 13.5 test"}
-> HTTP 201 {id: 07c4bc82, status: COMPLETED, completedAt: 2026-04-30T15:...} WORKS

GET /orders/b3565cc1 (operator) after complete: {status: DELIVERED} PASS

Buyer API step 5 BLOCKED: ux_buyer2_1777265477001@ux-audit.test returns HTTP 401 Invalid credentials.
No CUSTOMER role users in this tenant (GET /users returns only 1 admin + 2 drivers).
No /buyer/orders, /portal/auth/login, or /auth/buyer/login endpoints found.

Browser: Operator /orders Delivered tab shows delivered orders correctly after page navigation. No live updates.

### BUG-3 (P2): PATCH /route-runs/:runId/stops/:stopId returns HTTP 500 Internal Server Error

PATCH /route-runs/{runId}/stops/{stopId} {status:DELIVERED} -> HTTP 500 {"statusCode":500,"message":"Internal server error"}
The POST .../complete endpoint works; the PATCH route crashes.

---

## Test 13.6 - BLOCKED

All attempted payment endpoints returned HTTP 404:
- POST /route-runs/:runId/stops/:stopId/payment
- POST /route-runs/:runId/stops/:stopId/collect-payment
- POST /payments
- POST /route-runs/:runId/stops/:stopId/cash
- POST /route-runs/:runId/cash-collection

Driver app UI shows Cash tab in bottom nav but no API endpoint was discoverable.

### BUG-4 (P2): No cash payment collection API endpoint exists for route run stops

---

## Test 13.11 - PARTIAL

POST /route-runs/:id/cancel -> HTTP 404 (does not exist)
PATCH /route-runs/:id/status {status:CANCELLED} -> HTTP 200 WORKS

Run 140784f6 cancelled. All 3 stops were COMPLETED before cancellation.

Order state after cancellation:
Stop 1 (COMPLETED): order b3565cc1 CONFIRMED -> CONFIRMED (NOT updated to DELIVERED)
Stop 1 (COMPLETED): order 514b08ee CONFIRMED -> CONFIRMED (NOT updated to DELIVERED)
Stop 2 (COMPLETED): order 2ef317f6 DELIVERED -> DELIVERED (preserved correctly)
Stop 2 (COMPLETED): order aa79cb93 DELIVERED -> DELIVERED (preserved correctly)
Stop 2 (COMPLETED): order 14b8ba63 OUT_FOR_DELIVERY -> OUT_FOR_DELIVERY
Stop 3 (COMPLETED): order 10cb57cc DELIVERED -> DELIVERED (preserved correctly)

DELIVERED orders remain DELIVERED - correct.
CONFIRMED orders on stop 1 were never transitioned to DELIVERED despite stop being COMPLETED.

### BUG-5 (P1): Stop completion does not consistently update CONFIRMED orders to DELIVERED

Pre-existing run (0 delivery mutations) did not update CONFIRMED orders.
Newly created run (delivery mutations present) correctly updated orders.
Root cause: older runs lack delivery mutation records driving order status transitions.

---

## Test 13.12 - PASS

Run 3dac51c0 IN_PROGRESS assigned to Driver A. Reassigned to Driver B:
PATCH /route-runs/3dac51c0 {driverId: b729bcc1-2d05-4b6e-812e-ef37a459edcf} -> HTTP 200 {driverId: b729bcc1} WORKS

After reassignment:
Driver A: GET /route-runs/:id -> HTTP 403 "You do not have access to this route run" PASS
Driver B: GET /route-runs/:id -> HTTP 200 {status: IN_PROGRESS} PASS
Both: GET /route-runs/my-runs -> HTTP 404 (BUG-1, unrelated to reassignment)

Access control on individual run endpoints is correct. Reassignment works properly.

---

## Test 13.15 - PASS (no corruption)

Setup: Run 9f5256c9 IN_PROGRESS, stop 07c4bc82 with CONFIRMED order b3565cc1.

Concurrent via Promise.all (elapsed 263ms):
Operator: PATCH /orders/b3565cc1/status {status:CONFIRMED} -> HTTP 400 "Cannot transition from CONFIRMED to CONFIRMED"
Driver A: POST /route-runs/9f5256c9/stops/07c4bc82/complete {status:DELIVERED} -> HTTP 201

Final: GET /orders/b3565cc1 -> {status: DELIVERED} PASS. No data corruption.

Note: No general PATCH /orders/:id endpoint exists. Only PATCH /orders/:id/status for status transitions.

---

## Phase 9.E - FAIL

Client-side check:
- typeof io -> "undefined" (socket.io-client NOT loaded)
- typeof WebSocket -> "function" (native, unused)
- window._wsConnections -> [] (no connections created even after intercepting constructor)
- EventSource: available but never used

Server-side check:
GET /socket.io/?EIO=4&transport=polling -> HTTP 200
Body: {"sid":"5uKqBCxvMxsR2y2WAAAI","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000}
Socket.IO server fully operational and accepting connections. Client never connects.

### BUG-6 (P0): Frontend does not connect to Socket.IO server - zero real-time updates

socket.io-client library is not bundled in the frontend JavaScript.
No SSE (EventSource) or long-polling alternative implemented.
All dashboard data frozen from initial page load.
Impacts: Dispatch Readiness %, Active drivers count, Route progress bars, Fleet map, Pending orders, order statuses.

---

## Bug Summary

BUG-1 P1 (13.3, 13.12): GET /route-runs/my-runs returns 404 for all drivers regardless of assignment state
BUG-2 P1 (13.4, 9.E): Dashboard has no real-time update mechanism - no polling, SSE, or socket
BUG-3 P2 (13.5): PATCH /route-runs/:runId/stops/:stopId returns HTTP 500 Internal Server Error
BUG-4 P2 (13.6): No cash payment collection endpoint exists for route run stops
BUG-5 P1 (13.11): Stop completion does not consistently update CONFIRMED orders to DELIVERED
BUG-6 P0 (9.E): socket.io-client not loaded - Socket.IO server running but client never connects

---

## Additional API Observations

POST /route-runs/:id/start -> 404 (use PATCH .../status instead)
POST /route-runs/:id/cancel -> 404 (use PATCH .../status instead)
GET /route-runs/:id/stops -> 404 (stops embedded in run detail response)
PATCH /orders/:id -> 404 (only PATCH /orders/:id/status for status transitions)
Auth tokens expire in approximately 15 minutes - repeated re-auth required during extended testing
Route name "UX Route B (unassigned)" is a static string baked into route name, not dynamic

---

## Test Data Created

Route Run created: 9f5256c9-03ea-4c17-b79c-e95bca6bc451 (UX Route A, IN_PROGRESS, ux_driver_a)
Route Run modified: 3dac51c0-eaad-4dd6-a134-0cef7341b638 (started IN_PROGRESS, then reassigned to Driver B)
Route Run cancelled: 140784f6-be36-430b-8391-452d0b7bf005 (CANCELLED via PATCH status)
Stop completed: a1d6fc77-d89a-4e0e-9525-c44fdb065ebf (in run 3dac51c0)
Stop completed: 07c4bc82-57db-4189-a068-1a28c4b1de31 (in run 9f5256c9, order b3565cc1 -> DELIVERED)
Stop completed: c3c60342-bc54-4185-9580-2763e70b23c8 (in run 9f5256c9, realtime test)
Order status changed: b3565cc1-5633-4841-8055-41cdc50e7ca0 (CONFIRMED -> DELIVERED)
