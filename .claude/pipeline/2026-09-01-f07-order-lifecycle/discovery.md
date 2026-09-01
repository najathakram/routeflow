# F07 · Discovery — order lifecycle, stock conservation and teardown

**Status: IMPLEMENTED — proven, pending merge (see build-plan.md)** · Campaign batch F07, board issue #520, one PR.
Bugs: B10 (T2), B56, B64, B65, B105, B108, B116 (T1). Fix card:
`.claude/pipeline/fix-cards/F07-order-lifecycle-stock-conservation-teardown.md`.

## The problem, in the requester's words

The order status machine and its teardown do not conserve what they touch. When an operator
cancels or deletes an order, the system silently destroys or strands value that belongs to the
business or the customer:

- **B56 (Critical):** cancelling a PARTIALLY_DELIVERED order voids the invoice for goods the
  customer already physically has — already-earned revenue vanishes with no residual billable
  record. Single or bulk, straight from the UI.
- **B64 (High):** cancelling never returns the creation-time stock decrement — `currentStock`
  is permanently understated after every cancel; only the edit-to-zero path credits back.
- **B65 (High):** deleting an order hard-deletes its invoices without the regulated-ledger
  reversal both sibling destruction paths (void, invoice-delete) perform — regulated sales and
  excise are permanently overstated.
- **B105 (High):** the auto-invoice on "Mark delivered" is fire-and-forget; on failure the
  operator sees a success toast and the delivered order silently never reaches AR.
- **B108 (High):** the delivery credit-note settle is swallowed on tx failure, and the comment
  claiming send() catches up is false — send()/sendEmail() deliberately exclude exactly those
  credits.
- **B116 (Medium):** order creation decrements stock row-by-row inside one default-5s-capped
  transaction — large multi-SKU orders (or lock contention) time out and fail outright.
- **B10 (Medium, web):** when editing IS closed (a cancelled order) the operator gets no
  explanation — the only banner branch checks `closedReason === "DISPATCHED"`, which the staff
  API path can never emit; the Edit Items button just silently disappears.

**Whose problem:** operators and the tenant's books, daily. Cost: real revenue leakage (B56),
phantom stock-outs (B64), compliance overstatement (B65), unbilled deliveries (B105), customers
double-owing (B108), failed large orders (B116).

**Current workaround / why it fails:** none exists. The damage is silent — no flag, no sweep, no
log the operator sees. The codebase's own `settleStockForEdit` proves the delivered-qty signal
exists and is simply not consulted by cancel/delete.

**Why now:** F03 (payment truth) and F06 (order-edit conservation) just landed in the same file;
per the card, the status machine must be conserving before F11/F22/F24 read it.

**If we ship nothing:** every cancel keeps understating stock, every partial-delivery cancel
keeps voiding earned revenue, every deleted order keeps corrupting the regulated ledger.

**Success signal:** the seven `REG-B##` proofs green (T1 jest now, B10's T2 e2e post-deploy) +
D4 repair pass over identifiable historical damage.

## Discovery verdict (per the campaign plan — citations re-verified on master@df1ef9a3)

| ID | Verdict | Re-anchored evidence (master@df1ef9a3) |
| --- | --- | --- |
| B10 | CONFIRMED, EVIDENCE MOVED | `apps/web/app/(dashboard)/orders/[id]/page.tsx:2292` (was :2217) — sole `closedReason` read, checks `"DISPATCHED"`. API `computeEditWindow` now `orders.service.ts:488-508` (was :447-458): staff path emits only `null`/`"STATUS"`. NOTE: F06 (REG-B63) added a CUSTOMER branch that emits `"DISPATCHED"` — for buyers only; the operator dashboard still can never receive it, and nothing anywhere renders the CANCELLED explanation. Bug intact. |
| B56 | CONFIRMED, MOVED | matrix `orders.service.ts:2402-2409` (PARTIALLY_DELIVERED→CANCELLED legal); cancel branch `:2541-2560` blanket-voids; `cancelImpact` `:2648-2705` + `assertCancellableOrThrow` `:2707-2717` read external payments only, never `deliveredQty`; precedent `settleStockForEdit` `:4191+`; web bulk cancel `orders/page.tsx:233-244`, no client gate. |
| B64 | CONFIRMED | cancel branch `:2547-2560` = releaseOrderCredits + releaseWallet + void only — zero `currentStock` writes, items never flipped; `reopenOrder` `:2718-2760` flips items CANCELLED→PENDING, never re-decrements; creation decrement `:2043-2096` under FOR UPDATE. `invoices.service.ts` has zero currentStock references (re-confirmed). |
| B65 | CONFIRMED | `deleteOrder` `:5191-5268` — inline `invoicePayment.deleteMany` / `invoiceItem.deleteMany` / `invoice.delete` (:5245-5257) with commission removal but NO ledger call; `RegulatedLedgerService` not imported by orders.module.ts (verified). Siblings: `voidInvoiceInTx` `invoices.service.ts:3845-3860` and `deleteInvoice` `:4937-4990` both call `ledger.reverseInvoiceEntries`. `RegulatedModule` exports the service; its imports (Storage/Audit/Billing) are cycle-free w.r.t. OrdersModule. |
| B105 | CONFIRMED, MOVED | `orders.service.ts:2508-2519` — unawaited `createInvoiceFromOrderWithTenant(...).catch(log)`; `generateInvoiceNumber` `invoices.service.ts:2746-2757` read-max+1, no lock; P2002→ConflictException wrapper `:1266-1270`. Zero-remaining call is idempotent (`:2349-2352` returns existing invoices) — safe to await on repeat DELIVERED cycles. Manual retry path exists: `POST /invoices/from-order/:orderId` (controller :54), wired on the order page. The injected `invoices` Bull queue has NO processor and NO .add() caller anywhere — dead DI, not usable infra. |
| B108 | CONFIRMED | swallow + false comment `orders.service.ts:2521-2540`; send `invoices.service.ts:3406-3415` and sendEmail `:3601-3610` exclude explicit-amount intents from auto-apply; `settleOrderCreditsInTx` `credit-notes.service.ts:914-1005` is idempotent/clamped (shrink+apply passes) and takes an explicit tenantId. |
| B116 | CONFIRMED (TOKEN_NOT_FOUND resolved) | `tenantTransaction` opened with NO options `orders.service.ts:2043`; sequential per-line `tx.product.update` loop `:2090-2096`; P2002-only retry `:2160-2200`. `prisma.service.ts:36-51` forwards options verbatim to `$transaction`; constructor sets no transactionOptions → Prisma 7 defaults (timeout 5000ms / maxWait 2000ms) govern. |

None already-fixed; no register flips needed at discovery. B208 (operator MANUAL price lost on
buyer merge) sits in this file region — **explicitly NOT taken as a rider** (L-008); left
recorded for a later batch.

## Who else is affected that nobody asked

- The web AND mobile `cancel-impact` copy mirrors (`apps/web/lib/cancel-impact.ts`,
  `apps/mobile/lib/cancel-impact.ts`): when `canCancel:false` they compose the blocked reason
  from `blockingPayments` alone — a delivered-goods block would render broken copy ("This order
  has been paid: .") unless both mirrors learn the new reason. In scope (B56's own surface; the
  file's doc: "the only warning between a tap and voiding live invoices").
- `describeCancelImpact` consumers: order detail page (web), mobile order screen. Additive
  field only.
- Repeat-delivery cycles (DELIVERED→CONFIRMED→DELIVERED): B105's await must stay idempotent —
  verified it is.

## Symptom vs root cause

The register's own framing is root-cause-level: the CANCELLED/delete paths never took part in
the conservation invariant F06 built for edits. We reuse the existing conservation machinery
(`settleStockForEdit`, `reverseInvoiceEntries`, `settleOrderCreditsInTx`) rather than writing
parallel logic.

## Known limitation accepted (recorded, not fixed here)

Orders promoted DRAFT→PENDING never had a creation-time stock decrement (promotion touches no
stock — verified). For those orders, the B64 credit-back restores stock that was never taken.
Fixing promotion-time decrement is a distinct behavioral change the register has not flagged
and is OUT of this batch's scope (L-008); the asymmetry is recorded as a residual/candidate
register entry in the close-out. The same marker gap makes part of the D4 historical repair
unidentifiable (see build plan §repair).

## Strongest hostile objection, answered

*"Blocking PARTIALLY_DELIVERED→CANCELLED breaks a flow operators use today."* — It breaks a
flow that silently destroys earned revenue; the codebase's own at-door path already refuses to
treat delivered stock as returnable (LINE_ALREADY_DELIVERED). The block comes with explicit,
actionable copy (record a return, or edit the undelivered lines) on server error, web dialog
and mobile dialog. Orders with zero delivered units cancel exactly as before.
