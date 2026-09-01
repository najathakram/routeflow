# Test plan — F10: reopenStop and stop-state guards

**Status:** IMPLEMENTED. All tests are jest unit specs (campaign tier T1) against
`RoutesService` with mocked collaborators — the house pattern of
`apps/api/src/routes/routes.service.spec.ts` (`createMockPrisma()` from
`../testing/prisma-mock`, `Test.createTestingModule` with mocked Gateway/Notifications/
Messaging/InvoicesService/ConfigService/StorageService providers — mirror the setup block at
`routes.service.spec.ts:76–141` exactly, including the `jest.mock` of
`../common/geocode.util` and `../storage/compress.util`).

**New file:** `apps/api/src/routes/routes.service.stop-state-guards.spec.ts` — ALL tests
below live here and ALL must fail on an assertion pre-implementation (red gate scope).
Regression pins that pass today go in the EXISTING spec instead (listed at the bottom, owned
by the implementation package, NOT red-gated).

**Mock facts the author must know**
- `createMockPrisma()` gives every model every method as jest.fn with sane defaults
  (findFirst→null, findMany→[]); `prisma.tenantTransaction` calls your fn with the SAME
  model mocks plus `$executeRaw`/`$queryRaw` — so `prisma.stockMovement.create` records
  tx-writes too. For tx-specific assertions override:
  `(prisma.tenantTransaction as jest.Mock).mockImplementation((fn) => fn(txMock))` with an
  explicit txMock (pattern at routes.service.spec.ts:977).
- New-signature calls (`attachPodArtifact` with 4 args) and not-yet-existing symbols must
  not break compilation pre-impl: call via `(service as any).attachPodArtifact(...)`
  (house pattern — see `(service as any).settleRun` at spec:2008), and load the DTO helper
  via `const dtoModule = require("./dto/update-run-status.dto")` then assert
  `expect(dtoModule.forbiddenRunTransition).toBeDefined()` FIRST (assertion failure, not an
  import error, pre-impl).
- Payloads: `operatorPayload = { sub: "user-op", role: "OPERATOR", tenantId: "t1" }`,
  `driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" }` (cast `as any` —
  mirror the existing spec's payload consts). Run fixture: `{ id: "run-1", driverId:
  "drv-1", status: ..., startedAt: null, settlementNote: null, settlementVariance: null }`.
- reopenStop needs `prisma.routeRun.findUnique` → run WITH `stops: [stopFixture]` where
  `stopFixture.orders = [{ id: "order-1", status: "DELIVERED", lineItems: [] }]`, and
  `prisma.transaction.findMany` → `[]` (legacy guard must pass unless the test targets it).
- attachPodArtifact needs `prisma.getTenantId` to return `"t1"` if not already defaulted by
  createMockPrisma — check the helper; set `(prisma.getTenantId as jest.Mock) = jest.fn(()
  => "t1")` if needed — and POD data URLs: use the existing spec's
  `PHOTO_DATA_URL`-style constant (`"data:image/png;base64,aGk="` works with the mocked
  compressImage). A stored signature key that satisfies `isPodStorageKey` for tenant t1 with
  artifactId `old-1`: `"tenants/t1/pod/stop-1/signature-old-1.jpg"`.

Every test names its requirement. Oracle column = what makes the expectation known
independently of the implementation (collaborator consultation / error class / recorded
call args). Anti-vacuity: every test's failure mode pre-impl is stated.

| T# | R# | Title (verbatim `it(...)` title) | Given / When / Then | Oracle & red-anchor |
|----|----|----------------------------------|---------------------|---------------------|
| T1 | R1 | `REG-B54: a CONFIRMED InvoicePayment on a stop order blocks the reopen before any reversal` | Stop COMPLETED with order-1; `prisma.invoice.findFirst` → `{ id: "inv-1" }`; legacy `transaction.findMany` → []. Call reopenStop as operator. | Rejects `BadRequestException` with message containing "Payment already recorded"; `prisma.tenantTransaction` NOT called. Pre-impl: no invoice read exists → resolves successfully → fails. |
| T2 | R1 | `REG-B54: a PARTIAL invoice blocks the reopen even with no payment rows returned` | Same, but `invoice.findFirst` runs a `mockImplementation` that returns `{ id: "inv-2" }` ONLY when the guard's `where.OR` still carries an arm whose `status.in` includes "PARTIAL" (T1's mock is the mirror image — it hits only on the `payments.some` arm). | Same rejection + no tx. **Each OR arm is separately falsifiable**: delete/narrow the status arm and T2 alone goes red; delete the payments arm and T1 alone goes red — a truthy mock shared by both could not tell them apart. Pre-impl fails identically (no invoice read at all). |
| T3 | R1 | `REG-B54: the live-money guard queries invoices by the stop's orderIds with the shared CONFIRMED_PAYMENT predicate — and a clean stop still reopens` | `invoice.findFirst` → null; legacy → []. Call reopenStop. | Resolves `{ success: true, ... }`; `prisma.invoice.findFirst` called with `where` objectContaining `orderId: { in: ["order-1"] }` and an `OR` arrayContaining an arm objectContaining `{ payments: { some: CONFIRMED_PAYMENT } }` (import the const — pins the predicate, F03/F05 convention) and an arm whose `status.in` contains "PAID" and "PARTIAL". Pre-impl: findFirst never called → fails. |
| T4 | R2 | `REG-B55: reopen writes no stock movement and never touches currentStock` | Stop COMPLETED; `deliveryMutation.findMany` → one DELIVERED mutation `{ productId: "prod-1", quantityDelivered: 5, type: "DELIVERED", order: { orderNumber: "ORD-1" } }`; invoice guard → null; legacy → []. Reopen. | `prisma.stockMovement.create` NOT called; `prisma.product.update` NOT called (mock shared with tx). Pre-impl: loop writes both → fails. |
| T5 | R2 | `REG-B55: the reversal still deletes mutations and resets items, order and stop — while writing no stock` | Same fixture. | `deliveryMutation.deleteMany` called with `{ where: { routeRunStopId: "stop-1" } }`; `orderItem.updateMany` → status PENDING; `order.update` → status CONFIRMED; `routeRunStop.update` data objectContaining `{ status: "PENDING", signatureUrl: null }`; AND `stockMovement.create` NOT called (red anchor). Pre-impl: stock assertion fails. |
| T6 | R3 | `REG-B71: a COMPLETED stop cannot be PATCHed to SKIPPED — reopen is the only exit` | `routeRunStop.findFirst` → stop status COMPLETED. updateStopStatus {status:"SKIPPED"} as operator. | Rejects `ConflictException`; `routeRunStop.update` NOT called. Pre-impl: updates → fails. |
| T7 | R3 | `REG-B71: no stop transition is accepted on a COMPLETED or CANCELLED run` | Stop PENDING; `routeRun.findFirst` → `{ driverId: "drv-1", status: "COMPLETED" }` (then a second call with "CANCELLED"). PATCH IN_PROGRESS as operator. | Both reject `ConflictException`, no update. Pre-impl: operator path never loads the run and updates → fails. |
| T8 | R3 | `REG-B71: a normal PATCH still succeeds and now consults the run's status for every caller` | Stop PENDING, run `{ driverId: "drv-1", status: "IN_PROGRESS" }`. PATCH IN_PROGRESS as operator; then a SKIPPED→IN_PROGRESS PATCH. | Resolves; `routeRunStop.update` called (arrivedAt stamped); **`routeRun.findFirst` WAS called** (red anchor — today the operator path never loads the run); SKIPPED stop accepted. |
| T9 | R4 | `REG-B72: a CANCELLED run cannot be declared COMPLETED` | `routeRun.findUnique` → run status CANCELLED. updateRunStatus {COMPLETED} as operator. | `ConflictException`; `routeRun.update` NOT called. Pre-impl: succeeds → fails. |
| T9b | R4 | `REG-B72: an operator CAN restart a cancelled run that already recorded deliveries — CANCELLED is not an absorbing state` | Run status CANCELLED; `routeRun.update` → `{ id: "run-1", status: "IN_PROGRESS" }`. PATCH {IN_PROGRESS} as operator. | Resolves; `routeRun.update` called with `data` objectContaining `{ status: "IN_PROGRESS" }`. The review pin: deleteRun refuses runs with a deliveryMutation and reopenStop refuses cancelled runs, so denying this too would strand the run and its orders forever. |
| T9c | R4 | `REG-B72: a driver cannot restart a cancelled run — un-cancelling is the operator's call` | Run status CANCELLED; `driver.findFirst` → `{ id: "drv-1" }` so the caller OWNS the run. PATCH {IN_PROGRESS} as driver. | `ForbiddenException` whose message contains "ask your operator to restart it" (message-pinned so R5's ownership Forbidden cannot satisfy this test); `routeRun.update` NOT called. |
| T10 | R4 | `REG-B72: a COMPLETED run cannot be re-SCHEDULED` | Run status COMPLETED. PATCH {SCHEDULED} as operator. | `ConflictException`; no update. Pre-impl fails. |
| T11 | R4 | `REG-B72: the transition matrix is exported from the DTO module and encodes exactly the deny-list` | `const m = require("./dto/update-run-status.dto")`. | `expect(m.forbiddenRunTransition).toBeDefined()` FIRST (red anchor). Then: null for SCHEDULED→IN_PROGRESS, IN_PROGRESS→COMPLETED, SCHEDULED→CANCELLED, IN_PROGRESS→CANCELLED, and every same→same incl. CANCELLED→CANCELLED; **null for CANCELLED→SCHEDULED and CANCELLED→IN_PROGRESS** (the un-cancel recovery path — role is gated in the service, not the matrix); non-null (a string) for CANCELLED→COMPLETED and COMPLETED→SCHEDULED; null for COMPLETED→IN_PROGRESS (documented non-goal). |
| T12 | R5 | `REG-B72: a driver cannot move another driver's run — and an owning driver is verified through the driver table` | Run SCHEDULED driverId "drv-1". (a) `driver.findFirst` → `{ id: "drv-2" }`, PATCH IN_PROGRESS as driver → `ForbiddenException`, no update. (b) `driver.findFirst` → `{ id: "drv-1" }` → resolves AND `prisma.driver.findFirst` was called with `{ where: { userId: driverPayload.sub } }`. | Red anchor: today no driver read happens at all — (b)'s consultation assertion fails pre-impl; (a) succeeds-instead-of-throwing pre-impl. |
| T13 | R5 | `REG-B72: completeStop refuses a driver who is not assigned to the run, before any POD ingest or transaction` | Run IN_PROGRESS driverId "drv-1"; stop PENDING with orders; `driver.findFirst` → `{ id: "drv-2" }`; dto has a `signatureUrl` data URL. completeStop as driver. | `ForbiddenException`; `tenantTransaction` NOT called; `storage.upload` NOT called. Pre-impl: completes → fails. |
| T14 | R5 | `REG-B72: completeWithPayment refuses an unassigned driver before the transaction` | Same fixture, payment `{ amount: 50, method: "CASH" }`. | `ForbiddenException`; `tenantTransaction` NOT called; `invoicesService.recordDeliveryPaymentInTx` NOT called. Pre-impl fails. |
| T15 | R6 | `REG-B120: reopen archives the discarded POD state to the audit log inside the same transaction, then resets the stop` | Stop COMPLETED with `signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg"`, `podPhotoUrls: ["tenants/t1/pod/stop-1/photo-p1.jpg"]`, `ageVerified: true`, `identityType: "DL"`, `completedAt: new Date(...)`; explicit txMock via mockImplementation. Reopen as operator. | `txMock.auditLog.create` called ONCE with data objectContaining `{ action: "route_stop.reopened", entityType: "RouteRunStop", entityId: "stop-1", userId: operatorPayload.sub }` and meta objectContaining the exact signature key, photo array, `runId: "run-1"` and **all ten** meta keys R6 enumerates, each at a NON-default fixture value (`safeDropEnabled: true`, `driverNote`, `ageVerified: true`, `identityVerified: true`, `identityType: "DL"`) incl. both Date→ISO conversions (`completedAt: "2026-08-20T12:00:00.000Z"`, `identityVerifiedAt: "2026-08-20T11:58:30.000Z"` — a raw `Date` or a dropped key fails here); AND `txMock.routeRunStop.update` still nulls the columns and appends the displaced pointers to the stop's own `podHistory` archive (`data` objectContaining `podHistory: [ expect.objectContaining({ signatureUrl, podPhotoUrls, reason: "reopen" }) ]`). Pre-impl: no auditLog.create → fails. |
| T16 | R6 | `REG-B120: a SKIPPED stop's reopen still writes the archival row (empty capture) on the tx client` | Stop SKIPPED, no signature, no photos; explicit txMock. | `txMock.auditLog.create` called with meta objectContaining `{ signatureUrl: null, podPhotoUrls: [] }` plus the null/false half of every other key (`completedAt: null`, `identityVerifiedAt: null` — the other branch of T15's ISO conversions); `prisma.auditLog.create` (non-tx top-level mock) NOT the call site — assert the txMock fn specifically. Pre-impl fails. |
| T17 | R7 | `REG-B121: a completed stop's stored signature cannot be replaced by a different artifact` | Run + stop COMPLETED, `signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg"`; call `(service as any).attachPodArtifact("run-1","stop-1",{ kind: "signature", dataUrl: SIG_DATA_URL, artifactId: "new-9" }, operatorPayload)`. | `ConflictException`; `routeRunStop.update` NOT called; `storage.upload` NOT called. Pre-impl: overwrites → fails. |
| T17b | R7 | `REG-B121: a completed stop with NO stored signature still accepts one — the documented after-completion capture` | Run + stop COMPLETED but `signatureUrl: null`; same call as T17 (kind signature, artifactId "new-9", operator). | Resolves `{ key: "tenants/t1/pod/stop-1/signature-new-9.jpg", url: "signed:..." }`; `storage.upload` called; `routeRunStop.update` called with `{ signatureUrl: key }`. Pins R7's ALLOWED half — the guard turns on a *stored* signature, not on COMPLETED alone. Simplify it to `kind === "signature" && status === "COMPLETED"` and the offline queue's post-completion signature replay starts 409-ing: this test alone goes red. |
| T18 | R7+R8 | `REG-B121: the assigned driver's same-artifactId replay still returns the stored artifact — and the driver binding is actually consulted` | Same stop; `driver.findFirst` → `{ id: "drv-1" }`; call with `artifactId: "old-1"`, kind signature, as driver. | Resolves `{ key: "tenants/t1/pod/stop-1/signature-old-1.jpg", url: "signed:..." }`; `routeRunStop.update` NOT called; **`prisma.driver.findFirst` WAS called** (red anchor — no driver read exists today). |
| T19 | R8 | `REG-B121: a driver not assigned to the run cannot attach POD at all — nothing is read or written` | Stop PENDING (not completed — isolates ownership from immutability); `driver.findFirst` → `{ id: "drv-2" }`; kind photo, new artifactId, as driver. | `ForbiddenException`; `storage.upload` NOT called; `routeRunStop.update` NOT called; `storage.presignedUrl` NOT called. Pre-impl: uploads and pushes → fails. |
| T20 | R8 | `REG-B121: a driver not assigned to the run cannot READ the stop's POD` | Stop COMPLETED with a signature key and photo array; `routeRun.findFirst` → `{ driverId: "drv-1" }`; `driver.findFirst` → `{ id: "drv-2" }`. Call `getStopPod("run-1","stop-1",driverPayload)` as the unassigned driver. | `ForbiddenException`; `storage.presignedUrl` NOT called. This closes R8's read half — `RouteRun.driverId` is mutable via `updateRun`, so without this test a reassigned driver would keep presigning the prior driver's POD forever. Pre-impl: no driver-ownership check on the read path → resolves instead of rejecting → fails. |
| T20 (pin) | R8 | `REG-B121: the assigned driver still reads their own stop's POD` | Same stop shape; `routeRun.findFirst` → `{ driverId: "drv-1" }`; `driver.findFirst` → `{ id: "drv-1" }`. Call `getStopPod` as the assigned driver. | Resolves; `pod.signatureUrl` equals the presigned URL for the stored signature key. Pins the ALLOWED half — tightening the ownership check to block same-driver reads goes red here. |

## Red gate
`cd apps/api && npx jest src/routes/routes.service.stop-state-guards.spec.ts --silent`
→ expect **fail**, every test failing on an assertion (the require()/`as any` patterns above
exist precisely so no test dies on a compile/import error).

## Regression pins (existing spec, implementation package, NOT red-gated)
In `apps/api/src/routes/routes.service.spec.ts`:
1. attachPodArtifact describe (~1261): update every `service.attachPodArtifact(a,b,c)` call
   to pass `operatorPayload` as the 4th arg (signature change).
2. Add pin `REG-B121 (pin): photos stay appendable on a COMPLETED stop` — kind photo, new
   artifactId, stop COMPLETED with existing signature → `podPhotoUrls: { push: key }` update
   still happens.
3. updateRunStatus describe (~531): the two driver tests now need
   `prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" })` (MOCK_RUN.driverId is
   "drv-1"); the operator tests need no change (matrix allows SCHEDULED→COMPLETED backfill,
   spec:577 stays green).
4. If any completeStop/completeWithPayment test uses a driver payload (none found at plan
   time), give it the matching driver mock.

## What is deliberately NOT tested here
Controller pass-through (proven by tsc — a missed controller edit is a compile error);
Playwright/e2e (all six are T1 in the frozen ledger); the D4 historical repair (post-deploy
flight, not this PR).
