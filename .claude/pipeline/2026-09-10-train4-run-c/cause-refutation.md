# Train 4 — S2 refute-first pass (read-only, root @ master f0cc9514)

## Verdict table

| Row  | S1 cause                                                 | S2 verdict                                         | Correction                                                                                                                               |
| ---- | -------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| B134 | Un-send outside the merge tx, no post-delivery exemption | **CONFIRMED**                                      | Revert is tx-safe to move (fn issues only plain queries); the "exemption" half is bigger scope than S1 implies — see §1                  |
| B135 | Window guards read a pre-tx snapshot                     | **CONFIRMED, narrowed**                            | `deliveredQty` re-read is free (`heldItems` already carries it); `order.status`/stop status need 2 extra in-tx reads                     |
| B214 | Both delete doors orphan a spendable credit note         | **CONFIRMED**                                      | The void door's predicate is reusable verbatim; a 3rd door exists (customer purge) but does not orphan                                   |
| B215 | Key write can throw after a committed fold               | **PARTIALLY REFUTED**                              | The write is _already_ inside the lock scope; the dominant defect is `idempotencyKey: null` in `recordIdempotencyKey`, not the try/catch |
| B216 | Reinstatement webhooks never clear the armed downgrade   | **CONFIRMED, refined**                             | Clear must be **conditional on the transition firing**, else an ordinary renewal wipes a legitimate schedule                             |
| B131 | Soft delete writes only `deletedAt`; crons keep firing   | **CONFIRMED**; hard-delete claim **verified true** | Prefer a cron-query filter over `isActive=false` writes — see §5                                                                         |
| B141 | Buyer guard checks link status only                      | **CONFIRMED**                                      | One-line query filter; 56 references covered by one guard                                                                                |

---

## 1. B134/B135 — `approveChangeRequestAtStop` (`C:/ClaudeCode/routeflow/apps/api/src/orders/orders.service.ts:4810-5269`)

Sequence confirmed: guards `4831-4842` on the pre-tx snapshot (`4821-4829`) → ADD_ITEM
regulated guard `4868-4878` → **`revertLinkedInvoicesForOrderEdit(order.id)` at `4885`,
no tx** → hoisted reference reads `4887-4900` → `tenantTransaction` `4904-5254`
(`FOR UPDATE` `4911`, `heldItems` `4912-4915`, atomic claim `4918-4932`, totals
`5187-5198`, stock `5208`, credit `5209-5215`, order write `5219-5227`,
`DeliveryMutation` `5231-5251`) → post-commit `reconcileOrderDraftInvoice` `5259` +
`appendOrderRevision` `5260-5266`.

**Can the un-send move inside the tx? Yes.**
`revertLinkedInvoicesForOrderEdit(orderId, tx?)`
(`apps/api/src/invoices/invoices.service.ts:4298-4349`) issues only `db.invoice.findMany`,
`db.order.findFirst`, `db.invoice.count`, `db.invoicePayment.count`, `db.invoice.update` —
**no nested `$transaction`, no lock, no advisory call**. Passing the merge `tx` satisfies
the F16b boundary rule and does not touch `updateOrderItems`. Place the call after `4911`
and _before_ the claim at `4918`, so a payments-throw (`4330-4336`) rolls back before any
mutation. Cost: ~4 extra queries inside a 15s interactive tx already holding a row lock —
acceptable, and no compensating write is then needed.

**Exemption half — scope warning.** `updateOrderItems`'s exemption (`3128-3141`) is
_paired_ with a post-mutation `resyncOrderInvoicesForEdit` call (`4282`, gated on
`hasPartialBilling`, `4275-4281`). `approveChangeRequestAtStop` has no resync call at all —
only `reconcileOrderDraftInvoice(…, {basis:"order"})`. Copying the exemption _alone_ would
leave an OUT_FOR_DELIVERY at-door edit's SENT invoice stale. Doing it properly means
porting the resync branch too. **Recommend fixing the transactionality half this train and
splitting the exemption out (Q3).**

**B135 — what must be re-read in-tx.** `heldItems` (`4912-4915`) already selects
`deliveredQty`, but the LINE_ALREADY_DELIVERED check at `4945-4947` reads `li` from the
**pre-tx** `order.lineItems` — swap it to the `heldItems` row (free, no extra query).
`order.status` and `routeRunStop.status` are never re-read; both need one in-tx read after
`4911` re-asserting `4831-4842`. The race partner writes both on stop completion
(`routes.service.ts` `completeWithPayment`); `FOR UPDATE` on `Order` does **not** serialize
a `RouteRunStop` write, so the window is real, not theoretical.

**Specs.** `orders.service.spec.ts:5913-6450` (12 tests) + `orders-promo-bogo.spec.ts:629`.
Zero assert the revert: the only `revertLinkedInvoicesForOrderEdit` assertions in the tree
are `not.toHaveBeenCalled()` for `updateOrderItems`'s post-delivery branch
(`orders.service.spec.ts:5077`, `orders.update-items-guards.spec.ts:607`). No race spec.

## 2. B214 — delete doors vs. sourced credit notes

Doors that destroy an invoice: (a) `InvoicesService.deleteInvoice`
(`invoices.service.ts:5323-5374`, sole HTTP door `invoices.controller.ts:290`) — line
`5348-5351` `creditNote.updateMany({invoiceId: null})`, no balance check, no void, no audit;
(b) `OrdersService.deleteOrder` (`orders.service.ts:5489-5572`, HTTP
`orders.controller.ts:525`, plus `bulkDelete` `5606` and a swallowed internal call in
`orders/change-requests.service.ts:387`) — inline `tx.invoice.delete` `5560`, so
`CreditNote.invoice` (`apps/api/prisma/schema/finance.prisma:494`, optional, no explicit
`onDelete`) falls to Prisma's `SetNull`; (c) `CustomersService` hard-delete/purge
(`customers.service.ts:2086`, `2594`) — these `deleteMany` the notes outright, so no orphan.

**"Unspent balance"** = the canonical open predicate documented at
`apps/api/src/credit-notes/credit-notes.service.ts:636-638`:
`status != VOID && (amount − amountUsed) > 0.001 && (expiresAt == null || expiresAt > now)`.
The void door already implements the per-note handling: `voidInvoiceInTx`
(`invoices.service.ts:4126-4147`) voids a note with `amountUsed <= 0.001` and caps
`amount = amountUsed` (status APPLIED) otherwise — pinned by
`credit-notes.wallet-integrity.spec.ts` **T9 (`:443`) / T10 (`:488`) / T11 (`:521`)**.
The ruled 409 is therefore _stricter_ than the sibling void door, not a copy of it (Q1).

**Does a 409 break an existing flow? No caller found that breaks.** `bulkDelete` uses
`Promise.allSettled` (`orders.service.ts:5606`); `change-requests.service.ts:387` is
`.catch(() => {})`; `apps/api/scripts/e2e-verify.ts`, `scripts/feature-smoke.mjs`,
`scripts/post-deploy-check.mjs`, `apps/api/scripts/demo-seed.js` and the DANGER wipe script
contain **no** `DELETE /invoices/:id` or `DELETE /orders/:id` call (the only scripted delete
is `DELETE /recurring-invoices/:id`, `e2e-verify.ts:1531`). No dedicated `deleteInvoice`
spec exists — only incidental references in `customers.purge-ledger.spec.ts`.

**Drift risk (L-072).** Two doors need the same predicate. Routing `deleteOrder` through
`deleteInvoice` is blocked by the comment at `orders.service.ts:5548-5551` (duplicate ledger
reversal). Low-drift option: one shared `assertNoUnspentSourcedCredits(tx, invoiceId)` on
`InvoicesService`, called from `invoices.service.ts:5348` and the `orders.service.ts:5552`
loop.

## 3. B215 — idempotency key (`apps/api/src/orders/orders.controller.ts:148-221`)

**Refutation:** the `recordIdempotencyKey` call at `206-218` is _already inside_ the
`withAdvisoryLock` callback (lock opens `157`, callback closes `221`). The owner ruling
"the key write happens inside the merge's lock scope" is **already satisfied**, and it does
not make the two writes atomic: `withAdvisoryLock`
(`apps/api/src/common/db-locks.ts:176-212`) takes a **dedicated `pg` pool client**, entirely
separate from Prisma — it serializes merges, it does not enclose a transaction.
`updateOrderItems` commits in its own tx; the key write is a second, later commit. A retry
arrives _after_ the lock releases, so lock scope cannot help it.

**The dominant defect is different from S1's.** `recordIdempotencyKey`
(`orders.service.ts:1661-1676`) is
`updateMany({ where: { id: orderId, idempotencyKey: null }, data: { idempotencyKey } })` —
**first key wins**. When the merge target already carries a key (created with one, or
stamped by an earlier merge wave) the new key is silently dropped: 0 rows matched, no throw,
nothing logged, and the `try/catch` never fires. The code comment at `1666-1668` admits it:
"the merge path's replay is a bare key lookup, so a key that was already set leaves that
fold unguarded (campaign candidate)". This is the common case; the throwing-write case S1
blames is the rare one.

**Constraint:** the key lives on `Order` (`apps/api/prisma/schema/sales.prisma:598`, with
`@@unique([tenantId, idempotencyKey])` at `622`) — **one key per order, ever**; there is no
key table. A duplicate write against another order raises P2002, which `1673-1675` swallows.
So "record the second key too" is impossible without either a new table or a reserve-first
scheme (insert key, fold, compensating delete on throw) — which the lock _does_ make safe
against concurrency, but which fails closed on a crash (the retry would replay a fold that
never happened). **This row's fix shape is a design decision, not a mechanical edit — Q2.**

**Specs:** `orders.scan-hardening.spec.ts:309-460` covers `create()` only; the merge branch
(`orders.controller.ts:147-222`) is uncovered.

## 4. B216 — `apps/api/src/billing/billing.service.ts`

Siblings: `onSubscriptionDeleted` `679-687` (unconditional clear of
`downgradeToPlanKey`/`downgradeEffectiveAt`/`retainedUserIds` + `cancelAtPeriodEnd: true`,
a separate non-tx update after `transitionAndEmit`) and `onSubscriptionUpdated` `707-716`
(clears **only** when the event arms a cancellation — deliberate, per the comment
`703-706`). `onCheckoutCompleted` (`493-552`) and `onPaymentSucceeded` (`555-601`) call
`transitionAndEmit(… {status:{not:"ACTIVE"}} → "ACTIVE" …)` and clear nothing.

**Refinement of the ruling:** the clear must be **conditional on `transitionAndEmit`
returning truthy** (the tenant actually flipped non-ACTIVE→ACTIVE). Both handlers also fire
on _ordinary renewals_ of an already-ACTIVE tenant (`payment_succeeded` every cycle) — an
unconditional clear there would silently delete a downgrade the tenant scheduled, exactly
the failure `onSubscriptionUpdated`'s comment guards against. `transitionAndEmit` already
returns that boolean (consumed at `667-674`).

**Reuse:** `SubscriptionMutationService.resume()`
(`apps/api/src/billing/subscription-mutation.service.ts:782-797`) writes the identical four
fields, but is not a reusable helper — it is an inline update plus a `SUBSCRIPTION_RESUMED`
event emit that the webhook already emits via `transitionAndEmit`. Calling it verbatim
**double-emits**. Copy the four-field update in the `onSubscriptionDeleted` shape; do not
call `resume()`.

**02:00 sweep after clearing:** `applyScheduledDowngrades`
(`apps/api/src/billing/billing-cron.service.ts:121-176`) filters
`tenant: { status: "ACTIVE", deletedAt: null }` (`131`) — which is _why_ the harm only lands
after reinstatement: the stale past-due schedule is skipped while the tenant is
SUSPENDED/CANCELLED and applies at the first 02:00 after reactivation (plan flip + second
MRR delta `157-168` + non-retained staff deactivation `553`-class logic). Once cleared, the
sub simply never matches the query — no cron change needed.

**Specs:** `billing.service.spec.ts:136/156/169` assert the clear for deleted/updated only;
the reinstatement handlers' tests assert MRR-delta CAS only.

## 5. B131/B141 — removing a customer

Soft branch `apps/api/src/customers/customers.service.ts:2039-2049`: one
`tenantTransaction` writing `customer.deletedAt` + `user.status = "INACTIVE"`.
`restoreCustomer` (`1966-1984`) is the exact inverse. **Hard branch verified in full
(`2051-2187`)** — S1's open question closes: it _does_ tear down `recurringInvoice` (+items)
`2128-2139` and `orderTemplate` (+items) `2141-2151`, plus estimates, routes, transactions,
advance payments and credit notes. It does **not** delete `CustomerLink` (only the bulk
purge does, `2594`), so a hard delete of a linked customer would hit the
`CustomerLink.customerId` FK; the purge path filters linked customers out (`2433`/`2451`),
so this is latent and out of train scope.

**Three dependents and the reusable paths:**

- `OrderTemplate` — cron `apps/api/src/order-templates/order-templates.service.ts:315-318`
  (`{ isActive: true, daysOfWeek: { has } }`); toggle exists via `update()` `177`.
- `RecurringInvoice` — cron
  `apps/api/src/recurring-invoices/recurring-invoices.service.ts:373-376`
  (`{ isActive: true, nextRunAt: { lte } }`), auto-emails at `293-300`; **dedicated pause
  (`182`) / resume (`191`) methods exist.**
- `CustomerLink` — `disconnectPortal` (`customers.service.ts:2693-2711`) is a genuine revoke
  (status DISCONNECTED, burns `inviteToken`), but it uses `this.prisma` directly (**not
  tx-aware**) and `restoreCustomer` has no counterpart, so remove + undo would permanently
  destroy a live portal link.

**Recommendation against S1's shape.** S1 puts `isActive = false` writes in the soft-delete
tx. That is _not_ restore-symmetric: `restoreCustomer` cannot know which templates /
recurring invoices were already paused before removal, so undo would over- or under-restore.
Prefer a **stateless filter** on both cron queries — `customer: { deletedAt: null }` — plus
the same on `invoices.service.ts` `create()` (`342-346`). Zero new state, exactly symmetric
with restore, and identical in shape to the B141 fix. The same argument applies to
`CustomerLink`: filter in the guard rather than flip the row — the web dialog already
promises "portal access is **paused**"
(`apps/web/app/(dashboard)/customers/[id]/page.tsx:4271`), paused, not disconnected.

**B141 guard:** `apps/api/src/buyer/guards/buyer-seller-context.guard.ts:38-44` —
`customerLink.findFirst({ where: { buyerAccountId, tenantId, status: "ACTIVE" } })`. Adding
`customer: { deletedAt: null }` (or selecting `deletedAt` and throwing `ForbiddenException`)
fixes every buyer endpoint at once: the guard is referenced 56× across
`apps/api/src/buyer/buyer.controller.ts`, `buyer-tenant.interceptor.ts` and
`apps/api/src/payment-requests/buyer-payments.controller.ts`. Existing session-revocation
primitives if the Lead wants immediate lockout:
`buyerRefreshToken.deleteMany({ buyerAccountId })`
(`apps/api/src/buyer/buyer-auth.service.ts:310, 373, 400, 435`; tx-aware precedent
`apps/api/src/buyer/buyer-admin.service.ts:240`).

## 6. Spec coverage summary

| Function                                               | Coverage today                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `approveChangeRequestAtStop`                           | 12 tests `orders.service.spec.ts:5913-6450` + 1 promo; **nothing** on the revert or the stop race |
| `deleteInvoice`                                        | no dedicated spec; incidental in `customers.purge-ledger.spec.ts`                                 |
| `deleteOrder` credit path                              | `credit-notes.wallet-integrity.spec.ts` covers the **void** door (T9–T11), not delete             |
| merge idempotency (`orders.controller.ts:170-218`)     | none — `orders.scan-hardening.spec.ts:309-460` is `create()` only                                 |
| `onPaymentSucceeded` / `onCheckoutCompleted`           | MRR-delta CAS only; no downgrade-state assertion                                                  |
| `generateDailyOrders` / `generateDueRecurringInvoices` | specs exist; **zero** `deletedAt` occurrences → removed-customer case uncovered                   |
| `BuyerSellerContextGuard`                              | no spec file anywhere                                                                             |

## 7. Risks / unknowns

1. B215 needs a design ruling (Q2); it is **not** a mechanical edit and should not be
   sequenced with the rest until answered.
2. Moving the revert into the merge tx lengthens a 15s interactive tx holding a row lock by
   ~4 queries. Low, but worth a DB-lane timing check.
3. B134's exemption half needs the `resyncOrderInvoicesForEdit` branch ported too — defer
   (Q3).
4. `CreditNote.invoice` `SetNull` is inferred from `finance.prisma:494` + Prisma's documented
   default; not verified against migration SQL in this read-only pass.
5. `disconnectPortal` is not tx-aware — reusing it inside `deleteCustomer`'s tx needs a `tx?`
   parameter.
6. Hard-deleting a linked customer would FK-fail on `CustomerLink` — latent, file separately.

## Questions for the Lead

**Q1 (B214).** The void door (`voidInvoiceInTx:4126-4147`, pinned by T9/T10) _auto-voids_ a
fully-unused sourced note and _caps_ a partly-used one. The ruling for delete is a 409.
Confirm the asymmetry is intended (delete is irreversible, so refuse rather than silently
destroy headroom) — or should delete mirror void and auto-void/cap instead?

**Q2 (B215).** The key write is already lock-scoped; the real hole is
`recordIdempotencyKey`'s `idempotencyKey: null` filter plus the one-key-per-`Order` unique.
Which shape: (a) reserve-key-then-fold with a compensating delete on throw (fails closed on
a crash: a retry replays a fold that never happened), or (b) a new tenant-scoped
idempotency-key table (correct, but a Prisma migration)?

**Q3 (B141 + B134).** For B141: refuse at the guard only (portal "paused", restore-symmetric,
sessions expire naturally) or _also_ delete the buyer's `buyerRefreshToken` rows immediately
(hard lockout, but no counterpart on restore)? And for B134: fix transactionality only this
train, deferring the post-delivery exemption (which needs the `resyncOrderInvoicesForEdit`
branch ported) to its own row?
