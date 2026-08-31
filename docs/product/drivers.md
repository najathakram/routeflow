# Drivers & the Driver Mobile App

_The van as a live, self-recording system of record — from dispatch to delivery to cash-up._

## The problem

A wholesale distributor's delivery day lives on paper and WhatsApp: a printed run sheet per van,
a pad of hand-written delivery notes, and a driver who phones the office when a customer refuses
half a pallet or wants two extra cases. Nobody in the office knows where a van is or whether a
stop happened until the driver walks back in at 6pm with a fistful of cash, cheques and scribbled
amendments, and someone re-keys it all into the accounts package the next morning — by which time
the customer has already disputed the quantity. Cash collected at the door goes uncounted until
it is counted twice, short-picks are billed in full and credited later (or never), and there is
no defensible proof that anyone signed for age-restricted goods. RouteFlow's driver domain exists
to turn that day into a live, self-recording process: the van carries the manifest, records what
actually left it, and reconciles the money and the paperwork before the driver gets back.

## Why it matters to a tenant

The driver's phone becomes the system of record for the door, so the office stops re-keying: a
completed stop writes the delivery mutations, sets the order to DELIVERED, rebuilds the invoice
on the DELIVERED quantity (so a short-picked or refused line is never billed) and books the cash
as a real InvoicePayment against the right invoice, oldest-first, in one transaction
(`InvoicesService.recordDeliveryPaymentInTx`). Dispatch sees a driver's run change status in real
time (Socket.io `emitToDriver` / `emitDriverStatusUpdated`) plus a GPS breadcrumb no more than
five minutes old, so "where is my order" is answerable without ringing the van. Proof of delivery
— photo, signature, and the age/ID checks a regulated stop demands — is stored durably under
`tenants/<tenantId>/pod/...` and viewable on the run page, which is the difference between winning
and losing a delivery dispute or a compliance inspection. The on-time and stops-per-hour numbers
the analytics module derives per driver and per route give the owner the first objective view they
have ever had of who is actually productive.

## Core use cases

1. **Give the driver their day** — a driver opens the app and sees exactly one thing: today's
   assigned run, its stops in sequence, and what to hand over at each one — with the manifest /
   packing list they load the van from.
2. **Record what actually happened at the door** — per line: delivered, short, or refused; plus
   proof (photo, signature, note, age/ID where required). That capture is what re-bills the
   order, moves the stock and closes the stop — not a phone call to the office.
3. **Settle the money and hand the run back** — cash, cheque or on-account is taken at the door
   and lands as a real payment against the right invoice; at run end the driver reconciles what
   they physically hold and the run closes.

## Must have (P0)

| ID      | Capability                                                  | Status     | What it does                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ----------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DRV-M1  | Driver roster & login provisioning                          | SHIPPED ✅ | An operator adds a driver with contact details and vehicle, and the system mints a DRIVER login with a one-time temporary password the driver must change on first sign-in.                                                            | `POST /api/v1/drivers` → `apps/api/src/drivers/drivers.controller.ts:48`; `drivers.service.ts:146-183` (creates User with role DRIVER, `forcePasswordChange:true`, returns `{driver, tempPassword}`); web UI `apps/web/app/(dashboard)/drivers/page.tsx` + `AddDriverModal.tsx`; blocked at the guard by `apps/api/src/auth/guards/jwt-auth.guard.ts:15` until the password is changed.                                                                                                                                                                                                                                                                                                                |
| DRV-M2  | Assign a driver to a route and dispatch a run               | PARTIAL 🟡 | An operator dispatches a route (or ad-hoc trip) for a date, choosing the driver; the run and its stops are materialised and the driver is notified.                                                                                    | `POST /api/v1/route-runs` → `routes.service.ts:787` `createRun` (driver falls back to `Route.driverId`, row-locks the Route, 409s on a second active run); `PATCH /api/v1/route-runs/:id` reassigns (`routes.service.ts:1278`); notify at `:984-990` (spec-pinned `routes.service.spec.ts:623`). PARTIAL because `dto.driverId` is written straight to the run without a tenant check (`:841`, `:1299`) — `TripsService` does exactly this check and the dispatch path does not.                                                                                                                                                                                                                       |
| DRV-M3  | The driver's day view (my runs)                             | SHIPPED ✅ | The driver's home screen shows only their own SCHEDULED and IN_PROGRESS runs, stops in sequence, with next-stop, progress and an empty state when nothing is assigned.                                                                 | `GET /api/v1/route-runs/my-runs` → `routes.service.ts:2154` `findMyRuns` (filters `driverId` = own driver, statuses SCHEDULED/IN_PROGRESS); screen `apps/mobile/app/(driver)/route/index.tsx` ("No route assigned" empty state at `:538`); list query `apps/mobile/lib/api/routes.ts:108-128`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| DRV-M4  | Load-out manifest / packing list                            | PARTIAL 🟡 | Before departing, the driver (or warehouse) sees a consolidated pick list for the whole run and a per-stop breakdown of what each customer is owed.                                                                                    | `GET /api/v1/route-runs/:id/packing-list` → `routes.service.ts:2034`; mobile hook `usePackingList` (`apps/mobile/lib/api/routes.ts:139`). **verified:** the API and an OPERATOR screen exist, but the DRIVER app has no manifest screen — `usePackingList` has exactly one caller repo-wide, `apps/mobile/app/(operator)/route-runs/[id]/packing-list.tsx:11`. None of the driver tabs (route/map/orders/cash/driver-menu) route to a packing list, so the item's own promise is not shipped for the driver.                                                                                                                                                                                           |
| DRV-M5  | Start and close the run                                     | SHIPPED ✅ | The driver starts the run (stamping `startedAt`, beginning GPS sharing) and closes it only once every stop is completed or skipped.                                                                                                    | `PATCH /api/v1/route-runs/:id/status` → `routes.service.ts:1353` `updateRunStatus` (DRIVER restricted to IN_PROGRESS/COMPLETED at `:1357`; all-stops-done guard at `:1368`); GPS start/stop from `apps/mobile/app/(driver)/route/index.tsx:32,137` via `location-tracker.native.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| DRV-M6  | Record the delivery at a stop (delivered / short / refused) | BROKEN 🔴  | Per order line the driver confirms delivered, short or refused; the stop closes, orders go DELIVERED, delivery mutations are written and the invoice is rebuilt on the delivered quantity so short and refused lines are never billed. | `POST /api/v1/route-runs/:id/stops/:stopId/complete-with-payment` → `routes.service.ts:1814`; delivered-basis rebuild via `InvoicesService.recordDeliveryPaymentInTx`. BROKEN: the shipped mobile client sends `deliveries[].productId` (`apps/mobile/lib/api/routes.ts:249`) but `RunDeliveryDto` (`apps/api/src/routes/dto/complete-stop.dto.ts:18-23`) declares no `productId`, and the global pipe runs `forbidNonWhitelisted:true` (`main.ts:181-185`) — every at-door completion 400s. Register B148.                                                                                                                                                                                            |
| DRV-M7  | Proof of delivery capture (photo, signature, note)          | PARTIAL 🟡 | The driver captures a photo, a signature and a free-text note at the stop; they are stored durably against the stop and viewable by the office afterwards.                                                                             | `POST/GET .../pod-artifact` / `.../pod` → `routes.controller.ts:225,236`; schema `RouteRunStop.podPhotoUrls/signatureUrl`; office view `apps/web/app/(dashboard)/routes/[id]/page.tsx:231`. PARTIAL: the driver-side scratchpad is in-memory only (`apps/mobile/store/podStore.ts:31` — no persist middleware), so an app restart between capture and completion erases the capture (B136); attach failures are not surfaced (B111).                                                                                                                                                                                                                                                                   |
| DRV-M8  | At-door money collection recorded as a real payment         | PARTIAL 🟡 | Where the tenant allows it, the driver takes cash/cheque/card at the door for the delivered amount and it lands as an InvoicePayment against the right invoice; otherwise the stop closes on account and the office collects.          | `DriverPaymentsGuard` gates `payment.amount>0` on the `driver_payments` addon; server-side resolution in `InvoicesService.recordDeliveryPaymentInTx`. PARTIAL and money-critical: the amount shown to the driver is `fullOrderTotal` = Σ qty × unitPrice (`payment.tsx:70-75`) — the exact re-derivation CLAUDE.md forbids — so boxed lines over-charge by `unitsPerBox` and tax/discount/shipping are ignored (B49); cash above the server's delivered-basis total is dropped with a warn log (B83).                                                                                                                                                                                                  |
| DRV-M9  | A driver can only act on their own run                      | PARTIAL 🟡 | One driver must not be able to read, complete, price or take money against another driver's run.                                                                                                                                       | Ownership IS enforced on `findOneRun` (`:1195`), `updateRun` (`:1291`), `updateStopStatus` (`:1424`), `reopenStop` (`:2259`), the driver-scoped run list in `findAllRuns` (`:1053`), and driver order reads (`orders.service.ts:422-430`, F2-005). **verified:** it is NOT enforced on `completeStop` (`:1636`), `completeWithPayment` (`:1814`), `updateRunStatus` (restricts the status value, not the owner), `getRunPackingList` (`:2034`), `attachPodArtifact` (`:1553`) or `getStopPod` (`:1595`) — the only ForbiddenExceptions inside completion are the run-status checks, not ownership checks. Register B72.                                                                                |
| DRV-M10 | Skip a stop with a reason                                   | BROKEN 🔴  | A driver who cannot deliver (closed, nobody home, refused entry) marks the stop skipped with a note, so the run can still close and the office can see why.                                                                            | API exists: `PATCH /api/v1/route-runs/:id/stops/:stopId` accepts `{status:'SKIPPED', driverNote}` (`routes.controller.ts:243` → `routes.service.ts:1405`); SKIPPED counts as done for run completion (`:1373`). The mobile control does not call it — `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:334-344` confirms then only navigates back. Register B34.                                                                                                                                                                                                                                                                                                                                |
| DRV-M11 | Work offline and replay safely                              | PARTIAL 🟡 | Deliveries recorded in a dead-signal area are queued on the device and replayed automatically when signal returns, without double-charging anyone.                                                                                     | `apps/mobile/store/offlineQueue.ts` (zustand + AsyncStorage persist); replay in `useNetworkSync.ts` (drops after 3 retries, discards 4xx); idempotency-key preserved across replay (`api-client.ts:142-155`) against the server's IdempotencyKey table. PARTIAL: nothing calls `clearQueue` on sign-out, so a second driver on the same handset replays the previous driver's work under their token (B137); FormData mutations are never queued; reads are not cached, so the day view is blank offline.                                                                                                                                                                                              |
| DRV-M12 | Retire a driver without losing delivery history             | PARTIAL 🟡 | An operator can stand a driver down (deactivate) and eventually remove them, while every past run, delivery and POD stays attached to the record.                                                                                      | `DELETE /api/v1/drivers/:id` (`drivers.service.ts:257-299`) refuses while SCHEDULED/IN_PROGRESS runs exist, nulls Route/RouteRun/DeliveryMutation FKs to preserve history, and keeps a dual-role login while clearing `canActAsDriver`. **verified:** the web surface is further along than "no client can deactivate" — `apps/web/app/(dashboard)/drivers/page.tsx:298-312` filters by ACTIVE/INACTIVE with live counts (`:261-262`) and `AddDriverModal.tsx`/`EditDriverModal.tsx` exist — but the status _mutation_ is unwired: `useChangeDriverStatus` (`apps/web/lib/api/drivers.ts:102`) has zero callers, and `UpdateDriverDto` carries no status field, so delete remains the only exit (B36). |
| DRV-M13 | Driver GPS breadcrumb ingestion                             | SHIPPED ✅ | The driver's phone periodically posts its position so dispatch, the live map, tracking links and any future route replay have something to read from.                                                                                  | `POST /api/v1/drivers/me/location` — `apps/api/src/drivers/drivers.controller.ts:65-70` (`@Roles(DRIVER)`) → `DriversService.recordLocation` (`drivers.service.ts:93-118`) writing `DriverLocation` (`schema.prisma:919-938`) via a validated `PostLocationDto`; client `usePostDriverLocation` (`apps/mobile/lib/api/drivers.ts:144-150`) driven by `lib/location-tracker.native.ts`. Everything live-map, tracking-link and route-replay depends on this endpoint.                                                                                                                                                                                                                                   |

### Testing criteria

#### DRV-M1

- [ ] Creating a driver with an email already used in the tenant throws BadRequestException and no User or Driver row is written (transaction rolls back). `Jest (api)`
- [ ] The created User has role DRIVER and forcePasswordChange true, and the returned tempPassword is not the stored hash. `Jest (api)`
- [ ] With forcePasswordChange true, any request other than the change-password endpoint is rejected by JwtAuthGuard. `Jest (api)`
- [ ] A driver from tenant A never appears in GET /drivers for tenant B. `Playwright (web) / manual`

#### DRV-M2

- [ ] Dispatching a route that already has a SCHEDULED or IN_PROGRESS run throws ConflictException and creates no second run. `Jest (api)`
- [ ] POST /route-runs with a driverId belonging to another tenant must 404, not silently attach (currently fails). `Jest (api)`
- [ ] A DRIVER caller's createRun always resolves the run to their own driver row, ignoring any dto.driverId. `Jest (api)`
- [ ] A successful dispatch calls emitToDriver and sendToDriver exactly once with the run id; a dispatch with no driver calls neither. `Jest (api)`

#### DRV-M3

- [ ] my-runs for a user with no Driver row returns an empty page, never a 500. `Jest (api)`
- [ ] A run assigned to another driver in the same tenant never appears in my-runs. `Jest (api)`
- [ ] COMPLETED and CANCELLED runs are excluded from my-runs. `Jest (api)`
- [ ] With zero assigned runs the screen shows the empty state and the ad-hoc order affordance, not a spinner. `Manual (mobile)`

#### DRV-M4

- [ ] A CANCELLED order on a stop contributes zero quantity to the packing list. `Jest (api)`
- [ ] The per-product total equals the sum of that product's per-customer quantities on the same list. `Jest (api)`
- [ ] A run whose stops carry no direct customer link still resolves customer names via routeStop fallback. `Jest (api)`
- [ ] getRunPackingList on an unknown run id throws NotFoundException. `Jest (api, negative)`

#### DRV-M5

- [ ] COMPLETED with one PENDING stop throws BadRequestException naming the count, and the run status is unchanged. `Jest (api)`
- [ ] A DRIVER attempting to set CANCELLED gets ForbiddenException. `Jest (api)`
- [ ] The second IN_PROGRESS transition does not overwrite an existing startedAt. `Jest (api)`
- [ ] Completing the run emits emitDriverStatusUpdated with the driver id and new status. `Jest (api)`

#### DRV-M6

- [ ] A CompleteWithPaymentDto body carrying deliveries[].productId validates without error (currently fails — this is the break). `Jest (api, DTO)`
- [ ] A stop with one line REFUSED and one PARTIAL rebuilds the order's open draft so invoice total equals the sum of prorated line subtotals, rounded to cents. `Jest (api)`
- [ ] Completing a stop on a run whose status is SCHEDULED throws ForbiddenException naming the current status. `Jest (api)`
- [ ] The same idempotency-key replayed returns the cached response and writes no second DeliveryMutation or InvoicePayment. `Jest (api, idempotency)`
- [ ] After a partial delivery, Σ of the order's non-VOID invoice line subtotals equals Σ prorateLineSubtotal for the same lines. `Jest (api, invariant)`

#### DRV-M7

- [ ] A base64 data URL is parsed and stored under tenants/<tenantId>/pod/<stopId>/, and the persisted value is a storage key, not a data URL. `Jest (api)`
- [ ] The same artifactId posted twice appends exactly one entry to podPhotoUrls. `Jest (api)`
- [ ] GET .../pod refuses to presign a POD key whose tenant prefix is not the caller's tenant. `Jest (api, tenant isolation)`
- [ ] A legacy 'file://' or 'native-captured' string passes through unchanged and is reported as legacyPhotoCount. `Jest (api, legacy)`
- [ ] Capture a photo and signature, force-quit the app, reopen the stop — the capture must still be there (currently fails). `Manual (mobile)`

#### DRV-M8

- [ ] With the driver_payments addon absent, a completion carrying payment.amount 25 is 403'd; the identical completion with no payment succeeds. `Jest (api)`
- [ ] Σ of the InvoicePayment rows written by one completion equals the amount posted, rounded to cents, and no invoice is paid beyond its remaining balance. `Jest (api, invariant)`
- [ ] A VOID or WRITTEN_OFF invoice is never selected to absorb at-door cash. `Jest (api)`
- [ ] For a boxed line (unitsPerBox 12, ordered 2 boxes, stored subtotal 60.00) the amount presented equals 60.00, not qty*unitPrice (currently fails). `Jest (mobile, pure)`
- [ ] A client-side rule blocks CASH/CHECK/CREDIT_CARD with amount 0 (server-side, amount<=0 silently returns `{applied:0}`, not a 400). `Jest (mobile)`

#### DRV-M9

- [ ] Driver B calling complete-with-payment on a stop of driver A's run must get ForbiddenException and write no DeliveryMutation and no InvoicePayment (currently succeeds). `Jest (api)`
- [ ] Driver B calling PATCH /route-runs/:id/status on driver A's run must be forbidden. `Jest (api)`
- [ ] Driver B calling GET /route-runs/:id/packing-list on driver A's run must be forbidden. `Jest (api)`
- [ ] An OPERATOR retains access to every run in their own tenant on all of the above. `Jest (api)`

#### DRV-M10

- [ ] Tapping 'Skip stop' and confirming issues PATCH /route-runs/:runId/stops/:stopId with status SKIPPED (currently issues nothing). `Manual/Jest (mobile)`
- [ ] A SKIPPED stop does not block PATCH /route-runs/:id/status → COMPLETED. `Jest (api)`
- [ ] A skip with a driverNote persists the note on RouteRunStop.driverNote and leaves completedAt null. `Jest (api)`
- [ ] Skipping a stop already COMPLETED must not silently reopen it. `Jest (api, negative)`

#### DRV-M11

- [ ] A network error on a POST enqueues exactly one action carrying the original idempotency-key header. `Jest (mobile)`
- [ ] A queued action returning 4xx on replay is dequeued; a 5xx is retried up to 3 times then dropped. `Jest (mobile)`
- [ ] Sign-out clears the persisted queue so a subsequent session replays nothing (currently fails). `Jest (mobile)`
- [ ] Replaying a queued completion whose original response was lost returns the cached response and writes no second payment. `Jest (api)`
- [ ] With the device in airplane mode the driver can still see today's stops (currently fails). `Manual (mobile)`

#### DRV-M12

- [ ] Deleting a driver with an IN_PROGRESS run throws BadRequestException and nothing is deleted. `Jest (api)`
- [ ] After deletion, the driver's historical RouteRun rows still exist with driverId null. `Jest (api)`
- [ ] Deleting the driver profile of a TENANT_ADMIN keeps the User row and sets canActAsDriver false. `Jest (api)`
- [ ] The driver detail page offers a Deactivate control that flips status to INACTIVE and removes the driver from the dispatch assignment picker (currently missing). `Playwright (web)`

#### DRV-M13

- [ ] Posting a location update writes a DriverLocation row scoped to the caller's own driver id and tenant. `Jest (api)`
- [ ] A location payload with an out-of-range lat/lng is rejected by PostLocationDto validation. `Jest (api)`
- [ ] A non-DRIVER role posting to /drivers/me/location is forbidden. `Jest (api)`

## Nice to have (P1)

| ID      | Capability                                                        | Status     | What it does                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DRV-N1  | Live fleet map for dispatch                                       | PARTIAL 🟡 | The office watches vans move on a map, with each driver's last position, speed and next stop.                                                                         | `GET /api/v1/routes/live` → `routes.service.ts:709` (IN_PROGRESS runs + latest DriverLocation within a hardcoded 5-minute window). Consumed only by mobile `apps/mobile/app/(operator)/fleet.tsx:36`; no web consumer, so the desktop dashboard has no live map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DRV-N2  | Driver ↔ dispatch run chat                                        | SHIPPED ✅ | The driver and the office message each other inside the run, so instructions and exceptions stay attached to the job.                                                 | `apps/api/src/messages/` — driver↔operator chat scoped to channel INTERNAL; `assertRunChatParticipant` gates both read and write; mobile entry `apps/mobile/app/(driver)/driver-messages.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DRV-N3  | Push + realtime notification on dispatch                          | SHIPPED ✅ | When a run is dispatched to a driver their phone is told immediately.                                                                                                 | `routes.service.ts:984-990` — `gateway.emitToDriver` then `notifications.sendToDriver`; push resolution at `notifications.service.ts:154-166`. Spec-pinned `routes.service.spec.ts:623,655`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DRV-N4  | Reopen a completed stop                                           | SHIPPED ✅ | A stop closed by mistake can be reopened, reversing the deliveries and the stock effect cleanly.                                                                      | `POST .../stops/:stopId/reopen` → `routes.service.ts:2236` — refuses on a CANCELLED run or a non-COMPLETED/SKIPPED stop, enforces driver ownership, reverses deliveries with a compensating positive-qty SALE at the original unitCost. **verified:** a working operator UI exists too — `apps/mobile/app/(operator)/route-runs/[id].tsx:185-202` (confirm dialog) and `:462` (per-stop Reopen button) via `useReopenStop`.                                                                                                                                                                                                                                                                                                                                            |
| DRV-N5  | Regulated age / ID verification at the door                       | SHIPPED ✅ | For stops with age- or ID-restricted goods, the driver must capture a signature, tick the age check, confirm the ID and record the ID type before the stop can close. | Schema `RouteRunStop.ageCheckRequired/identityCheckRequired/ageVerified/identityVerified/identityType`; server ladder `apps/api/src/common/regulated-delivery.ts`, called from both completion paths; client pre-check `pod-gating.ts` (explicitly non-authoritative).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DRV-N6  | Edit the order at the door (direct edit)                          | SHIPPED ✅ | The driver adds, changes or removes lines on the stop's order without wiping the untouched lines or their invoiced history.                                           | `edit-items.tsx` reuses the operator screen, building an incremental diff sent with `replaceAll:false`; diff logic `order-item-diff.ts`. **verified:** server-side protection is stronger than a client convention — `orders.service.ts:2866` forces `replaceAll=false` for `UserRole.DRIVER` regardless of the client payload, and `:2568-2572` rejects a diff-shaped CUSTOMER payload outright; the historic replace-all data-loss hazard is closed server-side, not merely avoided by the client.                                                                                                                                                                                                                                                                   |
| DRV-N7  | At-door change requests (needs office approval)                   | SHIPPED ✅ | When the direct edit window has closed, the driver raises ADD_ITEM / CHANGE_QTY / REMOVE_ITEM / NOTE requests that the office approves or declines.                   | `ChangeRequest` model; `POST /orders/:id/change-requests` (409 EDIT_WINDOW_OPEN while direct edit is still legal); driver screen `adjust.tsx`; diff builder `at-door-diff.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DRV-N8  | Take a new order at the door                                      | SHIPPED ✅ | A customer who wants extra stock while the van is there gets a fresh order raised on the spot, auto-linked to the run and stop.                                       | `new-order.tsx` wraps `NewOrderScreen` with customerId/runId/stopId from the stop; free-standing variant `driver-new-order.tsx` reachable from the empty-route state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DRV-N9  | Driver-filed returns and refusals                                 | PARTIAL 🟡 | Goods coming back on the van — damaged, expired, refused — are filed as a return against the customer from the stop screen.                                           | `route/stop/[stopId]/return/index.tsx` → `useCreateReturn`; `Return`/`ReturnItem` models. PARTIAL: the screen files the DELIVERED quantity, so a REFUSED line files qty 0 (400) and a short delivery credits goods the customer kept (B128); a Damaged/Expired return still restocks into sellable inventory (B61).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DRV-N10 | Split the stop into multiple invoices                             | SHIPPED ✅ | A stop can be invoiced as two or more documents before completion.                                                                                                    | `split-invoice.tsx`; backed by the invoices split machinery; the auto-invoice on stop completion sees fully-invoiced items and skips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DRV-N11 | End-of-run cash settlement                                        | PARTIAL 🟡 | Before closing the run the driver counts the cash and cheques they hold, the app shows the expected figure and the variance, and a variance needs a reason.           | `settlement.tsx` + `run-settlement.ts` (`summarizeCollections`, `computeVariance`, `isReconciled` at ±$0.01). PARTIAL: the expected figure is a RAM-only device tally (`runSettlementStore.ts:20`, deliberately non-persisted, B152), and the outcome is appended to `RouteRun.notes`, which no screen renders after the run closes (B167). No server-side "payments collected on run X" aggregate exists.                                                                                                                                                                                                                                                                                                                                                             |
| DRV-N12 | Driver performance metrics for the office                         | PARTIAL 🟡 | The operator sees, per driver and per route, how many runs completed, on-time rate, stops per hour and average run duration over a chosen date window.                | `GET /analytics/driver-performance` and `/route-performance` — on-time = `stop.completedAt <= end of the run's scheduledDate UTC day` (`analytics.service.ts:336-342`); ratios null (never 0/NaN) on an empty window. **verified:** the office side is richer than credited — `GET /drivers/:id/history` (`drivers.controller.ts:98` → `drivers.service.ts:229-246`) renders a paginated run history on `apps/web/.../drivers/[id]/page.tsx:117`. The driver side is emptier than credited too: `getMyStats` (`routes.service.ts:2202-2234`) hardcodes `onTimeDeliveryPct:100`/`returnsRate:0`, but `useDriverStats`/`useDriverHistory` (`apps/mobile/lib/api/routes.ts:149,167`) have zero callers — the fabricated number is currently rendered on no driver screen. |
| DRV-N13 | Navigation handoff and re-optimisation from the driver's position | SHIPPED ✅ | The driver opens the whole run in Google Maps, or re-optimises the remaining stops starting from where they actually are.                                             | `route/index.tsx` — `buildRunMapPoints` assembles `[depot, ...stops, end]`; `openRouteInMaps` imported from `apps/mobile/components/openInMaps`; "Optimize from my current location" toggle driving `useOptimizeRouteRun` against `POST /route-runs/:id/optimize`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| DRV-N14 | Driver home base as a trip origin                                 | SHIPPED ✅ | A driver who starts from home rather than the depot has their address geocoded once and used as the origin when the office plans an ad-hoc trip for them.             | `Driver.homeLat/homeLng/homeAddress`; composed and best-effort geocoded on `PATCH /drivers/:id` (`drivers.service.ts:185-221` — a geocode failure clears coords to null rather than throwing); consumed by `TripsService.resolveOrigin`'s DRIVER tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DRV-N15 | Driver self-service profile and password                          | SHIPPED ✅ | The driver maintains their own contact/vehicle details and changes their password from inside the app.                                                                | `GET/PATCH /api/v1/drivers/me` → `findByUserId`/`updateByUserId`; screens `driver-profile.tsx` and `driver-change-password.tsx`, reachable from `driver-menu.tsx:50-63`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DRV-N16 | Operator per-driver run history                                   | SHIPPED ✅ | The office pulls up a paginated list of a driver's past runs (route name, stop count) as the practical "what has this driver done" surface.                           | `GET /api/v1/drivers/:id/history` — `drivers.controller.ts:98-107` → `drivers.service.ts:229-246`; rendered on `apps/web/app/(dashboard)/drivers/[id]/page.tsx:117` via `useDriverHistory` (`apps/web/lib/api/drivers.ts:119`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DRV-N17 | Driver "My orders" tab                                            | SHIPPED ✅ | A searchable, status-filtered list of the driver's own orders (Active / Confirmed / Delivered / All).                                                                 | `apps/mobile/app/(driver)/orders.tsx`, a driver tab (`(driver)/_layout.tsx:56-64`) backed by `useMyOrders` (`apps/mobile/lib/api/orders.ts:210`) against `GET /api/v1/orders`, with driver read scoping enforced server-side (`orders.service.ts:422-430`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DRV-N18 | In-app driver run map                                             | SHIPPED ✅ | A driver tab shows the device's live position, every stop pinned and coloured by status with the current stop highlighted, and the run polyline.                      | `apps/mobile/app/(driver)/map.tsx`, a driver tab (`(driver)/_layout.tsx:47-55`) using `Location.watchPositionAsync` (`:38-41`) and per-stop status pins (`:66-82`) via `components/MapView`. Distinct from both the Google Maps handoff (DRV-N13) and the operator fleet map (DRV-N1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DRV-N19 | Operator run-detail console and stop resequencing                 | SHIPPED ✅ | The office-side counterpart of the driver day: a per-run detail console with reopen controls, plus manual drag-resequencing of a live run's stops.                    | `apps/mobile/app/(operator)/route-runs/[id].tsx` (reopen at `:185-202,:462`) and `.../[id]/packing-list.tsx`; `PATCH /api/v1/route-runs/:id/stops/reorder` (`routes.controller.ts:255-263` → `routes.service.ts:576` `reorderRunStops`, OPERATOR-only), which sets `RouteRun.manuallyReordered`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DRV-N20 | Operator-who-drives role switching                                | SHIPPED ✅ | An OPERATOR or TENANT_ADMIN with driving permission can work inside the driver app for a shift and switch back to the office view without a second login.             | `apps/mobile/app/(driver)/driver-menu.tsx:64-78` renders "Switch role — Go to operator view" only for dual-role users; `drivers.service.ts:284-295` deliberately preserves the dual-role login on driver-profile delete (clears `canActAsDriver` instead of removing the User).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Testing criteria

#### DRV-N1

- [ ] A run whose driver last pinged 6 minutes ago returns latestLocation null rather than a stale pin. `Jest (api)`
- [ ] nextStopIndex points at the first PENDING or IN_PROGRESS stop, and equals stops.length when all are done. `Jest (api)`
- [ ] routes/live never returns a run from another tenant. `Jest (api)`
- [ ] A dispatcher on /dispatch can see at least one live vehicle marker for an IN_PROGRESS run (currently missing on web). `Playwright (web)`

#### DRV-N2

- [ ] A DRIVER reading a run thread they are not assigned to gets Forbidden. `Jest (api)`
- [ ] A CUSTOMER can neither read nor post into an INTERNAL run thread. `Jest (api)`
- [ ] A findByRun with no runId returns only INTERNAL messages the caller is entitled to. `Jest (api)`
- [ ] A message sent by dispatch appears on the driver's thread without a manual refresh. `Manual (mobile)`

#### DRV-N3

- [ ] Dispatching to a driver calls emitToDriver once with that driverId; dispatching with no driver calls it zero times. `Jest (api)`
- [ ] A push-send failure does not roll back or fail the dispatch. `Jest (api)`
- [ ] sendToDriver on a driver with no linked user id returns without throwing. `Jest (api)`
- [ ] The notification payload deep-links to the run, not to the app root. `Manual`

#### DRV-N4

- [ ] After complete-then-reopen, Σ of the product's StockMovement rows for that stop nets to 0. `Jest (api, stock invariant)`
- [ ] The compensating movement carries the original unitCost so Σ signed COGS is 0. `Jest (api, money invariant)`
- [ ] Reopening a PENDING stop throws BadRequestException. `Jest (api, negative)`
- [ ] A driver reopening another driver's stop is forbidden. `Jest (api)`

#### DRV-N5

- [ ] A stop whose order contains an age-restricted product cannot complete without ageVerified true. `Jest (api)`
- [ ] The requirement is derived from the DB — a client sending ageCheckRequired:false is still blocked. `Jest (api)`
- [ ] identityVerifiedAt is stamped server-side and a client-supplied value is ignored. `Jest (api)`
- [ ] Delivering a regulated orderItem via a stop that is not the item's own stop still triggers the gate. `Jest (api, cross-stop bypass)`
- [ ] The four failure messages fire in the documented order and a non-regulated stop returns null. `Jest (mobile)`

#### DRV-N6

- [ ] Editing one line of a five-line order emits exactly one operation, and untouched line ids are absent from the payload. `Jest (mobile)`
- [ ] The request body always carries replaceAll:false, including for an add-only edit. `Jest (mobile)`
- [ ] An id-less-only items array with replaceAll:false appends and leaves existing lines intact. `Jest (api)`
- [ ] A driver edit uses list pricing and cannot set a below-list unitPrice. `Jest (api)`
- [ ] A DRIVER-role request with replaceAll:true in the body still resolves to replaceAll:false server-side. `Jest (api)`

#### DRV-N7

- [ ] A line whose deliveredQty > 0 never produces a change request even if the caller passes an edited qty. `Jest (mobile)`
- [ ] An edited qty of 0 produces REMOVE_ITEM; any other changed value produces CHANGE_QTY with the absolute new qty. `Jest (mobile)`
- [ ] Posting a change request while the direct edit window is open returns 409 EDIT_WINDOW_OPEN. `Jest (api)`
- [ ] Approving an ADD_ITEM that breaches the customer's credit limit is rejected and leaves the order untouched. `Jest (api)`

#### DRV-N8

- [ ] An order created from a stop carries routeRunId and routeRunStopId. `Manual/Jest (mobile)`
- [ ] A DRIVER creating an order cannot set a discounted unitPrice. `Jest (api)`
- [ ] A boxed line entered at the door prices via computeLineSubtotal, rounded to cents. `Jest (api, boxed money)`
- [ ] The new order appears on the stop without leaving the stop screen. `Manual (mobile)`

#### DRV-N9

- [ ] A REFUSED mutation maps to the REFUSED quantity, not the delivered quantity (currently fails). `Jest (mobile, pure)`
- [ ] A return with reason DAMAGED or EXPIRED must not increase sellable on-hand. `Jest (api, stock invariant)`
- [ ] The resulting credit note's total equals Σ returned qty × the original invoiced line rate, rounded to cents. `Jest (api, money invariant)`
- [ ] Creating a return with qty 0 is rejected with a clear message. `Jest (api, negative)`

#### DRV-N10

- [ ] Σ of the sibling invoice totals equals the order total (tax remainder to the largest group), rounded to cents. `Jest (api, money invariant)`
- [ ] After a split, completing the stop does not create a third invoice for the same lines. `Jest (api)`
- [ ] The delivered-basis rebuild bails rather than double-billing when a line is billed by two open drafts. `Jest (api)`
- [ ] A split with one empty group is rejected before submission. `Manual (mobile)`

#### DRV-N11

- [ ] cashTotal sums only CASH and CHECK; card/Zelle/account are excluded. `Jest (mobile)`
- [ ] Variance of exactly -0.01 and +0.01 reconcile; -0.02 does not and demands a reason. `Jest (mobile)`
- [ ] The note renders the sign before the '$' and is appended exactly once even when the status write is retried. `Jest (mobile)`
- [ ] An operator can retrieve the total collected against a run from the server, independent of the device (currently no endpoint). `Jest/API (gap)`

#### DRV-N12

- [ ] A stop completed at 23:59:59Z on the scheduled day counts on-time; 00:00:01Z the next day counts late. `Jest (api)`
- [ ] A stop never completed is excluded from both the on-time numerator and denominator. `Jest (api)`
- [ ] A run missing startedAt or completedAt is excluded from stopsPerHour's numerator and denominator. `Jest (api)`
- [ ] Calling with no from/to preserves all-time behaviour. `Jest (api)`
- [ ] GET /route-runs/my-stats returns a computed on-time percentage, not the literal 100 (currently fails). `Jest (api)`

#### DRV-N13

- [ ] A stop with no captured coordinates is skipped from the maps point list without breaking the sequence of the rest. `Jest (mobile, pure)`
- [ ] With endKind NONE, no end point is appended. `Jest (mobile)`
- [ ] Denying location permission still allows 'Open in Google Maps' from the depot; only the 'from my current location' variant degrades. `Manual (mobile)`
- [ ] Re-optimising an IN_PROGRESS run does not renumber already-completed stops. `Jest (api)`

#### DRV-N14

- [ ] A successful geocode writes homeLat/homeLng; a failing geocode writes nulls and the save still succeeds. `Jest (api)`
- [ ] An update carrying no home* field never calls the geocoder and never touches homeAddress. `Jest (api)`
- [ ] Sending only homeCity rewrites homeAddress from the fields present. `Jest (api)`
- [ ] Planning a DRIVER-origin trip for a driver with no coords 400s naming that driver, and creates no Route. `Jest (api)`

#### DRV-N15

- [ ] GET /drivers/me for a user with no Driver row returns 404 with a clear message. `Jest (api)`
- [ ] PATCH /drivers/me can only ever modify the caller's own Driver row. `Jest (api)`
- [ ] A driver cannot change their own status via PATCH /drivers/me. `Jest (api)`
- [ ] After a forced first-login password change the driver lands on the route screen, not the login screen. `Manual (mobile)`

#### DRV-N16

- [ ] The history endpoint paginates and never returns another tenant's runs. `Jest (api)`
- [ ] A driver with zero runs returns an empty page, not a 500. `Jest (api)`
- [ ] The page renders route name and stop count per row. `Playwright (web)`

#### DRV-N17

- [ ] The status filter (Active/Confirmed/Delivered/All) narrows results to only that server-side status. `Jest (mobile)`
- [ ] A DRIVER's order list never includes another driver's orders. `Jest (api)`
- [ ] Search matches by customer name or order number. `Manual (mobile)`

#### DRV-N18

- [ ] Denying location permission degrades to a visible message rather than a crash. `Manual (mobile)`
- [ ] Stop pin colour matches the stop's current status (pending/in-progress/completed/skipped). `Manual (mobile)`
- [ ] The polyline reflects the run's actual stop order, including after a re-optimise. `Manual (mobile)`

#### DRV-N19

- [ ] Reorder persists the new sequence and sets RouteRun.manuallyReordered true. `Jest (api)`
- [ ] Reordering a run that is not SCHEDULED/IN_PROGRESS is rejected. `Jest (api)`
- [ ] A DRIVER caller cannot call the reorder endpoint (OPERATOR-only). `Jest (api)`

#### DRV-N20

- [ ] Switch role is visible only when canActAsDriver is true. `Manual (mobile)`
- [ ] Switching to operator view and back preserves the in-progress run's state. `Manual (mobile)`
- [ ] Deleting the driver profile of a dual-role user keeps the User row and clears canActAsDriver. `Jest (api)`

## Advanced / future (P2)

| ID      | Capability                                                     | Status     | What it does                                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DRV-A1  | Customer-facing live ETA and tracking link                     | PARTIAL 🟡 | The buyer gets a tracking page showing how many stops away the van is and an estimated arrival, without phoning the office.                                                      | `GET /orders/:id/tracking` exists and the buyer portal renders it, fed by `DriverLocation` + `getLiveRoutes`. Incomplete: `stopsAhead` skips the stop currently being worked, undercounting by one (B176); there is no promised-ETA field anywhere in the schema, so no arrival time can be quoted or measured against.                                                                                                                                                                                                                                                                        |
| DRV-A2  | Promised delivery windows and window-based on-time measurement | MISSING ⬜ | Each stop carries a promised window; on-time is measured against that window, and dispatch warns when a plan cannot hit it.                                                      | No `eta`/`promisedAt`/window field on `RouteRunStop`. `Customer.deliveryWindowStart/End` exist and are surfaced on the packing list but nothing enforces or measures against them. On-time is hardcoded as "completed by end of the run's scheduledDate UTC day".                                                                                                                                                                                                                                                                                                                              |
| DRV-A3  | Driver compensation — per-stop, per-mile or commission pay     | MISSING ⬜ | The driver's pay for the day is derived from what they actually did and flows into payroll or an expense.                                                                        | Nothing in the schema pays a driver. `SalesAgent`/`CommissionAccrual`/`CommissionPayout` model commission for sales agents only, keyed on customer assignment — no Driver linkage. Note: the `driver_payments` addon is permission to _collect_ money at the door, not a way to _pay_ a driver.                                                                                                                                                                                                                                                                                                |
| DRV-A4  | Mileage and vehicle expense capture                            | PARTIAL 🟡 | Start/end odometer per run rolls into a mileage claim or a vehicle-cost line, so the cost of delivery is known per route.                                                        | **verified:** the expense side ships end-to-end — `Expense.isMileage/mileageUnit/distance/mileageRateSnapshot` (`schema.prisma:2079-2084`) and `MileageRate` (`:2132`), consumed by `apps/api/src/bookkeeping/*` and `apps/web/app/(dashboard)/finance/expenses/new/page.tsx`. Only the driver-side capture is dead: `apps/mobile/store/mileageStore.ts` has zero consumers, no driver screen captures an odometer reading, and no endpoint accepts run mileage.                                                                                                                               |
| DRV-A5  | Geofenced auto-arrive and auto-depart                          | MISSING ⬜ | Arrival and departure timestamps are captured from the GPS fence rather than the driver remembering to tap.                                                                      | `arrivedAt` is only ever set by an explicit PATCH to status IN_PROGRESS; there is no `departedAt` field on `RouteRunStop`, and the location task posts breadcrumbs with no geofence evaluation.                                                                                                                                                                                                                                                                                                                                                                                                |
| DRV-A6  | Route replay and geo-verified proof of delivery                | PARTIAL 🟡 | The office replays a van's actual path for a disputed day, and each POD carries the coordinates it was captured at.                                                              | The breadcrumbs exist (`DriverLocation` with a `[tenantId, runId, recordedAt]` index) but nothing reads them historically: `getLiveRoutes` only queries the last 5 minutes, there is no replay UI, POD artifacts carry no coordinates, and there is no retention job so the table grows unbounded (B184).                                                                                                                                                                                                                                                                                      |
| DRV-A7  | Barcode-verified van load-out                                  | MISSING ⬜ | The driver scans cases onto the van against the run's packing list, so a missing case is caught at the depot rather than at the customer's door.                                 | The scanning stack exists (`barcode-resolve.ts`, `scan-ladder.ts`, `wedge-scan.ts`) and the manifest exists, but no driver screen joins them — `apps/mobile/app/(driver)/` has no load-out or scan screen and there is no loaded/verified state on RouteRun or RouteRunStop.                                                                                                                                                                                                                                                                                                                   |
| DRV-A8  | Driver document and compliance vault                           | MISSING ⬜ | Licence, insurance, vehicle inspection and their expiry dates live on the driver record, and an expiring document warns dispatch before it blocks a run.                         | The `Driver` model carries only contact and vehicle description fields — no licence number, no expiry, no document relation. The mobile client type declares a `licenseNumber` the API never returns (client/server drift).                                                                                                                                                                                                                                                                                                                                                                    |
| DRV-A9  | Shift clock, hours and break tracking                          | MISSING ⬜ | The driver clocks on and off; hours worked and breaks are recorded for payroll and duty-hours compliance.                                                                        | The only time signals are `RouteRun.startedAt/completedAt` — a proxy for a run, not a shift. No shift, break, or duty model exists anywhere, and no driver screen offers a clock.                                                                                                                                                                                                                                                                                                                                                                                                              |
| DRV-A10 | Offline-first day cache (read path)                            | MISSING ⬜ | The whole day — stops, customers, order lines, prices — is cached on the device at run start, so a driver in a signal blackspot can still work the entire route.                 | Only mutations are queued. Every read goes through TanStack Query with no persisted cache — no `persistQueryClient`/AsyncStorage persister anywhere in the mobile app — so with no signal the day view, stop detail and prices are unavailable.                                                                                                                                                                                                                                                                                                                                                |
| DRV-A11 | Multi-driver runs, helpers and mid-run handover                | MISSING ⬜ | Two people on a van, or a run handed to a relief driver halfway through, without losing the completed half.                                                                      | `RouteRun.driverId` is a single nullable FK. Reassigning mid-run is a silent overwrite with no handover record and no attribution split — completed stops keep the original driverId while the run header now names someone else.                                                                                                                                                                                                                                                                                                                                                              |
| DRV-A12 | Driver scorecard with coaching and exception triage            | MISSING ⬜ | A weekly per-driver scorecard — on-time, damage rate, short-pick rate, cash variance, POD completeness — with the outliers surfaced for a conversation.                          | The ingredients exist separately (on-time/stops-per-hour, returns, device-only cash variance, POD) but nothing composes them: no scorecard endpoint, and the per-driver page renders only completedRuns/totalRuns.                                                                                                                                                                                                                                                                                                                                                                             |
| DRV-A13 | Per-stop delivery batch / delivery note object                 | MISSING ⬜ | A modelled per-stop delivery note linking the customer, stop, driver and the invoices/mutations it produced — the shape a formal proof-of-delivery document would be built from. | `model DeliveryBatch` (`schema.prisma:1540-1560`) links customerId + routeRunStopId + driverId + deliveredAt to DeliveryMutation[] and Invoice[], and `Invoice.deliveryBatchId` is load-bearing in the invoicing engine (`invoices.service.ts:1263,1524,1533,1640,3352,3919` — the flag meaning "this invoice is a delivered-batch bill, leave it alone"). No code path anywhere creates one (`deliveryBatch.create` has zero call sites), so the flag is permanently null and the object is dead — modelled but never written, the same shape as the AI-metering entitlement with no granter. |

### Testing criteria

#### DRV-A1

- [ ] stopsAhead counts the IN_PROGRESS stop, so a van working stop 3 of 6 reports 3 remaining, not 2.
- [ ] A tracking token for one tenant's order never resolves against another tenant's run.
- [ ] A run with no recent location returns "position unknown" rather than a stale pin.
- [ ] An ETA is derived from remaining stops and historical stops-per-hour (currently no ETA exists at all).

#### DRV-A2

- [ ] A stop completed inside its promised window counts on-time; one completed 5 minutes after counts late (currently unmeasurable).
- [ ] A run plan whose projected arrival exceeds a stop's window surfaces a warning at dispatch time.
- [ ] The on-time bar is tenant-configurable (window vs end-of-day) rather than compiled in.
- [ ] Existing tenants with no window configured keep today's end-of-day semantics.

#### DRV-A3

- [ ] Given a completed run of 12 stops and 84 miles, a pay accrual is produced by the configured scheme and is idempotent across a re-run.
- [ ] Reopening a stop reverses its pay accrual so Σ accruals matches Σ completed stops.
- [ ] A payout books to a P&L expense category, mirroring the CommissionPayout precedent.
- [ ] A driver's pay rows are never visible to another tenant.

#### DRV-A4

- [ ] Given start and end odometer for a run, distance = end − start, floored at 0, and a negative entry is rejected at input.
- [ ] The claim values at the MileageRate effective on the run's scheduledDate, not today's rate.
- [ ] The resulting expense amount equals distance × ratePerUnit, rounded to cents.
- [ ] The reading survives an app restart (server-persisted, unlike today's dead device store).

#### DRV-A5

- [ ] Entering a 100m fence around the stop address auto-stamps arrivedAt once; re-entering does not re-stamp.
- [ ] Leaving the fence after a completion stamps departedAt; dwell is never negative.
- [ ] With location permission denied the manual tap path still works unchanged.
- [ ] A stop with no geocoded address is excluded from geofencing rather than mis-firing on a null coordinate.

#### DRV-A6

- [ ] A completed run returns its ordered breadcrumb trail for the run window, paginated, and never another tenant's points.
- [ ] A POD artifact records the lat/lng and accuracy at capture time; a capture with no fix is stored and flagged, not rejected.
- [ ] A retention policy prunes breadcrumbs older than the configured horizon and the pruning is idempotent.
- [ ] Replay of a run with zero breadcrumbs renders an honest empty state, not a blank map.

#### DRV-A7

- [ ] Scanning every SKU on the manifest marks the run load-verified; a missing SKU blocks (or explicitly overrides with a reason).
- [ ] An over-scan is flagged rather than silently accepted.
- [ ] A run cannot be started as load-verified twice.
- [ ] Load-out moves nothing on its own — on-hand only changes at delivery.

#### DRV-A8

- [ ] A driver whose licence expires within the warning horizon appears in a dispatch warning list.
- [ ] Assigning a run to a driver with an expired mandatory document is blocked or requires an audited override.
- [ ] Documents are stored via the same tenant-pinned signed-URL path as customer documents.
- [ ] Removing a driver retains their documents for the statutory retention period rather than hard-deleting.

#### DRV-A9

- [ ] Clock-on then clock-off yields a shift whose duration equals the difference, and an unclosed shift is surfaced rather than silently open forever.
- [ ] Overlapping shifts for one driver are rejected.
- [ ] A shift spanning midnight is attributed correctly to the configured business day.
- [ ] Hours reported per driver reconcile with the sum of their shifts for the period.

#### DRV-A10

- [ ] With the device offline from app launch, the assigned run, its stops and each stop's order lines render from cache.
- [ ] A price or line changed by the office while the driver was offline is reconciled on reconnect, and the driver is told which stop changed.
- [ ] A stale cache older than the configured horizon refuses to be used for money-bearing screens.
- [ ] Cache is cleared on sign-out so the next driver on the handset sees nothing of the previous one.

#### DRV-A11

- [ ] After a handover, the completed stops remain attributed to the original driver and the remaining stops to the new one.
- [ ] Both drivers' performance metrics sum to the run's totals — no stop is counted twice or lost.
- [ ] The outgoing driver's app stops showing the run and stops sharing GPS for it.
- [ ] A handover on a run with cash collected records who holds the money.

#### DRV-A12

- [ ] A scorecard for a period returns each metric plus the tenant cohort median, and a driver with no runs in the period returns nulls rather than zeros.
- [ ] Cash variance on the scorecard comes from a server aggregate, not a device tally (blocked on DRV-N11's missing endpoint).
- [ ] Ranking is stable and tenant-scoped — another tenant's drivers never enter the cohort.
- [ ] The scorecard reconciles with analytics/driver-performance for the same window.

#### DRV-A13

- [ ] Completing a stop creates exactly one DeliveryBatch linking the stop's mutations and resulting invoice(s).
- [ ] Invoice.deliveryBatchId is set only via this write path, never left to drift null on a delivered invoice.
- [ ] A reopened stop's DeliveryBatch is reversed or superseded consistently with its DeliveryMutation reversal.

## How this varies by tenant

| Variation                                                                                             | Mechanism                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether drivers can take money at the door, versus billing everything on account                      | `TenantAddon` key `driver_payments` — server-enforced body-aware on the completion endpoint by `driver-payments.guard.ts` ($0/on-account completions pass for every tenant regardless); client mirror `useDriverPayments` hides the method picker and relabels to on-account.       |
| Whether the whole dispatch surface (drivers directory, routes, runs, optimisation) exists             | Either-gate `@RequireAddon("recurring_routes", "order_delivery", "developer_mode")` at class level on `DriversController`, `RoutesController` and `RouteRunsController`; client composition via `useRoutesAccess()`/`useDeliveryAccess()`.                                          |
| Whether the driver mobile app itself is reachable — still in development and gated by design          | `TenantAddon` key `developer_mode` gates the driver branch in `apps/mobile/app/_layout.tsx:174-198`; a pure DRIVER of a non-dev tenant is routed to `/(auth)/operator-blocked`. Deliberately fails open when the addon read does not land.                                          |
| Whether a stop demands an age check, an ID check, both, or neither                                    | Derived per stop from the tenant's `TrackedCategory`/`TrackedSubcategory` configuration via `loadAgeIdCategorySets` → `deriveStopRegulatedRequirements`, materialised onto `RouteRunStop.ageCheckRequired`/`identityCheckRequired`.                                                 |
| Where a run starts and ends, and whether it optimises for time or distance and avoids tolls           | Per-route: `Route.originKind/endKind/optimizeBy/avoidTolls`; per-driver home base: `Driver.homeLat/homeLng/homeAddress`; per-tenant depot fallback via `TenantConfig`.                                                                                                              |
| Whether a given office user can also drive (an owner who covers a route on Saturday)                  | Per-user `User.canActAsDriver` — `PATCH /users/:id/driver-permit` creates the Driver row on first enable; honoured in `RolesGuard`'s dual-role branch and propagated by `jwt.strategy.ts`.                                                                                          |
| The on-time bar — a same-day distributor needs a window, a next-day wholesaler is happy with the day  | **NOT CONFIGURABLE** — hardcoded as `completedAt <= 23:59:59.999 UTC` of the run's scheduledDate, with no eta/window field on RouteRunStop to measure against. Also note the UTC day boundary is wrong for a tenant west of UTC whose evening deliveries fall on the next UTC date. |
| Whether proof of delivery (photo and/or signature) is mandatory on ordinary, non-regulated stops      | **NOT CONFIGURABLE** — the only enforcement ladder is the regulated one; a normal stop completes with an empty podPhotoUrls and a null signatureUrl and nothing objects.                                                                                                            |
| How fresh a GPS ping must be before dispatch treats a van as "live", and how often the device samples | **NOT CONFIGURABLE** — 5-minute freshness window hardcoded at `routes.service.ts:732`; 30s / 50m sampling hardcoded at `location-tracker.native.ts:63-64`.                                                                                                                          |
| How many times a queued offline action is retried before it is discarded                              | **NOT CONFIGURABLE** — `MAX_RETRIES = 3` hardcoded at `useNetworkSync.ts:7`, and a discarded action leaves no user-visible record.                                                                                                                                                  |
| Driver lifecycle states — a real fleet needs at least active / on leave / suspended                   | **NOT CONFIGURABLE** beyond two states: `enum DriverStatus { ACTIVE, INACTIVE }`, and no client can even set it (see DRV-M12). The mobile client type optimistically declares an "ON_LEAVE" the API cannot return.                                                                  |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                                                                                                         | Impact                                                                                                                                                                                                                                                                                               | Suggested direction                                                                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | The shipped at-door completion cannot succeed: the mobile client sends `deliveries[].productId`, `RunDeliveryDto` does not declare it, and the global pipe runs `forbidNonWhitelisted:true` — every completion 400s.                                                        | The single most important action in the domain is dead for anyone running the current mobile build. A driver can start a run and never close a stop. Only the dev-mode gating keeps this off client hands.                                                                                           | Add `@IsOptional() @IsString() productId?: string \| null` to RunDeliveryDto (it is already ignored server-side, per short-pick.ts's own comment) and pin it with a DTO validation spec plus a feature-smoke case.                              |
| CRITICAL | The money the driver asks for at the door is re-derived as qty × unitPrice (`payment.tsx:70-75`), violating the house money rule directly.                                                                                                                                  | Used for every non-primary order on a multi-order stop and for the primary order whenever there are no short-pick lines. A boxed line over-charges by unitsPerBox; discount, tax and shipping are ignored. The customer is asked for the wrong number.                                               | Delete `fullOrderTotal` and read the order's stored total, or prorate the stored line subtotals as `reconciledTotal` already does. Add a Jest case on a boxed line and a discounted order.                                                      |
| CRITICAL | Any driver in the tenant can complete, price and take payment against any other driver's stop — `completeStop`, `completeWithPayment`, `updateRunStatus`, `getRunPackingList`, `attachPodArtifact` and `getStopPod` never compare the caller's driver id to `run.driverId`. | A driver can close someone else's day, book cash to it and attach POD to it. Cross-tenant is safe on these routes; intra-tenant ownership is not enforced on this specific set of six handlers.                                                                                                      | Extract the ownership check that already exists at `routes.service.ts:1195` into one private `assertDriverOwnsRun(runId, user)` and call it from every DRIVER-reachable run handler. Spec each endpoint with a driver-B-on-driver-A's-run case. |
| HIGH     | A cancelled run strands its orders on a stale stop link.                                                                                                                                                                                                                    | Orders keep `routeRunStopId` pointing at a stop of a cancelled run, and `TripsService.checkEligibility` treats a non-null `routeRunStopId` as already-dispatched, so those orders can never be put on another trip. The customer's order silently falls out of the delivery pipeline (B129).         | On run cancellation, null `routeRunId`/`routeRunStopId` for the attached orders inside the same transaction, and add an eligibility test asserting a cancelled run's orders are dispatchable again.                                             |
| HIGH     | Proof of delivery is captured into RAM (`podStore.ts`) and the run's cash tally is captured into RAM (`runSettlementStore.ts`) — neither uses persist middleware.                                                                                                           | An app kill or an OS memory reclaim between capturing a signature and completing the stop silently erases the photo, signature, note and age/ID ticks; the same event erases the expected-cash figure so the settlement step vanishes and the run closes unreconciled.                               | Persist both stores to AsyncStorage keyed by stop/run id with an explicit clear on successful completion and on sign-out. POD is the evidence you produce in a dispute — it must survive a restart.                                             |
| HIGH     | "Skip stop" is a dead control — the confirm dialog fires and the driver is navigated back; no PATCH is sent.                                                                                                                                                                | The stop stays PENDING, so the run cannot be marked COMPLETED, and the office never learns the customer was shut. The driver believes they recorded it (B34).                                                                                                                                        | Wire the confirm to `useUpdateStopStatus` with status SKIPPED and a required reason, and add the reason to the run summary.                                                                                                                     |
| HIGH     | The offline queue outlives the session — `clearQueue` has zero callers on sign-out.                                                                                                                                                                                         | On a shared depot handset, driver A's unsent completions replay under driver B's token — wrong attribution on the delivery mutation, wrong driver on the payment audit trail, and a POD attributed to someone who was never there (B137).                                                            | Call `clearQueue` (and `stopLocationTracking`) from the sign-out path, and stamp each queued action with the user id it was created under so a mismatch is dropped rather than replayed.                                                        |
| HIGH     | Background GPS tracking is never stopped on sign-out.                                                                                                                                                                                                                       | `stopLocationTracking` is only called from the route screen. A driver who signs out mid-day keeps a foreground-service location task running and posting to `/drivers/me/location` — a privacy problem, a battery problem, and pings attributed to whoever holds the token next.                     | Stop the task in the auth store's logout, and again on the operator-blocked redirect. Add a test asserting `hasStartedLocationUpdatesAsync` is false after logout.                                                                              |
| HIGH     | A driver's own stats endpoint returns fabricated numbers — `getMyStats` hardcodes `onTimeDeliveryPct:100`/`returnsRate:0` unconditionally.                                                                                                                                  | The correct on-time computation already exists in analytics.service.ts. Currently latent rather than visible: `useDriverStats` has zero callers, so no driver screen renders the flattering constant today — but any UI wired to it inherits the lie immediately.                                    | Reuse `accumulateRunMetrics`/`finalizeRunMetrics` from the analytics service for my-stats and return null rather than a flattering constant when there is no data, before any screen is wired to it.                                            |
| HIGH     | Driver-filed returns file the delivered quantity rather than the returned quantity.                                                                                                                                                                                         | A REFUSED line files qty 0 and 400s, so the most common return-at-the-door case cannot be recorded at all; a short delivery files a return for goods the customer kept and is credited for them. Compounded by a Damaged/Expired return restocking sellable inventory (B61/B128).                    | Fix the qty mapping in the driver return screen and route DAMAGED/EXPIRED reasons to a write-off movement rather than a sellable restock. Add a stock invariant test.                                                                           |
| HIGH     | A driver id can be pinned to a run without a tenant check (`createRun`/`updateRun` write `dto.driverId` straight through).                                                                                                                                                  | `TripsService` does the check the dispatch path skips. A crafted request can attach another tenant's driver to a run FK, which then shows on the live map and in performance metrics.                                                                                                                | Add the same tenant-scoped driver lookup to both paths and spec it.                                                                                                                                                                             |
| HIGH     | There is no server-side answer to "how much did this driver collect today".                                                                                                                                                                                                 | The settlement screen reconciles against a device-local tally that a second device or an app restart under-counts, and the outcome is appended to `RouteRun.notes`, a field no screen renders after the run closes (B152/B167). The owner cannot reconcile the float without the driver's handset.   | Add `GET /route-runs/:id/collections` aggregating the InvoicePayment rows the run's completions produced, drive the settlement screen from it, and store the variance as a first-class field.                                                   |
| MEDIUM   | No client can deactivate a driver — `PATCH /drivers/:id/status` and `useChangeDriverStatus` both ship, and nothing calls the hook.                                                                                                                                          | A driver who leaves or is suspended can only be deleted, and delete is refused while they have any scheduled run — so the practical answer is "leave them active", which keeps them in assignment pickers and metrics (B36).                                                                         | Add a status control to the driver detail page and the edit modal, and exclude INACTIVE drivers from dispatch pickers.                                                                                                                          |
| MEDIUM   | Cash collected above the server's delivered-basis total is silently dropped.                                                                                                                                                                                                | `recordDeliveryPaymentInTx` caps at each invoice's remaining, and the excess disappears with only a warn log — the driver's device believes it collected X, the ledger records less, surfacing as an unexplained till variance days later (B83).                                                     | Either reject the over-payment with a message the driver can act on, or book the remainder as an AdvancePayment/customer credit.                                                                                                                |
| MEDIUM   | GPS pings are rejected wholesale for a recoverable field, and never pruned.                                                                                                                                                                                                 | `PostLocationDto` sets `@Min(0)` on heading and speedKph while iOS reports -1 for "unavailable", so a perfectly good lat/lng is thrown away with the whole request (B185) — the van vanishes from the live map. `DriverLocation` has no retention job (B184).                                        | Coerce -1 to null client-side and widen the DTO to accept it; add a scheduled prune with a tenant-configurable horizon.                                                                                                                         |
| MEDIUM   | The desktop dashboard — where dispatchers actually work — has no live map.                                                                                                                                                                                                  | `GET /routes/live` is consumed only by the mobile operator fleet screen. A dispatcher at a desk has no way to see where the vans are without picking up a phone.                                                                                                                                     | Render the existing `/routes/live` payload on `/dispatch` (it already returns coordinates, driver names, stop pins and nextStopIndex — no new API needed).                                                                                      |
| MEDIUM   | The driver app is read-online-only, so a signal blackspot stops work entirely.                                                                                                                                                                                              | Writes queue; reads do not cache. In a rural delivery area the driver opens the app and sees nothing — no stops, no lines, no prices.                                                                                                                                                                | Add a persisted TanStack Query cache for the day's run, stops and order lines, cleared on sign-out, with an explicit "last synced HH:MM" stamp on money-bearing screens.                                                                        |
| MEDIUM   | The end-of-day Cash tab is an honest placeholder, and the domain has no driver-pay concept at all.                                                                                                                                                                          | The Cash tab renders "coming soon". Nothing pays the driver: per-stop, per-mile and commission pay are absent, and the MileageRate model plus the device mileage store are wired to nothing.                                                                                                         | Either finish the cash-up against the missing server aggregate, or remove the tab. Treat driver compensation as a distinct piece of work modelled on the existing CommissionAccrual/CommissionPayout pattern.                                   |
| MEDIUM   | There is only narrow automated regression coverage of the driver day end to end — dispatch has a canary, but no spec exercises driver-roster CRUD or a stop completion.                                                                                                     | `apps/web/e2e/02-operator.spec.ts` and `20-trip-builder-gate.spec.ts` canary that the Dispatch nav renders, but the B148 break — a total failure of the domain's core action — would still not be caught by either; `drivers.service.spec.ts` covers CRUD only.                                      | Add a feature-smoke scenario on the approved test tenant covering dispatch → start → complete a stop short → assert the invoice bills delivered qty → assert the payment row; and a driver-isolation spec block.                                |
| MEDIUM   | POD attach failures are swallowed and the driver is never told (B111).                                                                                                                                                                                                      | A photo the driver believes is attached may be recorded nowhere, discovered only when the delivery is disputed and the evidence is missing.                                                                                                                                                          | Surface an attach failure inline on the stop with a retry, and block completion (or warn explicitly) when a captured artifact has no confirmed server key.                                                                                      |
| MEDIUM   | The on-time bar is a whole UTC calendar day, and the run has no promised times at all.                                                                                                                                                                                      | Any stop completed before midnight UTC of the scheduled day counts on-time — close to unfailable for a next-day operation and misleading for a same-day one. A tenant west of UTC can score an evening delivery late for no reason. `Customer.deliveryWindowStart/End` is printed but binds nothing. | Introduce a promised window on RouteRunStop (seeded from the customer's window), measure on-time against it, and make the fallback bar tenant-configurable — grandfathering existing tenants onto today's definition.                           |
| LOW      | A driver's only web navigation opens an operator console, half of which 403s (B174).                                                                                                                                                                                        | A DRIVER who signs in on the web lands in a surface built for operators and hits permission errors. The intended driver surface is the mobile app, which is dev-gated by design — so the web experience is currently a dead end.                                                                     | Give a DRIVER-role web session an explicit landing page that states the driver surface is the mobile app (and links to it) instead of routing them into operator screens they cannot use.                                                       |

## Cross-domain handoffs

- **Orders** — inbound: a stop's linked orders are the manifest (`Order.routeRunId`/`routeRunStopId`,
  swept in at dispatch and pinned to `fulfillPath ROUTE`). Outbound: completing a stop sets those
  orders DELIVERED and writes `OrderItem.deliveredQty` per line, which every downstream billing
  decision keys on.
- **Invoices & payments** — outbound and money-critical: completion calls
  `InvoicesService.recordDeliveryPaymentInTx`, which ensures a draft invoice per delivered order,
  rebuilds it at the DELIVERED quantity (sibling-aware for split/regulated orders), finalises
  DRAFT→SENT and records each at-door collection as an InvoicePayment, oldest-payable-first,
  row-locked against a concurrent back-office payment. This handoff must never double-bill or
  drop cash.
- **Inventory & stock** — outbound: delivery mutations move stock; reopening a stop reverses them
  with a compensating positive-qty SALE carrying the original unitCost so signed COGS nets to
  zero. Any change to the driver completion path must preserve "Σ movements == on-hand".
- **Returns & credit notes** — outbound: driver-filed returns create Return/ReturnItem rows and
  eventually credit notes; the ledger reversal path caps cumulatively on the order line so a
  reconcile that rotates invoiceItemIds cannot over-reverse.
- **Regulated compliance** — bidirectional: `TrackedCategory`/`TrackedSubcategory` config decides
  whether a stop demands an age or ID check; the driver's capture is the evidence, and the
  delivered-basis reconcile re-syncs the regulated sales ledger so a short or refused regulated
  line reports its delivered quantity in the current period.
- **Routes, runs & ad-hoc trips** — inbound: Route/RouteStop templates and TripsService produce
  the RouteRun and RouteRunStop rows the driver works; `Driver.homeLat/homeLng` feeds
  `TripsService.resolveOrigin`'s DRIVER tier; route optimisation renumbers the stops the driver
  sees.
- **Customers & addresses** — inbound: CustomerAddress supplies the stop coordinates for maps,
  optimisation and the live view; a customer with no address is ineligible for a trip. The
  customer's delivery window is surfaced on the packing list but binds nothing yet.
- **Analytics** — outbound: `getDriverPerformance`/`getRoutePerformance` read RouteRun and
  RouteRunStop timestamps; the on-time definition is set there, not in the driver domain, and any
  new promised-time field must be adopted in both places at once.
- **Messaging & notifications** — bidirectional: dispatch pushes to the driver (`emitToDriver` +
  `sendToDriver` → DeviceToken); the INTERNAL run chat is driver↔operator only; order status
  transitions the driver causes fire customer-facing notifications after the write commits.
- **Buyer portal** — outbound: the buyer's order-tracking view is driven by the run's stop
  progression and the driver's GPS breadcrumbs; a buyer-raised at-door change request must reach
  someone who can act on it.
- **Billing & entitlements** — inbound: three separate addon keys decide what exists
  (`recurring_routes`/`order_delivery` for the dispatch surface, `driver_payments` for at-door
  money, `developer_mode` for the mobile driver app itself). Every new driver endpoint must join
  the right gate, and every new gate needs a UI that can grant it.
- **Auth & users** — inbound: DRIVER logins are minted by the drivers module with
  `forcePasswordChange`; `User.canActAsDriver` lets an operator or tenant admin satisfy
  `@Roles(DRIVER)`; deleting a driver profile must never delete a dual-role admin's login.

## What we could not verify

- Nothing in this domain was executed — no Jest run, no live API call, no device build — so
  BROKEN verdicts rest on static reasoning. The DRV-M6 (B148) break is high confidence: the
  mobile client provably sends `deliveries[].productId`, `RunDeliveryDto` provably lacks it, and
  `main.ts` provably sets `forbidNonWhitelisted:true`, but the resulting 400 was not observed
  directly.
- `routes.service.ts` (roughly 90k) was not read in full — only the handlers cited above, plus
  the guard lines a second read pass located for `findAllRuns` and driver order reads. A driver-
  ownership check deeper inside `completeStop`/`completeWithPayment` than the read portions would
  change DRV-M9's status, though the register (B72) independently agrees ownership is absent on
  those six handlers.
- `routes.service.spec.ts` (~50k) and the mobile driver screens were sampled by targeted grep and
  read, not read end to end — a second money-derivation site beyond `payment.tsx:70` could exist
  in `adjust.tsx` or `short-pick.tsx`.
- Several claims are sourced from `local-assets/docs/routeflow-bug-register.html` and were
  cross-checked in code for the money- and ownership-critical items (B34, B36, B49, B72, B137,
  B148, B152, B185 and the podStore/runSettlementStore persistence claims); B61, B111, B128, B129
  and B176 were accepted from the register without independently re-deriving them in this pass.
- The driver mobile app is dev-gated by design (`developer_mode`), so none of these driver-app
  defects is currently reachable by a normal client tenant. Severity above is stated as if the
  gate were lifted, which is the right bar for a readiness model.
- Buyer tracking and notification code paths were inspected only at their entry points, so the
  cross-domain claims about ETA and customer messaging are structural rather than line-verified.
