# Light loop — round 2b (Fable ruling over E1's findings) — F16b / B100

E1 implemented D1 by HOISTING the reservation above each caller's transaction after the DB lane refuted the
nested form (a nested `$transaction` needs a second pooled connection while the caller holds one; pool max
10; REG-B100-C 7/10 rejected). Accepted. Residuals E1 named, ruled here:

| E1 finding                                                                                                                                                                                                                   | Ruling                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (3) `routes.service.ts:2573 → recordDeliveryPaymentInTx → createInvoiceFromOrder(orderId, tx)` still reserves NESTED inside the routes transaction — the delivery path can starve the pool under concurrent stop completions | **FIX — D7**: an in-transaction caller reserves ON its own transaction client (no nested tx). It holds the counter row lock until its commit; that is safe now because office paths reserve standalone and never hold another lock while holding the counter → no lock-order cycle; concurrent deliveries of one tenant serialize on the counter for the routes tx's duration (a wait, not a failure). |
| (4) jump `update { nextNumber: target }` is an absolute set → a 3-way interleave could re-issue a number (spurious 409)                                                                                                      | **FIX — D8**: `SET "nextNumber" = GREATEST("nextNumber", $target)` via `$executeRaw`; update the one expectation in `numbering.service.spec.ts`.                                                                                                                                                                                                                                                       |
| (5) a rejected `convertToInvoice` (not ACCEPTED / not found) burns a number                                                                                                                                                  | **FIX — D9**: read + validate the estimate (exists, ACCEPTED) BEFORE reserving; the atomic claim inside the tx stays (a race loser burns a number — accepted, rare).                                                                                                                                                                                                                                   |
| (6) `invoices.service.spec.ts:318-395` REG-B100-G describe retired                                                                                                                                                           | **FIX — D10**: delete it (both tests + its comment block).                                                                                                                                                                                                                                                                                                                                             |
| (7) `estimates.service.ts create()` has no P2002 → 409 catch                                                                                                                                                                 | **FILE** (LOW) in the docs follow-up.                                                                                                                                                                                                                                                                                                                                                                  |
| (2) `mintForYear`/`scanMaxForYear`/`findTaken` parameterized by `YearScopedDocType` with literal table/column branches                                                                                                       | **ACCEPT** (no dynamic SQL).                                                                                                                                                                                                                                                                                                                                                                           |

## Designs

**D7 (Opus `high`) — `apps/api/src/import/numbering.service.ts`, `apps/api/src/invoices/invoices.service.ts`.**
`reserveNext(docType, opts?: { year?: number; tenantId?: string; tx?: Prisma.TransactionClient })`: when
`opts.tx` is given, run the reservation statements (findUnique → lazy seed → increment → clash/jump) on `tx`
directly, opening NO transaction; otherwise the standalone `tenantTransaction` E1 built. Docblock: "Pass `tx`
ONLY when you are already inside a transaction (the delivery path); you then hold the counter row lock until
your commit. Standalone callers must never hold another row lock while reserving." `generateInvoiceNumber(tenantId?, tx?)`
forwards `tx`. In `createInvoiceFromOrder(orderId, txClient?)` and `createSplitInvoices(…, db)`: when the
client is a transaction (`db !== this.prisma`), reserve with `{ tx: db }` inside `runCreation(db)` (right
before the insert); when it is the base client, keep E1's hoisted standalone reservation. Same rule for
`createPartialFromOrder`/`duplicate()` if they ever receive a tx. Invariant: no nested `$transaction` anywhere
on a mint; standalone reservations hold no other lock.
Pin (unit, `invoices.service.spec.ts`): `createInvoiceFromOrder(orderId, txMock)` → `reserveNext` called with
`{ tx: txMock }` and `prisma.tenantTransaction`/`$transaction` NOT called for the reservation; and the
no-tx path → `reserveNext` called without `tx`.

**D8 (Opus, same executor) — `numbering.service.ts` jump:** `$executeRaw` UPDATE with `GREATEST` on the
`(tenantId, docType, year)` row; adjust the `numbering.service.spec.ts` expectation (`toHaveBeenNthCalledWith(2, …{nextNumber:301})`)
to the raw call (assert the SQL text contains `GREATEST` and the target parameter).

**D9 (Opus, same executor) — `estimates.service.ts convertToInvoice`:** validate before reserving (read the
estimate; not found → NotFound; status ≠ ACCEPTED → the existing error) then reserve, then the tx with the
atomic claim as today.

**D10 (same executor) — `invoices.service.spec.ts:318-395`:** delete the REG-B100-G describe.

Gates: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`; `npx jest src/import src/invoices src/estimates --runInBand`
(expect all green); DB lane on `invoice-numbering.db.spec.ts` (12/12 must stay). Then the scoped Opus re-check
(D1–D10) + final gates → land.
