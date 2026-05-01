# L1-D Supervisor Review — W8 (Real-time) + W10 (Concurrent)
Date: 2026-04-29
Reviewer: L1-D supervisor agent

---

## Preflight note on W10

The W10 findings file (`docs/qa/workers/w10-concurrent/findings.md`) does not exist — the W10 worker either did not run or did not write its output. This review therefore:
- Verifies all W8 findings against source code (primary task).
- Independently audits the W10 source-code targets listed in the audit spec, deriving findings from first principles.
- Notes which W10 claims were verified fresh rather than reviewed against a pre-existing findings file.

---

## W8 Assessment

### W8-001 — `createRun()` emits no WebSocket event and no push to driver
**Status: CONFIRMED — P1 severity upheld**

Code evidence:
- `apps/api/src/routes/routes.service.ts` lines 490–606: `createRun()` completes with the transaction at line 587 and the order-linking `Promise.all` at lines 590–603. There is no call to `this.gateway.*` or `this.notifications.*` anywhere in the method body.
- `apps/api/src/gateways/routeflow.gateway.ts` lines 141–142: the `driver:${payload.sub}` room IS registered on connect, but no emitter method in the gateway sends events to it. The gateway exposes `emitStopCompleted`, `emitUrgentOrder`, `emitDriverStatusUpdated`, `emitLowStock`, `emitOrderCreated`, `emitOrderStatusChanged`, `emitReturnCreated`, `emitInvoiceUpdated`, `emitCreditNoteCreated` — none of these target a driver room.
- `apps/api/src/notifications/notifications.service.ts` lines 167–179: `sendToDriver()` exists and is wired, but is never called from `routes.service.ts`.

The finding is accurate. Dispatch is entirely silent to the driver.

---

### W8-002 — `useBuyerOrders` has no `refetchInterval`
**Status: CONFIRMED — P2 severity upheld**

Code evidence:
- `apps/mobile/lib/api/buyer.ts` lines 142–151: `useBuyerOrders()` sets `staleTime: 30_000` with no `refetchInterval` property.
- `apps/mobile/app/(customer)/(tabs)/orders.tsx` lines 53–56 (per worker): no supplemental polling or `useFocusEffect` refetch call.

Finding is accurate.

---

### W8-003 — Driver route home has no `refetchInterval` on `useActiveRouteRun` / `useScheduledRouteRuns`
**Status: CONFIRMED — P2 severity upheld, with one nuance**

Code evidence:
- `apps/mobile/lib/api/routes.ts` lines 91–110: `useActiveRouteRun()` has `staleTime: 30_000`, no `refetchInterval`. `useScheduledRouteRuns()` has `staleTime: 60_000`, no `refetchInterval`.
- `apps/mobile/app/(driver)/route/index.tsx` lines 1–80 (full component start): imports are `useEffect`, `useMemo`, `useState` — no `useFocusEffect` import. The component calls both hooks at lines 66–67 with no additional polling arguments. No `useFocusEffect` call is present anywhere in the file.

The finding is accurate. There is no focus-triggered refetch to compensate for the missing `refetchInterval`.

---

### W8-004 — Expo push tokens sent to Firebase FCM directly — 100% push delivery failure
**Status: CONFIRMED — P1 severity upheld**

Code evidence:
- `apps/mobile/lib/auth.ts` line 86: `const { data: token } = await Notifications.getExpoPushTokenAsync();` — this returns an `ExponentPushToken[...]` string.
- `apps/api/src/notifications/notifications.service.ts` lines 78–84: this token string is placed directly into `tokens: tokens.map((t) => t.token)` inside a `admin.messaging.MulticastMessage` and sent via `admin.messaging().sendEachForMulticast(message)`. Firebase Admin SDK requires raw FCM registration tokens here; Expo proxy tokens are not valid.
- Lines 89–96: on `messaging/invalid-registration-token` response, the token is deleted from the database. Every Expo push token will trigger this error path on first send, self-cleaning the database of all push tokens.

The finding is accurate and correctly rated P1. All push notifications fail silently and the token table self-empties on first attempt.

---

### W8-005 — Push notification errors silently swallowed with `.catch(() => {})`
**Status: CONFIRMED — P2 severity upheld**

Code evidence (from W8 worker, not independently re-read, but consistent with surrounding code observed):
- `apps/api/src/orders/orders.service.ts` lines 1372 and 1381: `.catch(() => {})` on `sendToCustomer()` calls visible in the lines read (lines 1365–1382).

Combined with W8-004, there is zero observability: Firebase rejects the token, the error is caught and discarded, no log is written. The token is then deleted by `sendToUser()` itself (notifications.service.ts lines 89–102), so even the failure is invisible.

---

### W8-006 — `routes.service.ts::completeStop()` emits nothing; `orders.service.ts::completeStop()` correctly emits and notifies
**Status: CONFIRMED — P2 severity upheld, with additional detail**

Code evidence:
- `apps/api/src/routes/routes.service.ts` lines 987–1036: the entire `tenantTransaction` block and the return statement at 1036 contain zero calls to `this.gateway.*` or `this.notifications.*`. This is the operator-triggered path.
- `apps/api/src/orders/orders.service.ts` lines 1348–1384: after the transaction, code re-reads the stop, iterates `stop.orders`, calls `this.gateway.emitStopCompleted(...)` per order (line 1357), and calls `this.notifications.sendToCustomer(...)` (lines 1365–1381).

The two paths are structurally different. `routes.service.ts::completeStop()` is purely an operator endpoint (`PATCH /route-runs/:runId/stops/:stopId/complete` via `routes.controller.ts`) — when this path is used (e.g. from the web operator dashboard), the customer receives no WebSocket event and no push.

Additional finding: `routes.service.ts::completeStop()` also never auto-completes the run when all stops finish (no equivalent to the `allDone` check at `orders.service.ts` lines 1332–1345). If an operator completes all stops from the web UI, the RouteRun status remains IN_PROGRESS indefinitely.

---

### W8-007 — Redis adapter async connect race — silent in-memory fallback
**Status: CONFIRMED — P3 severity upheld**

Code evidence:
- `apps/api/src/gateways/redis-io.adapter.ts` lines 25–35: `Promise.all([pubClient.connect(), subClient.connect()]).then(() => { this.adapterConstructor = createAdapter(...) })` — the assignment is asynchronous.
- Lines 39–44: `createIOServer()` is synchronous and checks `if (this.adapterConstructor)` — if the promise has not resolved yet, the condition is false and `server.adapter()` is never called. Socket.io falls back to in-memory.
- The `.catch` at line 30 logs the error but sets no fallback flag, so `createIOServer()` does not know whether the null `adapterConstructor` is "connecting" or "failed".

The comment added at line 38 (`// Must be synchronous`) confirms the team is aware of the constraint. The race is real on cold start.

---

## W10 Assessment

*W10 worker findings file was absent. The following derives from direct source-code inspection of the targets listed in the audit spec.*

### W10-001 — Order number generation race (MAX+1 pattern, no transaction, no unique constraint)
**Status: NEW FINDING — P1**

Code evidence:
- `apps/api/src/orders/orders.service.ts` lines 542–551: `findFirst({ orderBy: { orderNumber: 'desc' } })` + `parseInt(...) + 1` runs OUTSIDE any transaction. The `order.create` at line 609 is also outside any transaction.
- `apps/api/prisma/schema.prisma` lines 801 and 828–836: `orderNumber String?` with no `@@unique` constraint of any kind. `@@index([status])`, `@@index([tenantId])` exist, but no uniqueness guard on `orderNumber`.

Two concurrent `POST /orders` requests for the same tenant will both read the same `lastOrder`, compute the same `seq`, generate identical `orderNumber` strings (e.g. `ORD-00042`), and both succeed. There is no database-level enforcement to reject the duplicate. The @@unique([tenantId, invoiceNumber]) pattern used in Invoice (line 1208) was NOT applied to Order.

Severity: **P1**. Duplicate order numbers corrupt financial records, break invoice linkage, and produce customer-facing display errors.

---

### W10-002 — Invoice number generation: partially safe inside `createInvoiceFromOrder`, unsafe in standalone path
**Status: NEW FINDING — P2**

Code evidence:
- `apps/api/src/invoices/invoices.service.ts` line 384–393: `generateInvoiceNumber(db?)` accepts an optional transaction client. When `db` is the transaction client, the `findFirst` executes inside the transaction.
- Line 249: called as `await this.generateInvoiceNumber(db)` where `db = txClient ?? this.prisma` — safe when a `txClient` is passed by the caller.
- Line 350: a SECOND call path exists (the standalone `createInvoice` method) that calls `await this.generateInvoiceNumber()` with no argument, so `db = this.prisma` — runs OUTSIDE any transaction.
- `apps/api/prisma/schema.prisma` line 1208: `@@unique([tenantId, invoiceNumber])` IS present. This means the DB will reject a duplicate with a unique constraint violation rather than silently creating it.

Assessment: the unique constraint saves the standalone path from silent data corruption, but concurrent calls will result in a Prisma unique constraint error surfaced to the caller as a 500. The `createInvoiceFromOrder` path with a tx client passes `db` into `generateInvoiceNumber` — the read and write are both inside the same transaction which provides serialization protection when the isolation level is appropriate.

Inside `orders.service.ts::completeStop` (lines 1265–1272), invoice number generation is inlined directly inside the transaction using `tx.invoice.findFirst` — this is safe.

Severity: **P2**. The constraint prevents silent duplicates but causes 500 errors under concurrent invoice creation via the standalone path.

---

### W10-003 — Credit note number generation race
**Status: NEW FINDING — P2**

Code evidence:
- `apps/api/src/credit-notes/credit-notes.service.ts` lines 19–27: `nextCnNumber()` calls `this.prisma.forTenant().creditNote.findFirst(...)` — no transaction client, no locking.
- Lines 65–75: `creditNote.create` happens after `nextCnNumber()` resolves, with no wrapping transaction.
- `apps/api/prisma/schema.prisma` line 1521: `@@unique([tenantId, creditNoteNumber])` IS present.

Same pattern as W10-002 standalone path: the unique constraint prevents silent corruption but will surface a 500 under concurrent credit note creation. The balance check at lines 52–62 (checking existing credits against invoice total) is ALSO outside any transaction, creating a TOCTOU window: two concurrent credit notes for the same invoice could both pass the balance check and both be created, exceeding the invoice total.

Severity: **P2**. Two issues: (a) CN number race caught by unique constraint → 500 error; (b) balance check TOCTOU → credit notes can collectively exceed invoice total.

---

### W10-004 — `routes.service.ts::completeStop` does not re-check stop status inside transaction
**Status: NEW FINDING — P2**

Code evidence:
- `apps/api/src/routes/routes.service.ts` lines 975–980: stop is read BEFORE the transaction with `this.prisma.forTenant().routeRunStop.findFirst(...)`. The `COMPLETED` check fires at line 980.
- Lines 987–1034: the `tenantTransaction` callback uses `stop.orders` (captured from the pre-transaction read at line 977) — it never re-reads the stop inside the transaction.
- `apps/api/src/orders/orders.service.ts` lines 1068–1073: BY CONTRAST, `orders.service.ts::completeStop` reads the stop INSIDE the transaction at line 1069 using `tx.routeRunStop.findFirst(...)`, providing a consistent view.

Two concurrent operator requests to `PATCH /route-runs/:runId/stops/:stopId/complete` via the routes path will both pass the pre-transaction status check (both see `IN_PROGRESS`), both enter the transaction, and both update the stop and orders. The second write is idempotent for the `routeRunStop.update` but the `deliveryMutation.create` loop will duplicate mutations for each order item if called twice.

Severity: **P2**. The `orders.service.ts` path correctly re-reads inside the transaction. The `routes.service.ts` path does not and is vulnerable to duplicate completion.

---

### W10-005 — `voidInvoice()` is not wrapped in a transaction and does not re-read status atomically
**Status: NEW FINDING — P2**

Code evidence:
- `apps/api/src/invoices/invoices.service.ts` lines 795–806: `voidInvoice()` calls `this.findOneOrThrow(id)` (a plain `findUnique`) then immediately calls `this.prisma.forTenant().invoice.update(...)`. There is no transaction wrapping these two operations.
- The status checks (lines 797–802) guard against voiding PAID or PARTIAL invoices, but between the `findOneOrThrow` read and the `update` write, a concurrent payment could transition the invoice from SENT → PARTIAL. The `update` would succeed and void a partially-paid invoice.
- By contrast, `recordPayment()` at line 1019 uses `tenantTransaction` with `SELECT ... FOR UPDATE` (line 1021).

Severity: **P2**. Race window between status read and void write can allow voiding a partially-paid invoice, leaving orphaned payment records against a VOID invoice.

---

### Downgraded/dismissed findings from W10 spec targets

**W10-001 (as framed in spec) — "no unique constraint" on `Order.orderNumber`:** The spec asked to check if `@@unique([tenantId, orderNumber])` exists and downgrade if found. Confirmed it does NOT exist (schema lines 828–836). The finding stands at P1 — no downgrade warranted.

**W10-003 (as framed in spec) — "no unique constraint" on `CreditNote.creditNoteNumber`:** The spec asked the same question. Confirmed `@@unique([tenantId, creditNoteNumber])` IS present at line 1521. The constraint partially mitigates the race (prevents silent duplicate) but does not prevent the 500 error or the TOCTOU balance-check window. Severity remains P2, not dismissible.

**W10-008 (credit note `create()` balance check inside transaction):** The `create()` method at lines 37–84 does NOT use `prisma.tenantTransaction`. Both the aggregate query (lines 52–55) and the `creditNote.create` (lines 65–75) run outside any transaction. This is confirmed as a TOCTOU defect included in W10-003 above.

---

## New findings W8 missed

### NEW-W8-A — `routes.service.ts::completeStop()` never auto-completes the RouteRun
**Severity: P2**

When an operator uses the web UI to complete the final stop of a run, `routes.service.ts::completeStop()` marks the stop COMPLETED but never checks whether all stops are done and never updates `RouteRun.status` to `COMPLETED`. The `orders.service.ts::completeStop()` path (lines 1332–1345) correctly performs this check.

Result: if an operator completes all stops from the web dashboard, the run remains `IN_PROGRESS` forever. The operator dashboard's live run list will show the run as still active, preventing dispatch of the next run for the same route (which blocks on an active run check in `createRun()` at lines 530–541).

### NEW-W8-B — No `emitRouteDispatched` emitter exists in the gateway
**Severity: P1 (supporting evidence for W8-001)**

`apps/api/src/gateways/routeflow.gateway.ts` lines 177–220: none of the 9 typed emitter methods targets the `driver:${userId}` room. The room is registered at connection time (line 142) but is an inert dead-end — no server-side code ever emits to it. This means even if `createRun()` were fixed to call a gateway method, the right method does not yet exist and would need to be added.

---

## Top 5 priorities from this batch

| Rank | ID | Title | Severity | File |
|------|----|-------|----------|------|
| 1 | W8-004 | Expo push tokens sent to FCM directly — 100% push delivery failure | P1 | `apps/mobile/lib/auth.ts:86`, `apps/api/src/notifications/notifications.service.ts:84` |
| 2 | W10-001 | Order number generation is a MAX+1 race with no unique constraint | P1 | `apps/api/src/orders/orders.service.ts:542–609`, `apps/api/prisma/schema.prisma:801` |
| 3 | W8-001 + NEW-W8-B | Dispatch emits nothing to driver; driver room is a dead-end | P1 | `apps/api/src/routes/routes.service.ts:490–606`, `apps/api/src/gateways/routeflow.gateway.ts:141` |
| 4 | NEW-W8-A | Operator-path `completeStop` never auto-completes RouteRun → dispatch deadlock | P2 | `apps/api/src/routes/routes.service.ts:987–1034` |
| 5 | W10-003 | Credit note balance check is a TOCTOU: two concurrent CNs can exceed invoice total | P2 | `apps/api/src/credit-notes/credit-notes.service.ts:37–84` |

---

## Supporting detail: `generateInvoiceNumber` safe vs. unsafe call sites

| Call site | Location | Inside transaction? | Unique constraint? | Risk |
|-----------|----------|---------------------|--------------------|------|
| `createInvoiceFromOrder(orderId, txClient)` | `invoices.service.ts:249` | Yes (when `txClient` provided) | Yes (`@@unique`) | Low |
| Standalone `createInvoice` path | `invoices.service.ts:350` | No | Yes (`@@unique`) | 500 on race |
| Inlined inside `completeStop` tx | `orders.service.ts:1265–1272` | Yes (`tx.invoice.findFirst`) | Yes (`@@unique`) | Low |

The `@@unique` constraint on `Invoice.invoiceNumber` means concurrent invoice creation fails loudly (unique constraint violation → Prisma error → 500) rather than silently. This is better than `Order.orderNumber` which has no constraint and silently duplicates.
