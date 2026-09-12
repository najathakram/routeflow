# Bug test plan: B134 B135 B214, train 4 Run A (at-door approval tx boundary + invoice-delete credit orphaning)

> **Model note:** bug-pipeline policy assigns S4 to Fable 5.1. Fable was out of usage credits on 2026-09-10
> (direct probe: HTTP 429), so **Opus 5 wrote this plan as the documented fallback**.
> Inputs: `local-assets/handoff/2026-09-09/planning/train4/cause-{brief,refutation,ruling}.md`, re-grounded at
> master `edd379bf` (every cited line matched). Sonnet writes the tests inside the engine. The red bar is
> **behavioral**: every REG test must fail today on the wrong value named in its row. Each `it()` has one oracle
> (a precondition may be awaited with `.catch(e => e)`, but it is never a second assertion).
> Build plan: `build-plan.md` (same directory). Test ids T1 to T10 are REG, P1 to P7 are pins.

## Red set (REG-tagged; in the red gate)

All unit tests go in `apps/api/src/orders/orders.service.spec.ts`. T1 to T7 go in a new
`describe("approveChangeRequestAtStop: tx boundary (B134/B135)")` nested inside the existing
`describe("approveChangeRequestAtStop (P5-09)")` (~line 6013), so they inherit `baseCr`, `baseOrder` and the outer
`beforeEach` (claim count 1, customer, revision aggregate). T8 goes in the existing
`describe("deleteOrder — delete-any")` (~line 2733), so it inherits `deliveredOrder` and its `beforeEach`. T9 and T10
go in the new DB-lane file `apps/api/src/invoices/invoice-delete-credit.db.spec.ts`, which this change creates.

**Shared unit fixture for T1 to T7** (copied from the first existing test's line):

```ts
const line = {
  id: "li-1",
  orderId: "ord-1",
  productId: "prod-1",
  qty: 24,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 12,
  unitPrice: 24,
  subtotal: 48,
  status: "PENDING",
  deliveredQty: 0,
};
prisma.changeRequest.findUnique.mockResolvedValue(
  baseCr({ type: "CHANGE_QTY", orderItemId: "li-1", payload: { orderItemId: "li-1", newQty: 18 } }),
); // a DECREASE, so the stock guard never fires
prisma.orderItem.findMany.mockResolvedValue([
  {
    id: "li-1",
    productId: "prod-1",
    qty: 18,
    unitPrice: 24,
    subtotal: 36,
    status: "PENDING",
    deliveredQty: 0,
  },
]);
```

**Capturing the merge tx (T1 to T3).** The default `tenantTransaction` mock builds a fresh tx object on each call.
Capture it with a one-time override. The at-door merge is the first `tenantTransaction` call in the flow.

```ts
const seenTx: any = {
  ...prisma.forTenant(),
  $executeRaw: jest.fn().mockResolvedValue(0),
  $queryRaw: jest.fn().mockResolvedValue([]),
};
prisma.tenantTransaction.mockImplementationOnce((fn: any) => fn(seenTx));
prisma.order.findUnique.mockResolvedValue(baseOrder([line]));
```

**Discriminating the in-tx re-read (T4 to T6).** The pre-tx fetch uses `include`. The fixed code's in-tx re-read
uses `select` with a `routeRunStop` key (build-plan WP3). Drive both from one mock:

```ts
prisma.order.findUnique.mockImplementation(async (args: any) =>
  args?.select?.routeRunStop ? LIVE_ROW : baseOrder([line]),
);
```

| T#  | Title (starts with the REG token)                                                                                 | Setup                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Asserts (the one oracle)                                                                                                                                  | Fails TODAY with                                                                                                                                                     | After fix                                         | File                             |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| T1  | `REG-B134 (T1): the invoice un-send runs inside the merge transaction (receives the tx)`                          | shared fixture + `seenTx` capture; the call succeeds                                                                                                                                                                                                                                                                                                                                                                                                         | `expect(invoicesService.revertLinkedInvoicesForOrderEdit.mock.calls[0]?.[1]).toBe(seenTx)`                                                                | `expected <tx object>, received undefined`: today the call is `("ord-1")`, one argument, made before the tx opens                                                    | received `seenTx`                                 | orders.service.spec.ts           |
| T2  | `REG-B134 (T2): the un-send runs after the order row lock, never before it`                                       | shared fixture + `seenTx` capture                                                                                                                                                                                                                                                                                                                                                                                                                            | `expect(revert.mock.invocationCallOrder[0]).toBeGreaterThan(seenTx.$executeRaw.mock.invocationCallOrder[0])`                                              | `expected N to be greater than M` with N < M: revert runs before `tenantTransaction` is even entered                                                                 | revert order > lock order                         | orders.service.spec.ts           |
| T3  | `REG-B134 (T3): when the merge fails (lost claim), the un-send went through the rolled-back tx`                   | shared fixture + `seenTx` capture + `prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 })`; `await service.approveChangeRequestAtStop("cr-1", operatorPayload, null).catch((e) => e)`                                                                                                                                                                                                                                                             | `expect(invoicesService.revertLinkedInvoicesForOrderEdit.mock.calls[0]?.[1]).toBe(seenTx)`                                                                | `expected <tx object>, received undefined`: the invoice was un-sent through the non-transactional client, so the failed merge cannot roll it back (the B134 symptom) | received `seenTx`                                 | orders.service.spec.ts           |
| T4  | `REG-B135 (T4): a stop completed between the snapshot and the lock refuses with STOP_ALREADY_COMPLETED`           | shared fixture; `LIVE_ROW = { tenantId: "test-tenant", status: "OUT_FOR_DELIVERY", routeRun: { status: "IN_PROGRESS" }, routeRunStop: { status: "COMPLETED" } }`                                                                                                                                                                                                                                                                                             | `await expect(service.approveChangeRequestAtStop("cr-1", operatorPayload, null)).rejects.toMatchObject({ response: { code: "STOP_ALREADY_COMPLETED" } })` | `Received promise resolved instead of rejected`, resolved to `{ merged: true, subtotal: …, tax: …, total: … }`: nothing re-reads the stop in-tx                      | rejects 409 STOP_ALREADY_COMPLETED                | orders.service.spec.ts           |
| T5  | `REG-B135 (T5): an order that went DELIVERED between the snapshot and the lock refuses (ORDER_STATUS)`            | as T4 with `LIVE_ROW.status = "DELIVERED"` and `routeRunStop.status = "PENDING"`                                                                                                                                                                                                                                                                                                                                                                             | `rejects.toMatchObject({ response: { code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" } })`                                                           | resolved to `{ merged: true, … }`                                                                                                                                    | rejects 409 CHANGE_WINDOW_CLOSED / ORDER_STATUS   | orders.service.spec.ts           |
| T6  | `REG-B135 (T6): a run that left IN_PROGRESS between the snapshot and the lock refuses (RUN_NOT_ACTIVE)`           | as T4 with `LIVE_ROW.routeRun.status = "COMPLETED"` and `routeRunStop.status = "PENDING"`                                                                                                                                                                                                                                                                                                                                                                    | `rejects.toMatchObject({ response: { code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" } })`                                                         | resolved to `{ merged: true, … }`                                                                                                                                    | rejects 409 CHANGE_WINDOW_CLOSED / RUN_NOT_ACTIVE | orders.service.spec.ts           |
| T7  | `REG-B135 (T7): LINE_ALREADY_DELIVERED is judged on the locked in-tx line, not the pre-tx snapshot`               | shared fixture (snapshot line `deliveredQty: 0`, `order.findUnique.mockResolvedValue(baseOrder([line]))`), but `prisma.orderItem.findMany.mockResolvedValue([{ id: "li-1", productId: "prod-1", qty: 24, unitPrice: 24, subtotal: 48, status: "PENDING", deliveredQty: 24 }])`. **The held row MUST carry `id` and `deliveredQty`, or the test passes vacuously**                                                                                            | `rejects.toMatchObject({ response: { code: "LINE_ALREADY_DELIVERED" } })`                                                                                 | resolved to `{ merged: true, … }`: the guard reads `order.lineItems` (deliveredQty 0)                                                                                | rejects 409 LINE_ALREADY_DELIVERED                | orders.service.spec.ts           |
| T8  | `REG-B214 (T8): deleteOrder refuses (409) while an invoice it deletes sourced a credit note with unspent balance` | inherits `deliveredOrder` (`invoices: [{ id: "d1" }]`, DELIVERED; `order.findFirst` set by the describe's `beforeEach`); `prisma.order.findUnique.mockResolvedValue(deliveredOrder)`; `prisma.creditNote.findMany.mockResolvedValue([{ id: "cn-1", creditNoteNumber: "CN-0001", invoiceId: "d1", amount: 50, amountUsed: 0, status: "ISSUED", expiresAt: null }])`. **`invoiceId` must equal "d1"**, because the helper drops rows sourced by other invoices | `await expect(service.deleteOrder("ord-1", operatorPayload)).rejects.toMatchObject({ response: { code: "INVOICE_HAS_UNSPENT_CREDIT" } })`                 | resolved to `{ success: true }`: today the loop hard-deletes "d1" and the FK (`ON DELETE SET NULL`, `0_init/migration.sql:3783`) orphans cn-1                        | rejects 409 INVOICE_HAS_UNSPENT_CREDIT            | orders.service.spec.ts           |
| T9  | `REG-B214 (T9): deleteInvoice refuses (409) while a credit note it sourced has unspent balance (real Postgres)`   | DB lane: fresh throwaway tenant, customer, invoice `status: "SENT"`, credit note `{ invoiceId: inv.id, amount: 50, amountUsed: 0, status: "ISSUED", expiresAt: null }`; `tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id))`                                                                                                                                                                                                                   | `rejects.toMatchObject({ response: { code: "INVOICE_HAS_UNSPENT_CREDIT" } })`                                                                             | resolved to `{ id: "<inv.id>", message: "Invoice deleted successfully" }`                                                                                            | rejects 409                                       | invoice-delete-credit.db.spec.ts |
| T10 | `REG-B214 (T10): after the refused delete, the credit note is still linked to its invoice`                        | same seed as T9 but in its own tenant, so the test stands alone; attempt the delete with `.catch((e) => e)`, then `const noteAfter = await prisma.creditNote.findUnique({ where: { id: cn.id } })`                                                                                                                                                                                                                                                           | `expect(noteAfter?.invoiceId).toBe(inv.id)`                                                                                                               | `expected "<inv.id>", received null`: the `updateMany({ invoiceId: null })` unlink committed with the delete, leaving a spendable, provenance-less note              | `inv.id` (the tx rolled back)                     | invoice-delete-credit.db.spec.ts |

## Pins (no REG token; outside the red gate; green today AND green after)

| T#  | Frozen behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                | File                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| P1  | `deleteOrder` with a **fully spent** sourced note (`invoiceId: "d1", amount: 50, amountUsed: 50, status: "APPLIED", expiresAt: null`) still resolves `{ success: true }`                                                                                                                                                                                                                                                                                       | orders.service.spec.ts (delete-any describe)    |
| P2  | `deleteOrder` with a **VOID** sourced note (`invoiceId: "d1", amount: 50, amountUsed: 0, status: "VOID"`) still resolves `{ success: true }`                                                                                                                                                                                                                                                                                                                   | orders.service.spec.ts (delete-any describe)    |
| P3  | `deleteOrder` with an **expired** unspent sourced note (`invoiceId: "d1", amount: 50, amountUsed: 0, status: "ISSUED", expiresAt: new Date(Date.now() - 86_400_000)`) still resolves `{ success: true }`. This follows the canonical open predicate: an expired note is not open                                                                                                                                                                               | orders.service.spec.ts (delete-any describe)    |
| P4  | The at-door approval still aborts **before any claim** when the un-send throws for recorded payments: `invoicesService.revertLinkedInvoicesForOrderEdit.mockRejectedValueOnce(new BadRequestException("invoice has payments recorded"))`, call with `.catch((e) => e)`, then `expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled()`. Green today because the revert throws before the tx; green after because WP3 places the revert BEFORE the claim | orders.service.spec.ts (the B134/B135 describe) |
| P5  | DB: `deleteInvoice` with a **fully spent** sourced note (`amount: 50, amountUsed: 50, status: "APPLIED"`) resolves, and the note row then reads `invoiceId: null`. The existing unlink of spent notes is preserved                                                                                                                                                                                                                                             | invoice-delete-credit.db.spec.ts                |
| P6  | DB: `deleteInvoice` with an **expired** unspent sourced note (`expiresAt` = yesterday) resolves `{ id, message: "Invoice deleted successfully" }`                                                                                                                                                                                                                                                                                                              | invoice-delete-credit.db.spec.ts                |
| P7  | DB: `deleteInvoice` with a **VOID** sourced note (`amountUsed: 0`) resolves `{ id, message: "Invoice deleted successfully" }`                                                                                                                                                                                                                                                                                                                                  | invoice-delete-credit.db.spec.ts                |

Existing coverage that must stay green without edits:

- the 12 `approveChangeRequestAtStop (P5-09)` tests
- the promo/BOGO door test (`orders-promo-bogo.spec.ts` ~629)
- `credit-notes.wallet-integrity.spec.ts` T1/T2/T5/T6/T7/T9/T10/T11 (the void door)
- `orders.lifecycle-conservation.spec.ts` T10 (REG-B65, deleteOrder ledger order)
- `customers.purge-ledger.spec.ts`
- the 5 existing `deleteOrder — delete-any` tests

## DB-lane file shape (`apps/api/src/invoices/invoice-delete-credit.db.spec.ts`, NEW)

- Copy these **verbatim** from `apps/api/src/invoices/invoice-numbering.db.spec.ts`: the two `jest.mock` shims and the
  imports (~lines 44-72 (jest.mock shims 44-52, imports 53-72)), the collaborator mocks (~100-140) and the `beforeAll` TestingModule wiring (~142-184). Keep
  the providers list unchanged, including `EstimatesService` and the real `NumberingService`, so that InvoicesService's
  constructor resolves. The commission mock there already has `removeInvoiceCommission`. The `RegulatedLedgerService`
  mock already has `reverseInvoiceEntries`.
- Wrap in `describeDb("B214 invoice delete vs sourced credit notes — real Postgres", …)` and call
  `requireLocalDatabaseUrl()` inside `beforeAll` (helpers in `apps/api/src/common/testing/db-spec.ts`). Nothing
  env-dependent runs at collection time.
- Tenants: `assertTestTenant(\`qa-b214-${RUN_SUFFIX}-${n}-${label}\`, "invoice-delete-credit.db.spec.ts")`(from`scripts/lib/test-tenants.cjs`, required as the numbering spec does). Use one fresh tenant per test so each oracle
stands alone. Copy the `seedTenant`/`seedCustomer` pair (~lines 207-233) and change the name text to B214.
- Seed invoice: `prisma.invoice.create({ data: { tenantId, customerId, invoiceNumber: \`INV-B214-${RUN_SUFFIX}-${n}\`, status: "SENT", subtotal: 50, total: 50 } })`.
- Seed note: `prisma.creditNote.create({ data: { tenantId, customerId, invoiceId: inv.id, creditNoteNumber: \`CN-B214-${RUN_SUFFIX}-${n}\`, amount: 50, amountUsed: <0|50>, status: <"ISSUED"|"APPLIED"|"VOID">, expiresAt: <null|yesterday> } })`.
- `afterAll` cleans up each created tenant in FK order: `creditNote.deleteMany` → `invoiceItem.deleteMany` →
  `invoice.deleteMany` → `customer.deleteMany` → `user.deleteMany` → `tenant.delete`. The cleanup is best-effort
  `.catch(() => {})`, followed by `prisma.$disconnect()`.

## Harness notes (verified by the engine's harness-integrity check)

- **No existing mock needs a signature change.** `revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([])` is
  argument-agnostic, so the added `tx` argument still resolves.
- **In-tx re-read (WP3) vs the 12 existing approve tests.** They all set
  `prisma.order.findUnique.mockResolvedValue(baseOrder(...))` (persistent, not `Once`), and `tx.order` in the mock is the
  same `jest.fn`. The new in-tx `findUnique` therefore receives `baseOrder(...)`: OUT_FOR_DELIVERY, run IN_PROGRESS,
  stop PENDING, so the guards pass. `orders-promo-bogo.spec.ts:607` also uses `mockResolvedValue`. **Check:** no test in
  the block uses `mockResolvedValueOnce` on `order.findUnique`. **Remedy if one does:** turn it into
  `mockResolvedValue` in the same edit.
- **heldItems lookup (WP3).** The held row is looked up by `id` and falls back to the snapshot line when absent, so
  existing tests keep today's behavior. That covers rows without `id`/`deliveredQty`, and the REMOVE_ITEM test (~6244)
  that returns `[]`. **Check:** no existing CHANGE_QTY/REMOVE_ITEM test returns a held row with `id: "li-1"` and
  `status: "CANCELLED"`, because that row would now be refused. **Remedy:** set that row's status to "PENDING".
- **deleteOrder callers.** `creditNote.findMany` defaults to `[]` in `apps/api/src/testing/prisma-mock.ts`, so every
  existing deleteOrder test sees no sourced notes and the helper passes. That covers delete-any, lifecycle-conservation
  T10, security, scan-hardening and the change-requests compensation. No `deleteInvoice` unit spec exists.
- **The DB-lane file** needs the compose Postgres, which is already up on this machine. Only `jest.db.config.js`
  collects it; the main api jest config ignores `\.db\.spec\.ts$`.

## Commands

- Red gate (both must FAIL, on the values above):
  - `cd apps/api && npx jest --reporters=default src/orders/orders.service.spec.ts -t "REG-B134|REG-B135|REG-B214"`
  - `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- invoice-delete-credit -t REG-B214"`
- `--reporters=default` stops a scoped run from overwriting `.campaign/runs/api.json` (L-063). Never drop it from a
  scoped api jest command.
- **Registry proof lines:** B134 → T1/T3, B135 → T4/T7, B214 → **T8** (unit). The DB lane's reporter is `default`, so
  T9/T10 tokens never reach the campaign report. Cite them as supporting evidence only. `campaign-check` needs a unit
  REG-B214 title, which T8 provides.
