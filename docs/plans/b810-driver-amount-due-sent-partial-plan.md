# B810 plan: driver's amount-to-collect ignores a SENT/PARTIAL invoice

**Status:** DRAFT — awaiting SA ruling on the projection shape before any code is written.
**Branch:** `fix/b810-driver-amount-due-sent-partial` (worktree `rf-lane-b810-driver-amount-due-sent-partial`, off `origin/master`).

## The bug

`RUN_STOP_INCLUDE` (`apps/api/src/routes/routes.constants.ts:79-89`) projects an order's
invoices with `where: { status: InvoiceStatus.DRAFT, deliveryBatchId: null }` — DRAFT only.
Mobile's `orderAmountDue` (`apps/mobile/lib/run-money.ts:189`) sums those drafts' `total` when
any exist; when the array is empty it falls back to computing the order's OWN total from
`subtotal`/`tax`/`discount`/`shippingFee`.

If the order's invoice has already progressed to SENT or PARTIAL (the office issued it, or a
prior partial payment landed), `order.invoices` is empty under the DRAFT-only filter, so
`orderAmountDue` takes the order-total fallback — the **full** order total, ignoring that the
customer may already owe less (partial payment) or that the issued invoice's total legitimately
differs from the order's live total (an edited/merged order after issuance). The driver is shown
the wrong amount to collect.

## Ground truth: what the driver's actual payment write path does

`recordDeliveryPaymentInTx` (`apps/api/src/invoices/invoices.service.ts:5041`) is what actually
applies a driver-collected payment. Its shape is the one the projection must never disagree
with:

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
— an ALLOW-list, excluding the terminal `PAID`/`VOID`/`WRITTEN_OFF`. This is also the exact
status set `findOne`'s B421 `balanceDue` reads apply the same formula to
(`invoices.service.ts:3259-3269`: `isSettled ? 0 : Math.max(0, roundMoney(total - totalConfirmed))`,
`totalConfirmed` via `splitConfirmed(payments)`). `CONFIRMED_PAYMENT`/`sumConfirmed`/
`splitConfirmed` live in `@routeflow/pricing` (shared, not API-only) — this is the ONE recipe,
not a mirror to write.

## 1. The server projection

**Proposal:** extend the run-read query to fetch every `PAYABLE` invoice per order (not just
DRAFT), each with its confirmed-payment sum, and compute a per-invoice `balanceDue` **server-side**
— B305's standing rule that the client never does `total - payments` itself, and (new reason,
worth the SA's explicit sign-off) it also keeps raw payment rows off the driver's device: the
client only ever needs a number, not each payment's method/reference/amount.

- **Query shape** (`RUN_STOP_INCLUDE.orders.select.invoices`, `routes.constants.ts`): change
  `where: { status: InvoiceStatus.DRAFT, ... }` to `where: { status: { in: PAYABLE }, deliveryBatchId: null }`
  and add `payments: { where: CONFIRMED_PAYMENT, select: { amount: true } }` to the select.
  (Open question below: should `deliveryBatchId: null` still gate this, or was that specific
  to draft-only semantics?)
- **Post-processing** (wherever `RUN_STOP_INCLUDE` is consumed — `routes.service.ts`'s
  `findOneRun`/`findMyRuns`/the other 2 call sites at `:1119`, `:1185`, `:2857`): for each
  fetched invoice, compute `balanceDue = roundMoney(Math.max(0, Number(total) - sumConfirmed(payments)))`
  (reusing `sumConfirmed` from `@routeflow/pricing`, mirroring B421's `findOne` formula exactly),
  then **strip the raw `payments` array** before the response leaves the service — the client
  gets `{ id, total, status, ..., balanceDue }`, never the payment rows. This needs a small
  shared mapper so all 4 call sites apply it identically (not 4 copies of the same reduce).
- **Composition with the existing draft-reconcile figure:** today's DRAFT-only sum already IS
  the draft-reconcile figure; widening the status filter to `PAYABLE` makes it the SAME sum,
  now correctly including SENT/PARTIAL/OVERDUE too. No separate "compose" step — it's one
  list, one filter, one sum. A DRAFT invoice normally carries no payments (nothing to pay
  before it's issued), so `balanceDue` reduces to `total` for it exactly as today — asked
  below whether that's a safe assumption to formalize or whether the formula should apply
  uniformly regardless (I believe uniformly is strictly safer and costs nothing).
- **PAID/VOID/WRITTEN_OFF sibling:** falls OUT of `PAYABLE` automatically — contributes
  nothing to the sum, exactly like `recordDeliveryPaymentInTx`'s own query. No special-casing
  needed; this is the same behavior the ALLOW-list already gives the write path.
- **Regulated split siblings** (base + `-R#`, `reconcileSplitOrderDrafts`): unaffected in
  kind — `PAYABLE` still returns every sibling that's actually payable, base or `-R#`, same as
  today's DRAFT-only sum already handles multiple drafts (B305 round 2 RULING 1). A SENT `-R#`
  sibling next to a DRAFT base now correctly contributes its own `balanceDue` too.

## 2. The mobile change

- `RunMoneyInvoice` (`apps/mobile/lib/run-money.ts:47-53`) gains `balanceDue: number | string | null`
  (Prisma-Decimal-as-string over the wire, same as every other money field here).
- `orderAmountDue` (`:189`): the primary branch currently does
  `finiteTotals = drafts.map(d => finiteOrNull(d.total))...sum`. Change to sum `d.balanceDue`
  instead of `d.total` — same guard shape (`finiteOrNull`, filter, sum, `roundMoney`). The
  variable/comment naming referring to "drafts" throughout this function and its JSDoc will
  need updating to something status-neutral ("payable invoices") since the array is no longer
  DRAFT-only — this is a meaningful doc rewrite given how much of the existing JSDoc (RULING 1,
  2, 5) specifically reasons about "the open draft(s)".
- The order-total fallback path (subtotal/tax/discount/shipping formula) is now reached ONLY
  when the order truly has **no** payable invoice at all (a not-yet-invoiced order, the normal
  pre-delivery state) — its own doc comments (RULING 2, the OTA-shipping-ahead-of-deploy note)
  stay valid as-is; nothing about the fallback's own math changes.
- **Callers**: `payment.tsx:99` and `index.tsx:193` (via `stopAmountDue`) call `orderAmountDue`/
  `stopAmountDue` with no change to call shape — they get a corrected number for free once the
  function and its input type change. No caller-side logic changes expected.
- **`reconciledAmountDue`** (`:382`, the short-pick/active-delivery estimate, fed by a caller-
  supplied `drafts` array): I did NOT find it reading `order.invoices` from `RUN_STOP_INCLUDE`
  directly — its `drafts` input is supplied by the caller at the point of active delivery,
  where the invoice would typically still be DRAFT (completion is what converts it). I'm
  treating this as **out of scope** but flagging it explicitly rather than assuming — asked
  below.

## 3. Pins (red-first, both sides)

**Server** (new/extended spec near `invoices.service.ts`'s B421 tests, or a new
`routes.service.b810.spec.ts` if the ratchet is tight — `routes.service.ts` isn't one of the
15 tracked giants today per the last `size-ratchet.spec.ts` run, but I'll re-check line count
before writing code):

- A SENT invoice with a confirmed partial payment → `balanceDue = total - paid`, not `total`.
- A PARTIAL invoice → same formula.
- An OVERDUE invoice → same formula (still in `PAYABLE`).
- A PAID sibling on a split order → excluded entirely (contributes to neither the list nor the sum).
- A VOID sibling → excluded.
- A DRAFT invoice with no payments → `balanceDue === total` (byte-identical to today's number).
- Raw `payments` rows are never present on the returned invoice shape (only `balanceDue`).
- Multiple PAYABLE siblings (regulated split) → each contributes its own `balanceDue`, summed.

**Mobile** (`__tests__/run-money.test.ts`, extending the existing suite):

- `orderAmountDue` sums `balanceDue` across a DRAFT + a partially-paid SENT invoice correctly.
- A SENT invoice with `balanceDue: 0` (fully paid) contributes 0, not its `total`.
- The order-total fallback fires ONLY when `invoices` is empty — a non-empty PAYABLE list with
  a `balanceDue` of 0 must NOT fall through to the order-total formula (that would silently
  re-introduce the bug for a fully-paid-but-still-open invoice, e.g. PARTIAL nearly closed out).
- `stopAmountDue` sums correctly across multiple orders at a stop, mixed DRAFT/SENT/PARTIAL.
- A regression pin reproducing the ORIGINAL bug report shape (SENT invoice, no payments yet,
  order previously edited so `order.total` ≠ invoice `total`) — before the fix this must read
  the WRONG (order-total) number; after, the invoice's own `balanceDue`.

## Open questions for the SA

1. **Exact field name** — `balanceDue`, matching `findOne`'s existing B421 field on the
   `Invoice` API response? Or a route/driver-specific name to avoid implying it's the same
   shape as the office-facing invoice detail response (it IS the same formula, just a
   different endpoint)?
2. **`deliveryBatchId: null`** — the current DRAFT filter also requires this. Does it still
   apply once the status filter widens to `PAYABLE`, or was `deliveryBatchId: null` specifically
   there to exclude per-batch delivery invoices from the DRAFT-only "open draft" concept? I
   don't yet know what a SENT/PARTIAL invoice's `deliveryBatchId` looks like in practice.
3. **Should the formula apply uniformly to DRAFT too** (i.e., always `total - confirmed`,
   never assume DRAFT has zero payments), or is "DRAFT never carries payments" a real,
   enforced invariant elsewhere worth just asserting/trusting? I lean uniform (costs nothing,
   removes an assumption) but want the ruling rather than assuming.
4. **`reconciledAmountDue`/the short-pick estimate** — confirmed out of scope, or does its
   `drafts` input ultimately trace back to the same DRAFT-only projection and need widening
   too? I did not find a direct read of `RUN_STOP_INCLUDE` inside it, but haven't traced every
   caller of `reconciledAmountDue` yet.
5. **Query cost**: a run can have many stops/orders; fetching each payable invoice's confirmed
   payments is a nested read (Prisma `payments: { where, select }` per invoice, not a single
   aggregate). Acceptable as a nested Prisma include, or does this warrant a raw aggregate
   query for the whole run in one round trip? I have no evidence either way is currently a
   problem — flagging for the SA's judgment on whether to require it up front or treat as a
   follow-up if it proves slow.
6. **Split location**: should the `balanceDue` computation/mapper be a new small module
   (mirroring B797's `order-unit-aware-flag.ts` extraction pattern, and SA-113's "the next PR
   touching invoices.service.ts extracts first" spirit) rather than inline in `routes.service.ts`,
   given 4 call sites need to apply it identically?
