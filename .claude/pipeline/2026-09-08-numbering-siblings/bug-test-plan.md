# Bug test plan — numbering siblings Group A (B267 · B268 · B269 · B277-pin)

Design of record: `cause-ruling.md` §2. Facts that bind: `cause-refutation.md` (§1.3 literal map, §2.1 tx
isolation, §4 import branch, §5 payments, §8 provider sites). DB lane = `apps/api/src/**/*.db.spec.ts` run by
`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- <spec>"` against the compose
Postgres; copy the structure of `apps/api/src/invoices/invoice-numbering.db.spec.ts` (own throwaway
tenants, cleanup, helpers). Every REG test states its wrong value TODAY (L-060); pins state their colour.

## Red gate

### T1 — `apps/api/src/credit-notes/credit-note-numbering.db.spec.ts` (DB lane) — REG-B267

- T1a `REG-B267-A cross-tenant on a null tenant`: tenant B holds `CN-2026-0037`; with NO request tenant (the
  path a SUPER_ADMIN token takes) tenant A creates a credit note → expect a `BadRequestException`.
  TODAY: `CN-2026-0038` (unscoped scan). [Reconciled 2026-09-08 with the design of record,
  `cause-ruling.md` D2 — "`tenantId` explicit from the caller's context; null → the service throws";
  this line previously said mint `CN-2026-0001`, which D2 supersedes.]
- T1b `REG-B267-B the 9999 wall`: tenant A holds `…-9999` and `…-10000`; create → `CN-2026-10001`. TODAY:
  the scan re-derives `…-10000` → P2002 → unhandled 500.
- T1c `REG-B267-C lazy seed`: tenant A holds `CN-2026-0412`, no sequence row → first create `CN-2026-0413`
  and a `NumberingSequence (A, CREDIT_NOTE, 2026)` row at 414. TODAY: no row is ever written.
- T1d `REG-B267-D validate before reserve`: a create that fails validation (e.g. against a VOID invoice)
  leaves the sequence row untouched. TODAY: no sequence exists at all (structural) — the behavioural half is
  the "rejected → no number consumed" assertion after the fix; state both colours.
- T1e `REG-B267-E concurrency`: 5 parallel creates in one tenant → 5 distinct consecutive numbers, zero
  rejections. TODAY: ≥ 1 P2002/500.
- T1f `REG-B267-F collision guard`: a counter at 7 with `CN-2026-0007` already written in the tenant must
  skip the taken number → mint `CN-2026-0008` with no throw, row reads 9. TODAY: a wrong table in
  `findTaken`'s CREDIT_NOTE branch proves the taken candidate free, hands it out, and the create dies on
  `@@unique([tenantId, creditNoteNumber])` → a permanent 409.
- T1g `REG-B267-G foreign customer`: tenant A creating against tenant B's customer (no invoiceId) must 404
  — no CreditNote row in A and no number burned.

### T2 — `apps/api/src/invoices/payment-numbering.db.spec.ts` (DB lane, RED-GATE-only — the GREEN

sites-1/2 pin lives in the `-pins` sibling below) — REG-B269

- T2a `REG-B269-A two tenants' first settlements are distinct`: through the site-3 path (the settlement
  booking in `invoices.service.ts` reached from `apps/api/src/payment-requests/payment-requests.service.ts:853`), tenant A and tenant B each
  book their first payment with NO request tenant → numbers `PAY-<A>-0001` and `PAY-<B>-0001`. TODAY: both
  `PAY-0001` → the second throws P2002.
- T2b `REG-B269-B a rolled-back booking does not repeat the number`: force the booking tx to fail after the
  counter reservation (e.g. an invalid allocation) → the reservation survives, so the next booking mints
  the NEXT number. TODAY: no `PaymentCounter` row survives at all (the increment rolls back with the tx),
  so a retry mints the same `PAY-0001` again. The oracle asserts the surviving counter row advanced past
  its initial 1 — NOT an exact value — so it stays true for any reservation granularity D3 adopts, and
  stays independent of the GLOBAL `paymentNumber` namespace every other test in the file writes into.
- T2c `REG-B269-C null tenant refuses`: site 3 with no tenantId on the payment request → `BadRequestException`,
  no `"singleton"` counter write. TODAY: writes `PAY-####` from the singleton row.

#### `apps/api/src/invoices/payment-numbering-pins.db.spec.ts` (DB lane, GREEN-only sibling — split out

so the RED-GATE repro file above stays red under `-t REG-B26`)

- T2d `PIN-B269-D` (GREEN today and after — the id deliberately carries NO `REG-B26` substring so the
  red-gate filter `-t REG-B26` cannot collect it): sites 1/2 format `PAY-<tenantShort>-####` unchanged.

### T3 — `apps/api/src/import/import-numbering.db.spec.ts` (DB lane, RED-GATE-only — the GREEN

source-numbered pin lives in the `-pins` sibling below) — REG-B268

- T3a `REG-B268-A fallback rows reserve`: import two source-numberless rows into a tenant holding
  `INV-2026-0001` → they receive `INV-2026-0002`/`0003`, `created = 2`, `updated = 0`, and the live
  `INV-2026-0001` is untouched (status/dueDate/paidAt unchanged). TODAY: the first fallback row collides with
  `INV-2026-0001`, the importer UPDATES that live invoice and reports `updated = 1`.
- T3c `REG-B268-C re-import idempotency`: importing the SAME source-numberless PAID row twice into a
  fresh tenant must leave exactly ONE invoice and ONE synthetic payment; the second run reports
  `imported:0` and accounts for the row as updated-or-skipped. TODAY: the second run reserves a fresh
  number and creates a SECOND invoice (plus a second payment), doubling AR.
- T3d `REG-B268-D same-file ordering`: a numberless group listed FIRST and a group whose source
  `Invoice Number` is literally `INV-2026-0001` listed SECOND must both import — the source-numbered row
  keeps `INV-2026-0001` verbatim, the fallback row gets a DIFFERENT number, nothing is updated. TODAY: the
  fallback mint takes `INV-2026-0001` first and the source-numbered row silently UPDATES it instead of
  creating its own invoice.

#### `apps/api/src/import/import-numbering-pins.db.spec.ts` (DB lane, GREEN-only sibling — split out so

the RED-GATE repro file above stays red under `-t REG-B26`)

- T3b `PIN-B268-B rows with a source number keep it` (pin, GREEN today and after — the id deliberately
  carries NO `REG-B26` substring so `-t REG-B26` cannot collect it): `Invoice Number` present → stored
  verbatim; the upsert-by-number branch still runs for those, including on status drift.

### T4 — unit (`invoices.service.spec.ts`, `credit-notes.service.spec.ts`, `estimates.service.spec.ts`)

- REG-B269 pin: `nextPaymentNumber` requires a tenant (throws on null), formats `PAY-<short>-####`, and its
  counter write happens on a client that is NOT the payment tx (assert the upsert call target).
  `invoices.service.spec.ts` also carries the site-1/2/3 granular pins `REG-B269-pin-1` through
  `REG-B269-pin-6` (null-tenant refusal, format, and counter-client/keying assertions per site).
- REG-B267 pin: `create` calls `reserveNext("CREDIT_NOTE", { year, tenantId })` before `$transaction`.
  `credit-notes.service.spec.ts` also carries the P2002-mapping pins `REG-B267 P2002 (a)`/`(b)`/`(c)`
  (field-array target, constraint-name target → `ConflictException`; a non-numbering unique propagates
  unchanged).
- `REG-B277 pin` (GREEN after, red today only in the sense of "no catch"): `estimates.create` maps a
  P2002 on the estimate number into `ConflictException` (409), not a raw 500 — filter on the full
  `"REG-B277 pin"` string; the plain `"B277 pin"` substring also matches the sibling
  `B277 pin: a P2002 on a NON-number constraint propagates as the original error` test.

## Harness notes

- The 23 `Test.createTestingModule` sites in `cause-refutation.md` §8 need `{ provide: NumberingService,
useValue: { reserveNext: jest.fn() } }`; `PaymentCounter` mocks in `invoices.service.spec.ts` move to the
  standalone helper path.
- DB-lane specs seed and delete their own tenants (`e2e-*`/`qa-*` slugs); never touch shared fixtures.
- The settlement path in T2 must use the real `InvoicesService` + a mocked Stripe client only at the
  module boundary.
