# Route Planning, Dispatch & Delivery Execution

_Turning the delivery day — who drives where, with what, and proof of what actually happened — into one system record instead of a whiteboard and a paper book._

> **Note:** This domain's analysis needed heavy correction after verification (several SHIPPED
> claims were downgraded, one nonexistent Prisma model was cited, and multiple capabilities were
> missed) — treat this document as reconciled but worth a second human pass.

## The problem

A wholesale distributor decides every morning who drives where, in what order, and with what on
the truck — usually on a whiteboard, a spreadsheet and a WhatsApp group. The driver leaves with a
stack of paper invoices, writes "2 cases short" and "shop closed" in the margin, and hands the
book back at 6pm; someone then re-keys all of it into the accounting package, guesses which
customer got what, and argues with the customer a week later about a delivery nobody can prove
happened. Meanwhile the office cannot answer "where is my order?" without phoning the driver, cash
collected at the door is reconciled from a pocketful of receipts, and orders that were missed on
Tuesday quietly fall off the schedule entirely. The sequence of stops is chosen by whoever knows
the roads, so a new or covering driver burns an extra two hours and a tank of fuel.

## Why it matters to a tenant

RouteFlow turns the delivery day into one record. The office builds a stop list from live open
orders, lets the optimizer sequence it against real road times, and pushes it to the driver's
phone the instant it is dispatched. The driver's completion writes the delivery, the photo, the
signature and the at-door payment in a single transaction, so the invoice, the order status, the
stock movement and the cash all move together instead of being re-keyed. The measurable wins are:
no re-keying of a paper delivery book, a defensible photo/signature record per stop, fewer wasted
miles from a machine-sequenced route, and stop-level on-time and stops-per-hour numbers per driver
that simply do not exist on paper. The unhappy truth is that several of those wins are currently
locked behind a `developer_mode` gate for the driver app, or only fully reconcile the invoice when
money is collected at the door — see the gaps below.

## Core use cases

1. **Plan the day's deliveries** — turn today's open, route-fulfilled orders into an ordered list
   of stops for one vehicle, with a start point, an end point and a sensible sequence, either from
   a standing route template or ad hoc from the orders the office picked this morning.
2. **Put the run in the driver's hand and track it** — assign a driver, dispatch the run for a
   date, and have the stop list appear on their device with addresses, contact numbers, what to
   hand over and navigation, while the office can see how far through the run they are.
3. **Prove and reconcile what was actually delivered** — capture per-stop completion with
   photo/signature, record what was really handed over versus what was ordered, and feed that back
   into the order, the invoice and (where enabled) the money collected at the door.

## Must have (P0)

| ID      | Capability                                                      | Status     | What it does                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTE-M1  | Define a delivery route / trip                                  | SHIPPED ✅ | Create a named route with start point, optional end point, toll/objective preferences.                    | `POST /api/v1/routes` → `routes.controller.ts:58` → `routes.service.ts createRoute` (L216); Prisma `Route` (schema.prisma:1115).                                                                                                                                                                                                                                                                                              |
| RTE-M2  | Build and sequence the stop list                                | SHIPPED ✅ | Add, reorder, remove customer stops on a route/run.                                                       | `routes.controller.ts` L100-122 → `addStop`/`reorderStops`/`removeStop`; Prisma `RouteStop` (schema.prisma:1149).                                                                                                                                                                                                                                                                                                             |
| RTE-M3  | Dispatch a run for a date and attach the day's orders           | SHIPPED ✅ | Turns a route into a dated run and sweeps open, route-fulfilled orders onto each stop.                    | `POST /api/v1/route-runs` → `routes.service.ts createRun` (L787), sweep L922-954.                                                                                                                                                                                                                                                                                                                                             |
| RTE-M4  | Assign a driver and notify their device                         | SHIPPED ✅ | Assign a driver on route or run; dispatch pushes over socket + Expo push.                                 | `routes.service.ts` L841, L984-996; gateway room `driver:<sub>`.                                                                                                                                                                                                                                                                                                                                                              |
| RTE-M5  | Driver executes the run (start, arrive, complete, skip, finish) | PARTIAL 🟡 | Start/arrive/complete/skip a run and its stops; run auto-completes on last stop.                          | API complete: `routes.controller.ts` (`my-runs`, `PATCH /status`, `PATCH stop`, `complete`, auto-complete L1756). verified: operator-side control (skip, reopen, cancel, re-optimize) works for any tenant with the ordinary delivery addon via `apps/mobile/app/(operator)/route-runs/[id].tsx` — only stop COMPLETION and the driver-role screens are behind `developer_mode` (`apps/mobile/app/_layout.tsx` L174-190).     |
| RTE-M6  | Proof of delivery capture (photo + signature)                   | PARTIAL 🟡 | Driver captures delivery photos and signature per stop, stored durably.                                   | `RouteRunStop.podPhotoUrls`/`signatureUrl` (schema.prisma:1223); `attachPodArtifact` (routes.service.ts L1553). PARTIAL: capture lives only in the dev-gated driver app; no buyer surface can see a POD.                                                                                                                                                                                                                      |
| RTE-M7  | Delivered-vs-ordered reconciliation                             | BROKEN 🔴  | Bill the customer for what actually left the truck, not what was ordered.                                 | `reconcileOrderDeliveredInvoices` (invoices.service.ts L1506) is only called from `recordDeliveryPaymentInTx`, which early-returns when `amount <= 0` (L4408); driver app sends no payment object on an on-account close (`payment.tsx` L292). verified: `completeWithPayment` DOES write `OrderItem.deliveredQty` unconditionally (L1923-1926); the plain `completeStop` endpoint has no client caller anywhere in the apps. |
| RTE-M8  | Offline-tolerant completion with idempotency                    | PARTIAL 🟡 | Driver actions queue on device through dead zones and replay without double-charging.                     | `apps/mobile/store/offlineQueue.ts` (AsyncStorage-persisted); server `Idempotency-Key` handling (routes.service.ts L1440-1483). verified: the only mutation this protects is the driver completion path, which is `developer_mode`-gated — unreachable for a normal tenant today.                                                                                                                                             |
| RTE-M9  | Ad-hoc trip building from open orders                           | SHIPPED ✅ | Office selects open orders and builds a one-off trip, one stop per customer, with reasons for exclusions. | `trips.controller.ts` / `trips.service.ts checkEligibility` (L100); `groupOrdersForTrip` mirrored in api/web/mobile.                                                                                                                                                                                                                                                                                                          |
| RTE-M10 | Tenant isolation and role scoping across the whole domain       | SHIPPED ✅ | Routes/runs/stops/drivers/locations of one tenant invisible to another; role-gated handlers.              | `forTenant()` throughout `routes.service.ts`; security specs `routes.controller.security.spec.ts`, `dispatch-addon-gate.spec.ts`.                                                                                                                                                                                                                                                                                             |
| RTE-M11 | Driver directory and lifecycle                                  | SHIPPED ✅ | Create driver logins, record vehicle/home base, deactivate, view history and metrics.                     | `drivers.controller.ts` full CRUD + `/history` + `/metrics`; `drivers.service.ts create/update/remove`.                                                                                                                                                                                                                                                                                                                       |
| RTE-M12 | Failed delivery, re-attempt and reschedule                      | BROKEN 🔴  | Capture why a stop failed and release its orders back to the pool for rescheduling.                       | `RouteRunStopStatus` has no FAILED/attempt state; `routeRunStopId` is cleared only by `deleteRun`/`deleteRoute`, never by cancellation; `trips.service.ts checkEligibility` (L121) then marks those orders `PREVIOUSLY_DISPATCHED` forever.                                                                                                                                                                                   |
| RTE-M13 | Van sales — driver creates a new order at the door              | SHIPPED ✅ | Driver creates a new order at a stop, auto-linked to the run and stop.                                    | `apps/mobile/app/(driver)/route/stop/[stopId]/new-order.tsx`; `orders.service.ts` L1966-1979 links `routeRunId`/`routeRunStopId` and confirms the order.                                                                                                                                                                                                                                                                      |
| RTE-M14 | Driver edits order line items mid-delivery                      | SHIPPED ✅ | Driver can edit an order's line items at any live stage, including after delivery.                        | `apps/mobile/app/(driver)/route/stop/[stopId]/edit-items.tsx` (reuses operator `EditOrderItemsScreen`); header states the API "accepts a driver edit at any live stage (out-for-delivery / delivered included)".                                                                                                                                                                                                              |

### Testing criteria

#### RTE-M1

- [ ] Creating a route with origin type DRIVER whose Driver has no home base returns 400 and writes no Route row. `Jest (api)`
- [ ] An ADDRESS origin whose geocode fails returns 400 rather than silently defaulting to the tenant depot. `Jest (api)`
- [ ] RETURN_TO_START end persists coords equal to the resolved depot, not null. `Jest (api)`
- [ ] A route created in tenant A is absent from tenant B's `GET /routes`. `Playwright (web)`

#### RTE-M2

- [ ] `addStop` with no `stopNumber` appends at max+1 and resolves the customer's default address when none given. `Jest (api)`
- [ ] `reorderRunStops` on an IN_PROGRESS/COMPLETED run is rejected. `Jest (api)`
- [ ] Any stop mutation nulls `Route.plannedPolyline` in the same transaction. `Jest (api)`
- [ ] `removeStop` on a stop belonging to another route returns 404. `Jest (api)`

#### RTE-M3

- [ ] Two concurrent dispatches for the same route produce exactly one active run (second gets 409). `Jest (api)`
- [ ] A SHIP-fulfillPath order is never attached by the sweep. `Jest (api)`
- [ ] Missing/extra `orderIds` for SCHEDULED vs ADHOC routes returns 400 before any write. `Jest (api)`
- [ ] Every created `RouteRun`/`RouteRunStop` carries a non-null `tenantId`. `Jest (api)`
- [ ] `attachedOrderCount` reflects rows actually updated. `Jest (api)`

#### RTE-M4

- [ ] Dispatching without `dto.driverId` falls back to `Route.driverId`. `Jest (api)`
- [ ] A DRIVER-role caller always gets their own driver id on the created run. `Jest (api)`
- [ ] Dispatching with no driver assigned emits no `route.dispatched` event and sends no push. `Jest (api)`
- [ ] A push-notification failure does not fail the dispatch (best-effort). `Jest (api)`

#### RTE-M5

- [ ] `completeStop` on a SCHEDULED run returns 403. `Jest (api)`
- [ ] `PATCH /status` to COMPLETED with any stop still PENDING returns 400. `Jest (api)`
- [ ] A driver whose id doesn't match the run's driver gets 403 on all run/stop endpoints. `Jest (api)`
- [ ] Completing the final stop flips the run to COMPLETED and emits `driver.status.updated` once. `Jest (api)`
- [ ] Verify an OPERATOR on a non-dev tenant can skip/reopen/cancel/re-optimize a run from `(operator)/route-runs/[id].tsx`. `manual`

#### RTE-M6

- [ ] `attachPodArtifact` is idempotent per `artifactId`. `Jest (api)`
- [ ] A non-decodable image data-URL returns 400 and writes nothing. `Jest (api)`
- [ ] `getStopPod` only signs URLs that pass `isPodStorageKey(value, tenantId)`. `Jest (api)`
- [ ] A signature data-URL persists a storage key, never the base64 blob. `Jest (api)`

#### RTE-M7

- [ ] Complete-with-payment for 3 of 10 ordered cases with NO payment object must bill 3, not 10 — hoist the delivered-basis reconcile out of the amount>0 guard. `Jest (api)`
- [ ] Money invariant: after any short delivery, invoice.total equals sum of line subtotals + tax, all `roundMoney`'d, every boxed line via `computeLineSubtotal`. `Jest (api)`
- [ ] A REFUSED line bills 0 while siblings bill their delivered qty. `Jest (api)`
- [ ] Replaying the same completion with the same Idempotency-Key does not double-reduce the invoice. `Jest (api)`

#### RTE-M8

- [ ] Two POSTs with the same Idempotency-Key create exactly one payment/mutation set; second returns cached body. `Jest (api)`
- [ ] The same key on a different stop is not treated as a replay. `Jest (api)`
- [ ] A queued action retains its Idempotency-Key across an app restart. `Jest (mobile)`
- [ ] Airplane mode → complete three stops → restore signal → exactly three completions land. `manual`

#### RTE-M9

- [ ] `POST /trips` with one ineligible order returns 409 naming the reason per order and creates no Route. `Jest (api)`
- [ ] `GET /trips/eligible-orders` never returns an order `POST /trips` would reject. `Jest (api)`
- [ ] A `driverId` belonging to another tenant returns 404. `Jest (api)`
- [ ] Two orders for the same customer collapse into one stop. `Jest (api)`
- [ ] Planning changes while a run is IN_PROGRESS return 409. `Jest (api)`

#### RTE-M10

- [ ] `GET /route-runs/:id` for another tenant's run returns 404. `Jest (api)`
- [ ] A CUSTOMER-role token gets 403 on every routes/runs/drivers handler. `Jest (api)`
- [ ] `DriverLocation` rows never surface in another tenant's `/routes/live`. `Jest (api)`
- [ ] `dispatch-addon-gate.spec.ts` pins the required addon set per controller. `Jest (api)`

#### RTE-M11

- [ ] Deleting a driver with a SCHEDULED/IN_PROGRESS run returns 400. `Jest (api)`
- [ ] Deleting a pure-DRIVER deletes the linked User; a dual-role driver keeps the User. `Jest (api)`
- [ ] Historical run/mutation rows survive deletion with `driverId` null. `Jest (api)`
- [ ] Duplicate email/username on driver creation returns 400 and creates nothing. `Jest (api)`

#### RTE-M12

- [ ] Cancelling a run must clear `routeRunId`/`routeRunStopId` on non-delivered orders; assert `GET /trips/eligibility` then reports them eligible (currently fails — bug B129). `Jest (api)`
- [ ] Completing a run with a SKIPPED stop must release that stop's orders back to the pool. `Jest (api)`
- [ ] Skipping a stop requires/records a reason and increments an attempt count. `Jest (api)`
- [ ] A released order keeps its original status and its invoice untouched. `Jest (api)`
- [ ] Cancel a dispatched delivery, then rebuild a trip from the same orders — the builder offers them. `Playwright (web)`

#### RTE-M13

- [ ] A new order created at a stop is linked to that run and stop and set CONFIRMED. `Jest (api)`
- [ ] The van-sale order respects the same pricing/boxed-line rules as an office-created order. `Jest (api)`

#### RTE-M14

- [ ] Editing items on a DELIVERED order recomputes the invoice on the same delivered basis as RTE-M7. `Jest (api)`
- [ ] A driver-role edit never applies price overrides (list pricing only). `Jest (api)`

## Nice to have (P1)

| ID      | Capability                                                  | Status     | What it does                                                                                | Evidence                                                                                                                                                                                                                                                                                                                |
| ------- | ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTE-N1  | Automatic stop sequencing against real road times           | SHIPPED ✅ | One click resequences stops by driving cost, degrading gracefully without a maps key.       | `POST /routes/:id/optimize`, `/route-runs/:id/optimize`; `route-optimization.service.ts` L342-1120.                                                                                                                                                                                                                     |
| RTE-N2  | Route variants — fastest, shortest, avoid tolls             | SHIPPED ✅ | Planner compares 2-3 candidate sequences with time/distance/toll before dispatch.           | `POST /routes/:id/variants`, `/variants/apply`; `route-optimization.service.ts` L703-967.                                                                                                                                                                                                                               |
| RTE-N3  | ETA per stop and delivery-window checking                   | PARTIAL 🟡 | Projects arrival/departure per stop and flags misses against the customer's window.         | `route-analysis.service.ts analyzeRoute`/`analyzeRouteRun`. verified: route settings live in `SystemConfig` keys (`route.averageSpeedKmh` etc, `settings.controller.ts` L390-442), not a `RouteSettings` Prisma model as originally cited.                                                                              |
| RTE-N4  | Flexible start and end points per trip                      | SHIPPED ✅ | Trip start/end can be depot, driver home, or a typed address, editable after build.         | `RouteOriginKind`/`RouteEndKind` enums; `trips.service.ts resolveOrigin/resolveEnd`.                                                                                                                                                                                                                                    |
| RTE-N5  | Live driver location and fleet view                         | PARTIAL 🟡 | Office sees driver position, stops remaining, next stop while a run is live.                | `POST /drivers/me/location`, `GET /routes/live`. PARTIAL: only mobile consumes it; no web consumer, no socket push, no ETA in payload, no retention/pruning of `DriverLocation`.                                                                                                                                        |
| RTE-N6  | Packing / load list for a run                               | SHIPPED ✅ | Consolidated product-by-quantity list for a route or dispatched run.                        | `GET /routes/:id/packing-list`, `/route-runs/:id/packing-list`.                                                                                                                                                                                                                                                         |
| RTE-N7  | At-door payment collected atomically with the delivery      | PARTIAL 🟡 | Driver takes cash/cheque at the door in the same transaction as the delivery.               | `POST /route-runs/:id/stops/:stopId/complete-with-payment` → `recordDeliveryPaymentInTx`. verified: the only client caller is the dev-gated driver app (`payment.tsx`); no web hook exists at all in `apps/web/lib/api/routes.ts` — at-door collection is unreachable for any non-dev tenant, same as POD capture.      |
| RTE-N8  | Short-pick / partial-delivery capture on the driver app     | PARTIAL 🟡 | Driver adjusts delivered quantity per line before closing a stop, defaulting to full order. | `apps/mobile/app/(driver)/route/stop/[stopId]/short-pick.tsx`; `DeliveryMutation` model. PARTIAL because it only reaches the invoice on the payment path (RTE-M7).                                                                                                                                                      |
| RTE-N9  | Reopen a mis-completed stop                                 | PARTIAL 🟡 | Undo a wrongly closed stop, reversing stock and restoring the order, if no money was taken. | `POST /route-runs/:id/stops/:stopId/reopen` (routes.service.ts L2236). verified: no web surface calls it at all — reachable only from the mobile operator/driver screens; also does not reset `OrderItem.deliveredQty` (a non-nullable `Decimal @default(0)` field, not "stays null" as originally claimed).            |
| RTE-N10 | Driver and route performance reporting                      | SHIPPED ✅ | Runs completed, deliveries made, on-time %, avg duration, stops/hour per driver/route.      | `GET /analytics/routes/performance`, `/analytics/drivers/performance`.                                                                                                                                                                                                                                                  |
| RTE-N11 | Regulated delivery gate (age / ID verification at the door) | PARTIAL 🟡 | Age/ID-restricted stops require signature + age check + ID check; safe-drop forbidden.      | `apps/api/src/common/regulated-delivery.ts assertRegulatedDeliverySatisfied`. PARTIAL and effectively dark: `TrackedCategory.requiresAgeCheck`/`requiresIdCheck` has no writer anywhere outside `demo-seed.js`.                                                                                                         |
| RTE-N12 | Navigation handoff and stop contact actions                 | SHIPPED ✅ | One tap opens turn-by-turn directions, calls, or texts the customer from the stop card.     | `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`. verified: web run-detail also builds a multi-leg maps handoff (`buildGoogleMapsLegs`, `routes/[id]/page.tsx:89`), not mobile-only as originally scoped.                                                                                                       |
| RTE-N13 | Driver notes and stop-level annotations                     | PARTIAL 🟡 | Driver leaves a note on a stop; office reads it against that stop.                          | `RouteRunStop.driverNote`/`.notes`. verified: office READ is real on web, but capture is not — `apps/web/lib/api/routes.ts` has no stop-status/note-write hook, so notes/skip can only be written from mobile.                                                                                                          |
| RTE-N14 | Delivery history per route and per driver                   | PARTIAL 🟡 | Past runs for a route/driver with stop counts, status, and captured proof.                  | `GET /route-runs`, `GET /drivers/:id/history`. PARTIAL: no customer-centric history — `DeliveryBatch` (schema.prisma:1540) model itself has no writer, though `Invoice.deliveryBatchId` is a separate, live, load-bearing field used throughout `invoices.service.ts`.                                                  |
| RTE-N15 | End-of-run cash settlement for the driver                   | PARTIAL 🟡 | Driver and office agree on cash/cheques collected on a run.                                 | `apps/mobile/app/(driver)/route/settlement.tsx` + `runSettlementStore.ts` — explicitly in-memory, non-persisted, device-local; no backend endpoint to fetch a run's payments. `flag.settlement` is RESERVED with no gating code. Also ships a second, honestly-stubbed "coming soon" cash screen (`(driver)/cash.tsx`). |
| RTE-N16 | Split an order's invoice at the door                        | SHIPPED ✅ | Driver splits a stop's order into separate invoices, e.g. for regulated-goods separation.   | `apps/mobile/app/(driver)/route/stop/[stopId]/split-invoice.tsx` (shared `SplitInvoiceScreen`).                                                                                                                                                                                                                         |
| RTE-N17 | Driver-initiated return capture at a stop                   | SHIPPED ✅ | Driver captures a product return at the door, feeding the returns module.                   | `apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx`; interaction with `flag.returns` on a delivery-enabled tenant without that flag is undefined behavior.                                                                                                                                                  |
| RTE-N18 | In-app route map for driver and operator                    | SHIPPED ✅ | Live self-position and route polyline rendered in-app, not only via external maps handoff.  | `apps/mobile/app/(driver)/map.tsx` (`AppMapView`, foreground location watch); `apps/mobile/app/(operator)/routes/[id]/map.tsx`.                                                                                                                                                                                         |
| RTE-N19 | Driver self-service performance stats                       | BROKEN 🔴  | Driver-facing screen shows their own on-time % and returns rate.                            | `GET /route-runs/my-stats` (routes.controller.ts L164-169) → `routes.service.ts` L2202-2234: `onTimeDeliveryPct` is hardcoded to 100 and `returnsRate` hardcoded to 0 for every driver — only `totalStopsCompleted`/`avgStopsPerRoute` are real.                                                                        |

### Testing criteria

#### RTE-N1

- [ ] With no ORS key configured, result carries `usedFallback: true` / `fallbackReason: ORS_NOT_CONFIGURED` and stops still reorder locally. `Jest (api)`
- [ ] An ORS 429 maps to `ORS_RATE_LIMITED`, not a 500. `Jest (api)`
- [ ] The Google matrix cache never stores a haversine result and returns a structured clone on hit. `Jest (api)`
- [ ] Optimizing a run with 0/1 stops is a no-op. `Jest (api)`

#### RTE-N2

- [ ] Variants visiting the same stops in the same order within tolerance are deduped to one. `Jest (api)`
- [ ] A route with more than 10 intermediate waypoints skips `computeRoutes` entirely. `Jest (api)`
- [ ] Applying a variant writes both the stop order and its `plannedPolyline`. `Jest (api)`
- [ ] Applying a variant whose stop ids don't match the route's current stops returns 400. `Jest (api)`

#### RTE-N3

- [ ] A stop projected to arrive after `deliveryWindowEnd` returns `withinWindow: false`; a stop with no window returns `null`, not `false`. `Jest (api)`
- [ ] Analysis uses the tenant's `SystemConfig` `route.serviceTimeMinutes`/`route.averageSpeedKmh`, and changing them shifts downstream arrivals. `Jest (api)`
- [ ] A route with un-geocoded stops errors clearly rather than producing a nonsense ETA. `Jest (api)`
- [ ] Dispatch page shows a window badge only for customers with a window set. `Playwright (web)`

#### RTE-N4

- [ ] `DRIVER_HOME` end with no `driverId` falls back to the route's driver; with neither, 400. `Jest (api)`
- [ ] Changing only the origin on a `RETURN_TO_START` route refreshes the stored end coords. `Jest (api)`
- [ ] Every accepted planning change nulls `plannedPolyline` and returns `reoptimizeRecommended: true`. `Jest (api)`
- [ ] Geocode/driver lookups happen strictly outside the DB transaction. `Jest (api)`

#### RTE-N5

- [ ] `getLiveRoutes` returns only IN_PROGRESS runs and `latestLocation: null` past the 5-minute freshness window. `Jest (api)`
- [ ] `nextStopIndex` equals stop count when all stops are COMPLETED/SKIPPED. `Jest (api)`
- [ ] A location fix from tenant A's driver never appears in tenant B's `/routes/live`. `Jest (api)`
- [ ] Confirm a `DriverLocation` retention/prune policy exists (today it grows unbounded). `manual`

#### RTE-N6

- [ ] Two orders with the same product on a run aggregate into one line with summed quantity. `Jest (api)`
- [ ] A boxed line contributes normalized units, never raw qty. `Jest (api)`
- [ ] CANCELLED order lines are excluded. `Jest (api)`

#### RTE-N7

- [ ] Money invariant: sum of non-VOID payments equals amount applied, `roundMoney`'d, never over-collecting past the balance. `Jest (api)`
- [ ] A tenant without `driver_payments` gets 403 on amount > 0 but 2xx with no payment object. `Jest (api)`
- [ ] `amount <= 0` for CASH/CHECK/CREDIT_CARD returns 400. `Jest (api)`
- [ ] Verify web has genuinely no completion/payment hook before treating this as web-reachable. `manual`

#### RTE-N8

- [ ] Short-picked boxed line uses `computeLineSubtotal`, never `qty * unitPrice`. `Jest (mobile)`
- [ ] A line already carrying `deliveredQty > 0` (reopened stop) is excluded from re-offer. `Jest (mobile)`
- [ ] A REFUSED mutation writes `deliveredQty` 0 on the order item. `Jest (api)`

#### RTE-N9

- [ ] Stock invariant: after reopen, sum of `StockMovement.quantity` nets to zero and `Product.currentStock` returns to pre-delivery value. `Jest (api)`
- [ ] The compensating movement carries the ORIGINAL sale's `unitCost`. `Jest (api)`
- [ ] Reopening a stop with any `InvoicePayment` returns 400 and mutates nothing. `Jest (api)`
- [ ] Reopen resets `OrderItem.deliveredQty` to its zero default; assert it is 0 afterwards (field is non-nullable). `Jest (api)`

#### RTE-N10

- [ ] A run with `startedAt` null or `completedAt <= startedAt` is excluded from duration/stops-per-hour but counted in `totalRuns`. `Jest (api)`
- [ ] On-time = stop `completedAt` <= end of `scheduledDate` UTC day. `Jest (api)`
- [ ] A driver with runs but zero completed stops reports `onTimeRate: null`, not 0. `Jest (api)`

#### RTE-N11

- [ ] Completion without a signature on an age-required category returns 400 `SIGNATURE_REQUIRED`. `Jest (api)`
- [ ] `safeDropEnabled: true` on a regulated stop returns `SAFE_DROP_FORBIDDEN`. `Jest (api)`
- [ ] Identify the admin surface that sets `requiresAgeCheck`/`requiresIdCheck` — if none exists, this gate cannot fire for a paying tenant. `manual`

#### RTE-N12

- [ ] `openInMaps` builds a waypoint URL from remaining stops only, in order. `Jest (mobile)`
- [ ] `buildGoogleMapsLegs` on web produces the same leg-splitting behavior for over-capacity waypoint counts. `Jest (web)`

#### RTE-N13

- [ ] `PATCH` with status SKIPPED and a note persists both. `Jest (api)`
- [ ] Reopen clears `driverNote` along with the rest of the capture. `Jest (api)`
- [ ] Add a web write-path for notes/skip, or document that web is read-only for stop annotation. `manual`

#### RTE-N14

- [ ] `GET /route-runs?date=` filters at UTC midnight. `Jest (api)`
- [ ] Either write `DeliveryBatch` rows on completion or remove the model — but never remove `Invoice.deliveryBatchId`, which is live and load-bearing. `Jest (api)`

#### RTE-N15

- [ ] A `GET /route-runs/:id/collections` endpoint sums non-VOID payments by method, server-side. `Jest (api)` (endpoint does not exist today)
- [ ] Settlement tally survives an app restart mid-run. `Jest (mobile)` (fails today — store not persisted)

#### RTE-N16

- [ ] Splitting an invoice at the door produces invoices whose lines sum to the original order total. `Jest (api)`

#### RTE-N17

- [ ] A return captured at a stop with `flag.returns` off is either rejected or clearly queued — define and test the behavior. `Jest (api)`

#### RTE-N18

- [ ] The driver map pin updates from the foreground location watch without waiting for the 30s background post. `manual`

#### RTE-N19

- [ ] Fix `onTimeDeliveryPct`/`returnsRate` to compute from real stop data instead of hardcoded 100/0, matching the analytics.service.ts math. `Jest (api)`

## Advanced / future (P2)

| ID      | Capability                                                 | Status     | What it does                                                                                 | Evidence                                                                                                                                                                        |
| ------- | ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTE-A1  | Multi-vehicle fleet optimization (true VRP)                | MISSING ⬜ | Split the day's orders across drivers and sequence each, instead of one route at a time.     | `route-optimization.service.ts` sends exactly `vehicles: [vehicleDef]` — one vehicle, always.                                                                                   |
| RTE-A2  | Vehicle capacity, weight and volume constraints            | MISSING ⬜ | Refuse or split an over-loaded route based on vehicle capacity vs order weight/volume.       | No capacity/weight/volume field exists anywhere in the schema.                                                                                                                  |
| RTE-A3  | Recurring route auto-scheduling                            | MISSING ⬜ | A standing route generates its dated run automatically, pre-populated with the day's orders. | `Route` has no recurrence/daysOfWeek/frequency field; none of the 13 `@Cron` jobs create a `RouteRun`.                                                                          |
| RTE-A4  | Customer-facing delivery tracking and ETA notification     | MISSING ⬜ | Buyer sees a live ETA window and map link instead of phoning the office.                     | No buyer-facing tracking surface exists; `/routes/live` is operator-only and carries no ETA.                                                                                    |
| RTE-A5  | Geofenced auto-arrival and auto-departure                  | MISSING ⬜ | Stop flips to "arrived" automatically when the van enters the customer's geofence.           | `arrivedAt` only stamped by explicit `PATCH` (routes.service.ts L1430); nothing compares a fix to stop coordinates.                                                             |
| RTE-A6  | Cost-to-serve and per-run profitability                    | MISSING ⬜ | Show a run's cost (distance, fuel, driver hours) against the revenue it delivered.           | Analytics stop at operational counts; no fuel/mileage-cost/rate join exists.                                                                                                    |
| RTE-A7  | Mid-run re-optimization from the driver's current position | PARTIAL 🟡 | Resequence remaining stops from the van's actual position, not the depot.                    | `POST /route-runs/:id/optimize` accepts `originLat/Lng`, triggered from the mobile OPERATOR screen. PARTIAL: the driver app never calls it; `reorderRunStops` is operator-only. |
| RTE-A8  | Share the proof of delivery with the customer              | MISSING ⬜ | The signed delivery note reaches the buyer automatically.                                    | POD fetch is OPERATOR/DRIVER only; no buyer surface references POD.                                                                                                             |
| RTE-A9  | Driver settlement ledger and payout                        | MISSING ⬜ | Server-side cash-per-run record with variance and audit history.                             | `flag.settlement` is RESERVED with no gating code; no `Settlement` model exists.                                                                                                |
| RTE-A10 | Territory / zone planning and automatic route assignment   | MISSING ⬜ | New customers land on the right standing route automatically by zone.                        | `RouteCustomer` model is delete-only; no zone/territory model exists.                                                                                                           |
| RTE-A11 | Telematics and driver-behaviour signals                    | MISSING ⬜ | Use the existing location stream for speeding, harsh-driving, idle-time insight.             | `DriverLocation` stores heading/speed/battery but nothing reads it beyond echoing in `/routes/live`.                                                                            |
| RTE-A12 | Live dispatch map on the web dashboard                     | MISSING ⬜ | Office watches the fleet move on a map on the big screen.                                    | `/routes/live` exists but has zero web consumers; the web dispatch page is card-based with a 30s poll.                                                                          |

### Testing criteria

#### RTE-A1

- [ ] Given N unassigned orders and M active drivers, a fleet-plan endpoint returns M stop lists whose union is exactly N orders with no duplicates. `Jest (api)`
- [ ] The plan is proposed, never auto-dispatched. `Jest (api)`

#### RTE-A2

- [ ] A route whose orders exceed the vehicle's capacity is flagged at dispatch, not silently dispatched. `Jest (api)`

#### RTE-A3

- [ ] A route with a Mon/Wed/Fri schedule produces exactly one SCHEDULED run per matching date. `Jest (api)`
- [ ] Generation is idempotent for the same date. `Jest (api)`

#### RTE-A4

- [ ] A tracking token resolves to exactly one stop and expires on completion or run end. `Jest (api)`
- [ ] The tracking payload exposes ETA and driver first name only. `Jest (api)`

#### RTE-A5

- [ ] A fix within the geofence radius of the next stop stamps `arrivedAt` once. `Jest (api)`

#### RTE-A6

- [ ] A completed run reports distance and cost derived from tenant per-km/per-hour rates. `Jest (api)`

#### RTE-A7

- [ ] Optimizing an IN_PROGRESS run reorders only PENDING stops. `Jest (api)`
- [ ] Decide whether a driver should be able to resequence their own remaining stops — today only the operator screen can. `manual`

#### RTE-A8

- [ ] A buyer linked to the customer can fetch the POD for their own delivered order only. `Jest (api)`

#### RTE-A9

- [ ] Closing a run computes expected cash from non-VOID payments and records declared vs. variance. `Jest (api)`

#### RTE-A10

- [ ] A customer in zone X is proposed (not auto-applied) for the route serving X. `Jest (api)`

#### RTE-A11

- [ ] Fixes above a tenant speed threshold produce one aggregated event, not one per sample. `Jest (api)`

#### RTE-A12

- [ ] With one IN_PROGRESS run seeded, `/dispatch` renders a driver marker and next-stop highlight. `Playwright (web)`

## How this varies by tenant

| Variation                                                                                | Mechanism                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standing recurring routes (`/routes`, `/dispatch`) sellable independently                | `TenantAddon` key `recurring_routes` — class-level `@RequireAddon` on `RoutesController`.                                                                                                                                                                                                                  |
| Ad-hoc order-delivery trips (`/deliveries`, trip builder) sellable independently         | `TenantAddon` key `order_delivery` — `@RequireAddon("order_delivery","developer_mode")` on `TripsController`.                                                                                                                                                                                              |
| Whether drivers may take money at the door vs. bill-on-account only                      | `TenantAddon` key `driver_payments`, enforced on the request body by `driver-payments.guard.ts` so a $0 on-account close still works for every tenant.                                                                                                                                                     |
| Whether the mobile driver app is reachable at all for this tenant's DRIVER logins        | `TenantAddon` key `developer_mode` — `apps/mobile/app/_layout.tsx` L174-190 sends a pure DRIVER on a non-dev tenant to `operator-blocked`. Deliberate in-development gate (owner decision, B33), but leaves POD capture, at-door payment, van sales and offline completion dark for every ordinary tenant. |
| Average vehicle speed, per-stop service time, default run start time for ETA projections | Tenant setting via `SystemConfig` keys `route.averageSpeedKmh` / `route.serviceTimeMinutes` / `route.defaultStartTime`, exposed at `GET/PATCH /api/v1/settings/route`.                                                                                                                                     |
| The warehouse depot every trip starts from                                               | `SystemConfig` keys `route.defaultDepotLat`/`Lng`, seeded from tenant address; overridable per route/trip.                                                                                                                                                                                                 |
| Per-customer delivery time window honoured by optimizer and ETA analysis                 | `Customer.deliveryWindowStart`/`End`. **NOT CONFIGURABLE** per address, per weekday, or per stop — one window per customer only.                                                                                                                                                                           |
| Whether a customer's orders are delivered on a van or shipped by a carrier               | `Customer.fulfillPath` (ROUTE\|SHIP), seeded onto `Order.fulfillPath`; SHIP orders excluded from both the dispatch sweep and trip eligibility.                                                                                                                                                             |
| Whether goods in a category force an age/ID check and signature at the door              | `TrackedCategory.requiresAgeCheck`/`requiresIdCheck`. **NOT CONFIGURABLE** — no DTO, controller, or admin UI writes these fields for a real tenant; only `demo-seed.js` does.                                                                                                                              |
| How many concurrent routes a tenant may run per day                                      | Meter `ROUTES` with cap `def.routesConcurrent` and add-on SKU `ROUTE_EXTRA`. **NOT ENFORCED** — displayed on the billing usage bar but nothing in `apps/api/src/routes` checks it.                                                                                                                         |
| Plan-tier gating of the dispatch feature set                                             | `flag.dispatch_live` — declared but deliberately unenforced and granted to no plan tier; gating is done by the two addons instead.                                                                                                                                                                         |
| Driver run settlement                                                                    | `flag.settlement` — RESERVED, explicitly documented as having no implementation to gate.                                                                                                                                                                                                                   |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                                                                                    | Impact                                                                                                                                                                                   | Suggested direction                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Short deliveries only bill correctly when the driver collects money at the door — the delivered-basis reconcile lives inside the payment helper and early-returns at `amount <= 0`, and the driver app sends no payment object on an on-account close. | Any tenant billing on account over-bills every short or refused delivery; the customer's invoice shows the ordered number, not the delivered one, until disputed.                        | Hoist the reconcile out of the payment helper so it runs for every completion regardless of amount, and make the plain completion path write `deliveredQty` too.                              |
| CRITICAL | Cancelling a run, or skipping a stop, strands its orders permanently — `routeRunStopId` is cleared only by route/run deletion, never by cancellation, and eligibility then reports those orders `PREVIOUSLY_DISPATCHED` forever.                       | Ordinary delivery-day events (van breakdown, shop shut) permanently remove orders from the trip builder with no UI recourse.                                                             | On cancellation/skip-then-complete, null the order's run/stop link for undelivered orders; relax eligibility to treat a stale link to a finished/cancelled run as eligible.                   |
| HIGH     | No failed-delivery concept — no FAILED status, attempt counter, or reason code exists on a stop.                                                                                                                                                       | Cannot report first-attempt success or distinguish "shop shut" from "refused" from "ran out of time"; no re-attempt workflow.                                                            | Add a reason enum and `attemptCount` on `RouteRunStop`, plus a reschedule action that releases orders to tomorrow's pool.                                                                     |
| HIGH     | The entire driver completion experience (POD, at-door payment, short-pick, offline queue) is behind `developer_mode`, unreachable for a normal tenant, though operator-side control (skip/reopen/cancel/re-optimize) is not gated.                     | The delivery-execution half of this domain cannot be sold as advertised — recurring_routes/order_delivery addons let a tenant dispatch a run no driver can complete on their own device. | Known owner decision (B33). Either finish the driver app to a shippable bar and swap the gate to the delivery addons, or make addon copy honest that completion stays office-only until then. |
| HIGH     | The regulated age/ID delivery gate has no admin surface to turn on — `requiresAgeCheck`/`requiresIdCheck` have no writer outside the demo seed.                                                                                                        | A distributor selling age-restricted goods believes they have a compliance control that can never fire for their tenant.                                                                 | Add the two booleans to the tracked-category admin form/DTO and a Playwright case proving the gate rejects an uncompleted signature once enabled.                                             |
| HIGH     | Driver settlement is device-local, in-memory, and non-persisted; no server endpoint sums a run's actual collections.                                                                                                                                   | Cash reconciliation vanishes on app kill and under-counts on a second device; the office has no expected-cash figure to check against.                                                   | Add `GET /route-runs/:id/collections` summing non-VOID payments by method, and a `Settlement` row with declared vs. expected variance, gated on the existing `flag.settlement`.               |
| MEDIUM   | The web dashboard has no live map — `/routes/live` is implemented but only mobile consumes it.                                                                                                                                                         | The office desk view is counters-only; "where is my order" still needs the mobile app or a phone call.                                                                                   | Add a live layer to the existing dispatch page reusing `RouteMap.tsx`, with an explicit stale state past the 5-minute freshness window.                                                       |
| MEDIUM   | No capacity or multi-vehicle planning — one vehicle, no weight/volume/payload fields anywhere.                                                                                                                                                         | Route building stays a human judgement call about what fits in the van; larger fleets get no help splitting work.                                                                        | Sequence after the driver app ships: add vehicle payload and product weight/volume, then extend the ORS integration.                                                                          |
| MEDIUM   | `DriverLocation` grows unbounded — no prune, retention window, or archival job exists.                                                                                                                                                                 | Slow-burn database cost and an unanswered privacy-retention question for a ~500k-row/year/10-drivers table.                                                                              | Add a nightly prune keeping raw fixes for a tenant-configurable N days; document the retention period.                                                                                        |
| MEDIUM   | The `ROUTES` meter and `ROUTE_EXTRA` SKU are inert — the cap is displayed but never enforced in `apps/api/src/routes`.                                                                                                                                 | Billing shows a tenant over their allowance while dispatch continues unrestricted, making the usage bar misleading.                                                                      | Apply the standard soft-cap grace pattern at `createRun`, or drop `routesConcurrent`/`ROUTE_EXTRA` from the published catalog.                                                                |
| MEDIUM   | `reopenStop` doesn't reset `OrderItem.deliveredQty`, leaving stale delivered quantities behind.                                                                                                                                                        | A stop reopened after a partial delivery reconciles a subsequent re-completion against numbers from the abandoned attempt.                                                               | Reset `deliveredQty` to its zero default for affected order items inside the same reopen transaction.                                                                                         |
| MEDIUM   | ETAs are a static projection, never recomputed from the driver's live position; `/routes/live` returns no ETA at all.                                                                                                                                  | By late morning the ETA list is fiction; delivery-window warnings stop reflecting reality.                                                                                               | Recompute remaining-stop ETAs from the latest `DriverLocation` on each `/routes/live` poll, reusing the existing ETA helper with the live position as origin.                                 |
| MEDIUM   | `GET /route-runs/my-stats` hardcodes `onTimeDeliveryPct` to 100 and `returnsRate` to 0 for every driver.                                                                                                                                               | A driver's own performance screen always reads a perfect 100% on-time regardless of reality, contradicting the real analytics math.                                                      | Compute both figures from the same stop-completion data `analytics.service.ts` already uses.                                                                                                  |
| LOW      | `DeliveryBatch` model has no writer anywhere, though `Invoice.deliveryBatchId` itself is separately live and load-bearing throughout invoice reconciliation.                                                                                           | The unused model implies a per-visit customer delivery history that doesn't exist, misleading anyone planning from the schema.                                                           | Either write `DeliveryBatch` rows on completion (giving RTE-N14 real customer history) or remove the model — never remove `deliveryBatchId` on `Invoice`.                                     |
| LOW      | `RouteCustomer` model is delete-only — never created or read as a route-membership source of truth.                                                                                                                                                    | Implies an explicit route-membership list that doesn't actually back anything.                                                                                                           | Either make it the real assignment source of truth (feeding RTE-A10) or delete it in a migration.                                                                                             |

## Cross-domain handoffs

- **Orders → Dispatch**: `Order.fulfillPath` decides routability; the dispatch sweep and trip
  eligibility both filter on it. `Order.routeRunId`/`routeRunStopId` is the join; `Order.status`
  transitions to DELIVERED on stop completion, bypassing the normal status-change path (hence an
  explicit DELIVERED notification fired directly from the routes service).
- **Dispatch → Invoices/AR**: completion is where delivery becomes money.
  `recordDeliveryPaymentInTx` creates/finds the order's DRAFT invoice, rebuilds it on the delivered
  basis, finalizes DRAFT→SENT, spreads a collected lump sum oldest-invoice-first under a row lock,
  and recomputes status over non-VOID payments — all inside `completeWithPayment`'s single
  transaction.
- **Dispatch → Inventory**: delivery consumes stock; `reopenStop` writes compensating positive
  SALE stock movements carrying the ORIGINAL sale's unit cost so signed COGS nets to zero. Any
  change to delivery reversal must preserve that invariant.
- **Customers → Dispatch**: stops resolve to a `CustomerAddress` (default-first); delivery windows
  feed both the optimizer and the ETA analysis. A customer with two delivery addresses still
  collapses to one stop.
- **Regulated/Compliance → Dispatch**: `TrackedCategory.requiresAgeCheck`/`requiresIdCheck` drive
  the per-stop check flags at dispatch and the authoritative re-derivation at completion; captured
  evidence lands on `RouteRunStop` as the delivery-side half of the regulated-goods audit trail.
- **Billing/Entitlements → Dispatch**: `recurring_routes`, `order_delivery`, `developer_mode` and
  `driver_payments` addons gate the controllers and client surfaces; the `ROUTES` meter and
  `ROUTE_EXTRA` SKU are wired into entitlements but unenforced here.
- **Notifications/Realtime → Dispatch**: run dispatch emits `route.dispatched` to the driver's
  socket room plus an Expo push; stop completion and status changes emit `route.stop.completed`
  and `driver.status.updated` to the operators room. Push/socket delivery is best-effort and must
  never fail a dispatch.
- **Returns → Dispatch**: the driver stop flow includes a return-capture screen feeding the
  returns module, itself behind `flag.returns` — a driver-initiated return on a delivery-enabled
  tenant without that flag has undefined behavior.
- **Shipments (carrier path) → Dispatch**: SHIP-fulfilled orders leave this domain entirely and
  surface on the shipments page via carrier + tracking number on the invoice. The boundary is
  enforced in two places (the dispatch sweep and trip eligibility) and both must stay in agreement.
- **Analytics → Dispatch**: driver/route performance reporting reads `RouteRun.startedAt`/
  `completedAt`/`scheduledDate` and stop `completedAt`. Anything that changes when those timestamps
  are written (auto-arrival, auto-complete, reopen) silently changes the published on-time and
  stops-per-hour figures.

## What we could not verify

- **Runtime behaviour.** No tests were run and nothing was executed; the BROKEN/PARTIAL calls on
  RTE-M7 and RTE-M12 are read from code paths and should be confirmed with the failing Jest
  assertions listed above before scheduling fixes.
- **Whether the mobile driver app actually works end-to-end.** It is dev-gated and Expo Go cannot
  run this build, so RTE-M5/M6/N7/N8/N16-N18 are judged from source, not from a device.
- **The UX quality of the web planning screens** beyond imports/greps — the full route-detail and
  dispatch pages were not read in entirety, so a control may exist that was missed.
- **Whether the `developer_mode` gate on the driver app and the unenforced `ROUTES` cap are
  current owner intent or drift.** Code comments confirm the former is a deliberate 2026-08-28
  narrowing decision (B33); nothing confirms intent for the latter.
- **Overlap with the existing bug register** at `local-assets/docs/routeflow-bug-register.html`
  was not checked here — the run-cancellation stranding (RTE-M12) likely matches B129, and the
  stale `deliveredQty` on reopen (RTE-N9) may relate to B128. Cross-check before filing new
  entries.
- **Load and cost behaviour of the Google matrix / ORS calls at real tenant scale** — the 10/60s
  throttle and the 500-entry in-process cache are per-instance and would not survive horizontal
  scaling; untested here.
- **Whether a `route.defaultStartTime`/`route.serviceTimeMinutes` change is exercised by any
  automated test today** — verification confirmed the correct storage mechanism (`SystemConfig`,
  not a `RouteSettings` model) but not runtime correctness.
