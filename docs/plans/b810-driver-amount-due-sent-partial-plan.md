# B810 plan: driver's amount-to-collect ignores a SENT/PARTIAL invoice

**Status:** RULED (SA-125, superseded by SA-130a's Opus round) and IMPLEMENTED — server +
mobile, red-first, both sides green.
**Branch:** `fix/b810-driver-amount-due-sent-partial` (worktree `rf-lane-b810-driver-amount-due-sent-partial`, off `origin/master`).

## SA-130a round (Opus REQUIRED CHANGES on SA-125's original shape — supersedes it below)

Opus's review of the SA-125 implementation (PR #1319 at `60d432f3`) found two real defects the
mocked-Prisma specs could not see:

1. **BLOCKER:** SA-125's design nested `payableInvoices` under `RUN_STOP_INCLUDE.orders.select`
   as if it were a Prisma relation on `Order`. `Order` has no such relation — only `invoices`
   (sales.prisma:649) — so the REAL Prisma client throws `Unknown field 'payableInvoices'` on
   every one of the 4 run reads (findAllRuns, findOneRun's normal path and its fallback,
   findMyRuns). A mocked `PrismaService` happily returns whatever fixture shape a test hands it,
   so this was invisible to every one of my own unit tests until the type-checker was allowed to
   validate the real query shape (see "the `as const` trap" below).
   - **Fix:** `payableInvoices` is now a SEPARATE, batched `invoice.findMany` call
     (`run-invoice-balance.ts#payableInvoiceFindManyArgs`/`groupPayableInvoicesByOrder`/
     `attachPayableInvoices`, orchestrated by `withPayableInvoices`), run ONCE per response
     (never per-run/per-order) and attached onto the stops array after the main query returns.
     `RUN_STOP_INCLUDE.orders.select` never mentions `payableInvoices` again.
   - **The `as const` trap:** `payableInvoiceFindManyArgs`'s return value originally carried a
     top-level `as const`. That deep-froze the `select` object enough that Prisma's own generic
     `SelectSubset` inference could no longer narrow `invoice.findMany`'s return type to the
     selected fields — TypeScript silently fell back to the FULL `Invoice` model shape, so even
     `npx tsc --noEmit` passed against code that was actually broken. Removing the outer
     `as const` (keeping only `"asc" as const` on the two literal orderBy strings, which Prisma's
     literal-string orderBy typing does need) restored real inference, and `tsc` then correctly
     flagged the exact call sites — proof the fix works, not just that it compiles.
2. **MONEY:** the original composition (`reconciledAmountDue(...) + earlierVisitsRemaining(...)`,
   unconditionally) double-counts once an order has no open draft and its only payable is a
   plain, already-finalized invoice: a SENT $100 invoice, short-picked to ~$90 by a later visit's
   partial delivery, quoted ~$190 (the re-derived estimate PLUS the invoice's own full balance) —
   never $100, the actually-correct answer, since a previously-issued invoice doesn't retroactively
   change because a later visit short-picks.
   - **Fix — `run-money.ts#reconciledDoorDue`, the ONE decision point per order on the reconciled
     path:**
     - (a) an open draft exists → `reconciledEstimate + earlierVisitsRemaining(non-DRAFT payables)`
       — unchanged from SA-125, and also covers "no payable invoice at all yet" (reduces to the
       bare estimate).
     - (b) no open draft, the SOLE payable is a deposit mirror (`isDepositMirror`, SA-102's WP-D1
       shape) → the mirror IS the order's own bill, so restate it via `reconciledEstimate` (the
       SAME call, with an empty `drafts` — `reconciledAmountDue`'s own fallback basis) minus
       whatever it already collected (`mirror.total - mirror.balanceDue`).
     - (c) no open draft, a plain (non-mirror) payable → Σ `balanceDue` ONLY — the reconciled
       estimate is never added on top.
   - `isDepositMirror` is a new server-computed boolean on each payable row (SA-102's WP-D1
     shape, mirroring `reconcileOrderDraftInvoice`'s own detection in `invoices.service.ts`
     exactly: the order's SOLE non-void invoice, no `deliveryBatchId`, `depositPercent != null`,
     status SENT/VIEWED/PARTIAL/OVERDUE). `RunMoneyPayableInvoice` also gained `total` (needed
     for the mirror's already-paid subtraction).
3. **B822, two distinct halves — do not conflate them (SA-130b correction):**
   - **Server-side `balanceDue`** (`groupPayableInvoicesByOrder`): already uniform from the very
     first implementation — `total - confirmed payments` applies to every status including
     DRAFT, no per-status assumption. This alone does NOT fix the driver's on-screen number.
   - **Driver-side `reconciledDoorDue`** (SA-130b REQUIRED CHANGE, a separate defect from the
     server half above): `reconciledEstimate` is re-derived from the order's CURRENT line items
     and has no idea a confirmed payment already landed against THIS visit's own open draft(s).
     Case (a) now explicitly subtracts `Σ_DRAFT(total - balanceDue)` before adding
     `earlierVisitsRemaining`. SA-130b's own repro: order 100, a 40 advance applied on the DRAFT,
     short-picked to an estimate of 90 — the server collects 50 (`recordDeliveryPaymentInTx`);
     before this fix the driver was quoted the un-netted 90. Pinned with those exact numbers.
4. **The flagged `any`s removed:** `run-invoice-balance.ts`'s old `withRunOrderBalances<T extends
{orders?: any[]}>` is gone (replaced by properly-generic `attachPayableInvoices`/
   `withPayableInvoices`); `routes.service.ts`'s `orders as any[]` cast (introduced by the
   original SA-125 implementation, not pre-existing) is gone too.
5. **Standing gate this round established:** any Prisma `select`/`include` change must be proven
   against a REAL Postgres — a mocked-Prisma spec cannot catch a schema/query mismatch (see
   finding 1 above). `run-invoice-balance.db.spec.ts` (7 cases) is the proof for this query;
   `npm run local:test:db` or a compose run is the gate before this PR can land.

## Original SA-125 ruling (superseded above where noted, otherwise still accurate)

## The bug

`RUN_STOP_INCLUDE` (`apps/api/src/routes/routes.constants.ts`) projected an order's invoices
with `where: { status: InvoiceStatus.DRAFT, deliveryBatchId: null }` — DRAFT only. Mobile's
`orderAmountDue` (`apps/mobile/lib/run-money.ts`) summed those drafts' `total` when any existed;
when the array was empty it fell back to computing the order's OWN total from
`subtotal`/`tax`/`discount`/`shippingFee`.

If the order's invoice had already progressed to SENT or PARTIAL (the office issued it, or a
prior partial payment landed), `order.invoices` was empty under the DRAFT-only filter, so
`orderAmountDue` took the order-total fallback — the **full** order total, ignoring that the
customer may already owe less (partial payment) or that the issued invoice's total legitimately
differs from the order's live total (an edited/merged order after issuance). The driver was shown
the wrong amount to collect.

## Ground truth: what the driver's actual payment write path does

`recordDeliveryPaymentInTx` (`apps/api/src/invoices/invoices.service.ts:5041`) is what actually
applies a driver-collected payment. Its shape is the one the projection must never disagree
with — see the original excerpt below, unchanged by this fix:

```ts
// apps/api/src/invoices/invoices.service.ts:5116-5150 (abridged)
const invoices = await tx.invoice.findMany({
  where: { orderId: { in: orderIds }, status: { in: PAYABLE } },   // NOT just DRAFT
  orderBy: [{ createdAt: "asc" }, { invoiceNumber: "asc" }],
  select: { id: true, total: true, status: true, ... },
});
for (const inv of invoices) {
  const priorPayments = await tx.invoicePayment.findMany({
    where: { invoiceId: inv.id, ...CONFIRMED_PAYMENT },
    select: { amount: true },
  });
  const alreadyPaid = priorPayments.reduce((s, p) => s + Number(p.amount), 0);
  const invRemaining = roundMoney(Number(inv.total) - alreadyPaid);
  // spread the collected lump sum oldest-first, capped at invRemaining
}
```

`PAYABLE` (`apps/api/src/invoices/invoice-status-sets.ts`) = `[DRAFT, SENT, PARTIAL, OVERDUE]`
— an ALLOW-list, excluding the terminal `PAID`/`VOID`/`WRITTEN_OFF`. `CONFIRMED_PAYMENT`/
`sumConfirmed`/`splitConfirmed` live in `@routeflow/pricing` (shared, not API-only) — the one
recipe, never a mirror.

## SA-125 ruling (binding, as implemented)

The SA reviewed this plan's draft proposal (widen `RUN_STOP_INCLUDE.orders.select.invoices`
itself to `PAYABLE`) and instead ruled for a **two-list design**, to keep the existing DRAFT-only
projection's blast radius at zero:

1. **`RUN_STOP_INCLUDE.orders.select.invoices` stays byte-identical** — untouched, still
   DRAFT-only, still gated by `deliveryBatchId: null`. It remains `reconciledAmountDue`'s own
   reconcile basis (the short-pick/active-delivery estimate) and the B305 "open draft" read —
   nothing else in the codebase may start assuming this list means "everything payable."
   Pinned by a `toEqual` test against its exact pre-B810 shape
   (`routes.run-stop-select.spec.ts`).
2. **A new, separate `payableInvoices` projection** mirrors `recordDeliveryPaymentInTx`'s exact
   predicate — `status: { in: PAYABLE }`, **no `deliveryBatchId` gate** (answers open question
   #2 below: the write path never gates on it, so the read path must not invent one), same
   `orderBy` (oldest-first). Each row is server-computed to `{ id, status, balanceDue }` —
   `balanceDue = roundMoney(Math.max(0, total - sumConfirmed(payments)))`, applied **uniformly**
   to every status including DRAFT (answers open question #3: uniform, not DRAFT-special-cased —
   it reduces to `total` for DRAFT anyway since a draft never carries payments, so this is free
   and removes an assumption). Raw `payments` rows never reach the response.
3. **Mobile's `orderAmountDue`** reads `payableInvoices[].balanceDue` instead of
   `invoices[].total` — the actual bug fix. The order-total fallback still fires only when
   `payableInvoices` is empty.
4. **A new `earlierVisitsRemaining(payableInvoices)` function**, NOT a change to
   `reconciledAmountDue` itself (answers open question #4: `reconciledAmountDue` stays
   out of scope in code, but its _input_ to the driver's screen changes — see below). It sums
   `balanceDue` over every payable invoice whose status is **not** DRAFT — the money a prior
   visit left owing on a regulated split order.
5. **`payment.tsx`'s reconciled branch composes both**: on the RECONCILED path, the driver's
   total is `reconciledAmountDue(drafts…) + earlierVisitsRemaining(payableInvoices)` — THIS
   visit's estimate plus whatever an earlier visit on the same order still owes. Without the
   second term, a part-paid earlier invoice on a split order would silently vanish from the
   driver's total the moment any order on the stop gets short-picked.
6. **Module boundary** (answers open question #6): extracted to a new file,
   `apps/api/src/routes/run-invoice-balance.ts` (`withBalanceDue`, `withRunOrderBalances`,
   `RUN_PAYABLE_INVOICE_SELECT`), not inlined across `routes.service.ts`'s 4 call sites.
7. **Field name** (answers open question #1): `balanceDue`, matching `findOne`'s existing B421
   field — same formula, different endpoint, deliberately the same name.
8. **Query cost** (answers open question #5): shipped as a nested Prisma `include` per invoice
   (`payments: { select: { amount, status } }`), same shape as every other nested read in
   `RUN_STOP_INCLUDE`; no evidence of a performance problem, so no aggregate-query rework was
   required up front.

## 1. The server projection (as implemented)

- **`apps/api/src/routes/run-invoice-balance.ts`** (new): `RUN_PAYABLE_INVOICE_SELECT` (the
  Prisma `where`/`orderBy`/`select` for the new list), `withBalanceDue(invoices)` (maps raw
  invoice+payments rows to `{ id, status, balanceDue }`, stripping `payments`), and
  `withRunOrderBalances(stops)` (applies `withBalanceDue` to every order's `payableInvoices`
  across a whole `stops` array).
- **`routes.constants.ts`**: `RUN_STOP_INCLUDE.orders.select.payableInvoices =
RUN_PAYABLE_INVOICE_SELECT`, added alongside (never replacing) the existing `invoices` select.
- **`routes.service.ts`**: `withRunOrderBalances`/`withBalanceDue` applied at all 4 read sites
  (`findAllRuns`, `findOneRun`'s normal path, `findOneRun`'s unlinked-orders fallback,
  `findMyRuns`) so every run-read response carries balance-corrected `payableInvoices`.

## 2. The mobile change (as implemented)

- `apps/mobile/lib/api/routes.ts`: `RouteRunOrder.payableInvoices?: Array<{ id, status,
balanceDue }>` added alongside the untouched `invoices` field.
- `apps/mobile/lib/run-money.ts`: new `RunMoneyPayableInvoice` type; `RunMoneyOrder` gains
  `payableInvoices?: RunMoneyPayableInvoice[]`. `orderAmountDue`'s primary branch now sums
  `payableInvoices[].balanceDue` (was `invoices[].total`) — the fallback formula below is
  unchanged. New exported `earlierVisitsRemaining(payableInvoices)`.
- `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx`: the reconciled branch's
  `invoiceTotal` composition now adds `earlierVisitsRemaining(o.payableInvoices ?? [])` to
  `reconciledAmountDue(...)`'s result. The non-reconciled (`fullOrderTotal`) branch needed no
  change — it benefits automatically from `orderAmountDue`'s own fix.

## 3. Pins (red-first, both sides — all implemented and verified)

**Server** (`apps/api/src/routes/run-invoice-balance.spec.ts`, 13 tests;
`routes.run-stop-select.spec.ts`, +2; `routes.service.spec.ts`, +4 — 133 tests total across the
3 files, genuinely red-first: implemented, reverted, confirmed the 4 `routes.service.spec.ts`
cases failed showing raw `payments`/`total` in the mismatch, reapplied, byte-diff-confirmed):

- A SENT invoice with a confirmed partial payment → `balanceDue = total - paid`, not `total`.
- A PARTIAL invoice → same formula. An OVERDUE invoice → same formula (still in `PAYABLE`).
- A DRAFT invoice with no payments → `balanceDue === total` (byte-identical to the old number).
- Raw `payments` rows never present on the returned shape (`JSON.stringify` never contains
  `"payments"`).
- Multiple PAYABLE siblings (regulated split) → each contributes its own `balanceDue`.
- `RUN_STOP_INCLUDE.orders.select.invoices` stays byte-identical to its exact pre-B810 shape.
- `RUN_STOP_INCLUDE.orders.select.payableInvoices` is `RUN_PAYABLE_INVOICE_SELECT` by identity.

**Mobile** (`__tests__/run-money.test.ts`, extended: 7 pre-existing `orderAmountDue`/
`stopAmountDue` fixtures migrated from `invoices`/`total` to `payableInvoices`/`balanceDue`
— verified byte-identical outcomes for the no-payment case both before and after migration —
plus new `REG-B810` blocks, genuinely red-first against the pre-fix `run-money.ts`):

- `orderAmountDue` sums a SENT invoice's `balanceDue` (paid-down), never its raw `total`.
- A PARTIAL and an OVERDUE invoice's `balanceDue` are each used as-is.
- SA-125's own worked example: DRAFT 50 + PARTIAL (total 100, paid 40 → balanceDue 60) → 110,
  never 150 (the old bug's shape: DRAFT's total plus the PARTIAL's raw total).
- `earlierVisitsRemaining`: sums non-DRAFT `balanceDue`, excludes DRAFT, empty-list → 0,
  coerces string-Decimal and rounds, ignores a non-finite value rather than producing NaN.

## Answered open questions (superseded by the SA-125 ruling above)

1. Field name → `balanceDue`. 2. `deliveryBatchId` → not applied to the new list (mirrors the
   write path exactly). 3. DRAFT special-casing → uniform formula, no special case. 4.
   `reconciledAmountDue` → unchanged in code; its caller now adds `earlierVisitsRemaining`
   separately. 5. Query cost → nested include, no rework required. 6. Module split → yes, new
   `run-invoice-balance.ts`.
