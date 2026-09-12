# Train 4 "money and lifecycle" — S1 cause brief

Root: `C:/ClaudeCode/routeflow` @ master `1dca1242`. Read-only.

## 1. Per-row findings

**F24 B134** (invoice un-send). `orders.service.ts` `approveChangeRequestAtStop`
(def `4810-5269`). Line `4885`: `await this.invoicesService.revertLinkedInvoicesForOrderEdit(order.id)`
— called **before** the merge tx opens (`4904`, `this.prisma.tenantTransaction`),
with **no `tx` arg**, though `revertLinkedInvoicesForOrderEdit(orderId, tx?: any)`
(`invoices.service.ts:4298`) accepts one. Body (`4298-4349`) unconditionally flips
SENT/VIEWED/OVERDUE invoices to DRAFT (`sentAt`/`pdfUrl` null, `4338-4346`, unless
the WP-D1 deposit-mirror exemption `4312-4323`), throws on payments (`4330-4336`).
Sibling `updateOrderItems` has a `postDeliveryEdit` exemption (`3128-3141`) that
**skips** the revert for `OUT_FOR_DELIVERY`/`PARTIALLY_DELIVERED`/`DELIVERED` and
resyncs in place instead — `approveChangeRequestAtStop`'s window
(`PENDING`/`CONFIRMED`/`OUT_FOR_DELIVERY`, `4831`) overlaps `OUT_FOR_DELIVERY` but
has no such exemption. **Wrong behaviour:** un-send happens unconditionally, outside
the tx; a later in-tx throw (stock `5208`, credit `5209-5215`) rolls back the merge
but not the already-committed revert. Post-commit `reconcileOrderDraftInvoice`
(`5259`) never re-sends. **Matches master** (report's line numbers are stale from
`master@0b2c3a0a`; code shape unchanged).

**F24 B135** (stale window guards). Same function. Pre-tx (`4822-4829`): `order`
fetched with `lineItems`/`routeRun.status`/`routeRunStop.status`. Guards on that
snapshot (`4831-4843`): status must be PENDING/CONFIRMED/OUT_FOR_DELIVERY, run
IN_PROGRESS, stop not COMPLETED/SKIPPED. Tx opens `4904`, `FOR UPDATE` (`4911`),
re-reads `heldItems` **with `deliveredQty`** (`4912-4915`) — used only for the stock
delta (`5208`), not the guard. The `deliveredQty` check for CHANGE_QTY/REMOVE_ITEM
(`4941-4949`) reads `li` from the **pre-tx** `order.lineItems`, not `heldItems`.
`order.status`/`routeRunStop.status` are never re-read in-tx. Stock (`5208`)/credit
(`5209-5215`) guards genuinely re-run in-tx — matches the filed claim. Race partner
`completeWithPayment` (`routes.service.ts`) writes `deliveredQty`/`status=DELIVERED`
on stop completion; grep `changeRequest` there = 0 hits, no cross-serialization.
**Matches master** (line numbers shifted from `4079-4520`).

**B214** (credit notes survive delete). `deleteInvoice`
(`invoices.service.ts:5323-5375`, one `tenantTransaction`) line `5348-5351`:
`tx.creditNote.updateMany({where:{invoiceId:id}, data:{invoiceId:null}})` — no
`amountUsed`/`amount` check, no void, no audit row. `deleteOrder`
(`orders.service.ts:5489-5573`) is a second door: hard-deletes invoices directly
(`tx.invoice.delete`, `5560`) **without** calling `InvoicesService.deleteInvoice`
(comment `5548-5551`: avoids ledger-reversal duplication), so `CreditNote.invoice`
(no explicit `onDelete`, `finance.prisma:494`) falls to Prisma's documented default
for an optional relation — `SetNull` — with zero app logic. `releaseOrderCreditsInTx`
(`5540`) handles order-linked credits, not invoice-sourced notes. Either door leaves
a fully-spendable, provenance-less note. **Matches master** exactly. Sibling: F09
already closed the equivalent gap for VOID (L-081) — DELETE twin, unfixed.

**B215** (idempotency retry re-folds). `orders.controller.ts`, inside
`withAdvisoryLock({family:"order-merge", key:dto.customerId, mode:"wait",
waitMs:10_000}, ...)`. `170-183`: replay check via `findOrderIdByIdempotencyKey`.
`184-202`: `foldMergeItems` + `updateOrderItems(current.id, {...replaceAll:true},
user)` — no tx wraps this call (never thread a tx into `updateOrderItems`); fold
computes ABSOLUTE totals. `206-218`: `recordIdempotencyKey` in try/catch that only
`logger.error`s on failure (comment `207-210`: "the fold above is COMMITTED...
losing the replay guard is the cheaper failure"). If the key-write throws after a
committed fold, a same-key retry finds no replay row and re-folds the same items
into the already-merged order, doubling totals. **Matches master**. Report
documents this as a deferred owner question in F18's `result.json`.

**B216** (reinstatement leaves downgrade armed). `billing.service.ts`.
`onSubscriptionDeleted` (`644-690`) and `onSubscriptionUpdated` (`692-722`) both
clear `downgradeToPlanKey`/`downgradeEffectiveAt`/`retainedUserIds` via a
**separate, non-transactional** `tenantSubscription.update` (`679-687`, `713-715`)
issued _after_ `transitionAndEmit`'s own `$transaction` commits (`90-112`: plain
`$transaction`, CAS `tenant.updateMany` + `emitPayingDelta`). `onSubscriptionUpdated`
only clears when that event itself arms a cancellation (`703-706`, deliberate).
`onPaymentSucceeded` (`555-603`) and `onCheckoutCompleted` (`493-553`) — the
reinstatement webhooks — call `transitionAndEmit` the same way but have **no
clearing call anywhere**. A tenant lapsing with a downgrade armed keeps it through
reinstatement; the 02:00 sweep re-prices against the stale schedule, books a second
MRR delta, can deactivate restored staff. **Matches master**; corroborated by
`api.md:1469`. Owner ruling: mirror the sibling pattern, not a new transaction.

**F15 B131** (removed customer's crons keep firing). `deleteCustomer`'s soft branch
(`customers.service.ts:2039-2048`, taken for any customer with financial records or
`force=true` without `hardDeleteWhenRecordFree`) writes only `Customer.deletedAt` and
`User.status="INACTIVE"` (`2044-2047`). `restoreCustomer` (`1954-1983`) is the
symmetric undo (`1978`), also touching nothing else. `order-templates.service.ts`
`generateDailyOrders` (`@LeaderCron`, `295`) query `315-318`:
`{isActive:true, daysOfWeek:{has:dayOfWeek}}` — no customer filter/join.
`recurring-invoices.service.ts` `generateDueRecurringInvoices` (`@LeaderCron`,
`357`) query `373-376`: `{isActive:true, nextRunAt:{lte:new Date()}}` — customer
fetched but `deletedAt` never checked; `generateInvoiceFromTemplate` (`205`)
auto-emails when `ri.autoSend` (`293-300`). `invoices.service.ts` `create()`
(`342-346`) also lacks a `deletedAt` filter. **Matches master** (report's
`1761-1792`/`1867-1882` → now `2011-2049`, same shape). Hard-delete branch (`2051`+)
was only spot-read, not confirmed to tear down templates/recurring invoices as
claimed — flagged for S2.

**F15 B141** (removed customer keeps buyer-portal access).
`buyer-seller-context.guard.ts` (61 lines, whole file read, unchanged from report).
`canActivate` (`31-49`): `customerLink.findFirst({where:{buyerAccountId,tenantId,
status:"ACTIVE"}, include:{customer:{select:{id,userId,businessName,email}}}})` —
`status:"ACTIVE"` only, no `deletedAt` anywhere. `buyer.controller.ts:527-528`:
`@Post("orders") @UseGuards(BuyerSellerContextGuard)` — sole guard. Soft-delete never
touches `CustomerLink`. Contrast: `buyer-auth.service.ts` checks `account.deletedAt`
at 5 sites (`168,202,278,418,475`) — but that's `BuyerAccount.deletedAt` (the
buyer's own login), a different entity from `Customer.deletedAt`. Web dialog
(`.../customers/[id]/page.tsx:4271`): "portal access is paused" — confirmed still
present verbatim. **Matches master** essentially exactly.

## 2. Transaction shapes

| Row  | Tx today                                                                                                     | Lock                        | Where owner-ruled write lands                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| B134 | Revert (no tx) before merge's `tenantTransaction` (`4904`)                                                   | `FOR UPDATE` (`4911`)       | Pass `tx` into `revertLinkedInvoicesForOrderEdit`, call inside the merge tx (fn already takes `tx?`). No new lock.          |
| B135 | Same tx; guards (`4831-4843`) sit outside it                                                                 | same `FOR UPDATE`           | Re-check status/stop/deliveredQty through `tx` after `4911`, off `heldItems` (already carries `deliveredQty`, `4912-4915`). |
| B214 | `deleteInvoice`/`deleteOrder`: each own `tenantTransaction` (`5323`,`5539`)                                  | tx isolation only           | 409-on-unspent-balance check inside both existing txs (or route `deleteOrder` through `deleteInvoice`). No advisory lock.   |
| B215 | `updateOrderItems` inside `withAdvisoryLock`, no tx at that call site (`orders.controller.ts:149-157`)       | Postgres advisory lock only | Key-write and merge-write must share one commit; only `updateOrderItems`'s own internal tx (unread, §7) can hold both.      |
| B216 | `transitionAndEmit`'s `$transaction` (`90-112`, CAS); sibling clear is a separate non-tx update after commit | CAS `count===1`             | Mirror siblings — separate update after `transitionAndEmit`, no new shared transaction.                                     |
| B131 | Soft branch: one `tenantTransaction` (`2044-2047`)                                                           | none                        | `isActive=false` writes belong in this same tx (and restore's counterpart).                                                 |
| B141 | No `CustomerLink` write today                                                                                | n/a                         | Belongs in the same `deleteCustomer` tx; the guard fix is a stateless query filter.                                         |

No row needs a new advisory lock or a second in-process lock. B215's shape is open (§7).

## 3. What "removing a customer" means today (B131/B141)

`deleteCustomer(id, force, opts)` branches: no records + no force → **hard-delete**
(`2051`+, not fully read in S1); records + no force → **409** (`2031-2037`);
records-with-force or force-without-`hardDeleteWhenRecordFree` → **soft-delete**
(`2039-2048`, the path web's "Remove customer" always takes per `1998-2001`).
Soft-delete writes only `Customer.deletedAt` + `User.status`. Dependent artifacts,
whether they keep running: `OrderTemplate` — **yes**, no filter
(`order-templates.service.ts:315-318`); `RecurringInvoice` — **yes**, no filter,
auto-emails (`recurring-invoices.service.ts:373-376`,`293-300`); `CustomerLink` —
**yes**, guard checks `status` only (`buyer-seller-context.guard.ts:31-49`);
`BuyerAccount` — untouched, correctly guarded elsewhere for its own deletion; manual
`Invoice.create()` — still possible, no filter (`invoices.service.ts:342-346`).
Hard-delete branch's teardown was not confirmed line-by-line — flagged.

## 4. At-door approval sequence (B134/B135)

1. `ChangeRequestsService.resolve` → `approveChangeRequestAtStop(crId, resolver, reason)`.
2. Pre-tx (`4815-4902`): load CR + order, window guards, regulated guard for
   ADD_ITEM, **`revertLinkedInvoicesForOrderEdit` at `4885`** — unconditional,
   outside any tx — then hoisted reads (tax rate, promos, price history, credit flag).
3. Tx (`4904-5255`, 15s timeout): `FOR UPDATE` (`4911`), re-read `heldItems`
   (`4912-4915`), atomic CR claim (`4918-4932`), apply mutation, recompute totals
   (`5188-5198`), re-run stock (`5208`)/credit (`5209-5215`) guards, write order
   totals (`5219-5227`), write `DeliveryMutation` provenance (`5231-5251`).
4. Post-commit (`5259-5266`): `reconcileOrderDraftInvoice` resyncs the (still-DRAFT)
   invoice but never re-sends it; `appendOrderRevision` records the change.

The un-send is a side effect ahead of a transaction that can still fail, and even on
success is one-way — B134 is two defects: not transactional/revertible, and no
postDeliveryEdit-style exemption for this window.

## 5. Existing specs

`approveChangeRequestAtStop`: directly tested in `orders.service.spec.ts:5913-6450`
(12 tests: proration, ADD_ITEM pricing, REMOVE_ITEM cancel, G6 claim race, stock/
credit guards, pre-tx `STOP_ALREADY_COMPLETED`, post-commit reconcile+revision,
regulated guard) + one in `orders-promo-bogo.spec.ts:629`. **None** assert the
invoice revert (B134) or a pre-tx-guard/`completeWithPayment` race (B135) —
confirmed gap. `change-requests.service.spec.ts` mocks
`approveChangeRequestAtStop` — resolver-boundary only. `deleteInvoice`: no dedicated
spec; only referenced from `customers.purge-ledger.spec.ts` (coverage unconfirmed).
B215: the only idempotency spec (`orders.scan-hardening.spec.ts:309-460`) covers
`create()`, not the merge/fold branch (`147-222`) — no coverage for `176-183`/
`206-218`. B216: `billing.service.spec.ts` has downgrade-clear tests for
`onSubscriptionDeleted`/`onSubscriptionUpdated`; `onPaymentSucceeded`/
`onCheckoutCompleted` tests assert only MRR-delta CAS. B131/B141: no dedicated
`BuyerSellerContextGuard` spec found; cron spec titles for a removed-customer case
unconfirmed — re-grep before writing new tests.

## 6. Train shape / DB-lane

B134+B135 are the **same function** — fix together. B214 shares `invoices.service.ts`
and `orders.service.ts` with the B134/B135 pair. B215 is isolated to
`orders.controller.ts` + read-only `db-locks.ts` context. B216 is isolated to
`billing.service.ts`. B131+B141 share `customers.service.ts`'s soft-delete branch as
root cause but diverge downstream (B131 → templates/recurring-invoices/`create()`;
B141 → buyer guard/controller) — two fixes off one write site. `invoices.service.ts`
is the most-touched file — sequence to avoid uncoordinated edits. DB-lane: expect
`*.db.spec.ts` load-bearing for B214 (real FK `SetNull` cascade) and B135 (real
concurrent-tx race).

## 7. Risks / unknowns for S2

B131's hard-delete branch (`2051`+) and `restoreCustomer`'s counterpart were not read
to completion — confirm the "tears down recurringInvoice/orderTemplate/route rows"
claim first. B135's race window was not measured — re-confirm the filed "narrow"
characterization. B215's fix shape is open: `updateOrderItems`'s internal tx
structure was not read in S1 and must be before proposing where the key-write lands.
B214's fix surface is two call sites (`deleteInvoice`; `deleteOrder`'s inline loop,
bypassing it per `5548-5551`) — weigh duplicating the guard (drift risk, L-072) vs.
routing `deleteOrder` through `deleteInvoice`. The `SetNull`-default claim rests on
schema source, not migration SQL. No spec coverage was confirmed for `deleteInvoice`
isolation, `BuyerSellerContextGuard`, the merge-branch idempotency path, or the
recurring cron's removed-customer case — treat as uncovered but re-grep first. **Lessons register:** no entry named "F16b" or
matching "tx boundary" found in `LESSONS.md`/`ARCHIVE.md`; closest is **L-081** (F09
— "gate a money write inside the primitive that performs it, on the row it just
read" — on-point for B214, the delete-twin of the void-door bug it fixed) plus
CLAUDE.md's own rules (no second lock over `withAdvisoryLock`; never thread a tx into
`updateOrderItems`), cited per-row above. Confirm with the requester whether "F16b
boundary rule" points to something outside the lessons register.
