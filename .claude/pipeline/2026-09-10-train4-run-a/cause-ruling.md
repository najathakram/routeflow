# Cause ruling — train 4 (money/lifecycle) — PLANNED, NOT BUILT (owner pause 2026-09-09)

Fable 5.1 over S1/S2 (verified at master f0cc9514). Resume = write bug-test-plan + build-plan from this, run the engine
(scale major, DB lane) on a branch off the current master.

- B134/B135 (`approveChangeRequestAtStop`): move `revertLinkedInvoicesForOrderEdit` INSIDE the merge tx (plain
  queries, no nested tx — F16b rule holds); re-read order/stop status guards inside the tx; do NOT bolt on
  `resyncOrderInvoicesForEdit` here (separate row if wanted). Failure → nothing un-sent.
- B214: refuse (409) `deleteInvoice` AND `deleteOrder`'s hard-delete door while any sourced credit note has unspent
  balance; reuse the void door's predicate as ONE shared helper (L-072 drift guard). Asymmetry with void is accepted:
  void keeps the audit trail, delete does not.
- B215: fix shape (b) — a per-request idempotency-key TABLE (`OrderIdempotencyKey`: tenantId, key, orderId, response
  hash, unique (tenantId,key)) written inside the advisory-lock callback; retries with the same key replay the stored
  result and never re-fold. Migration needed → owner ack at resume. Interim (a) is NOT taken.
- B216: clear the armed downgrade in `onPaymentSucceeded`/`onCheckoutCompleted` ONLY when `transitionAndEmit` returns
  truthy (a real reinstatement), never on ordinary renewals; do not reuse `resume()` (double emit).
- B131: cron queries filter `customer: { deletedAt: null }` (stateless, restore-symmetric) instead of flag writes;
  hard-delete branch already tears down. B141: buyer auth guard refuses a soft-deleted customer at the next request
  AND the soft-delete revokes that customer's buyer refresh tokens/sessions immediately (both).
- Tests: DB lane for B214/B215 (money), unit for the rest; REG tokens per row.

## OWNER RULINGS 2026-09-10 (supersede the lines above where they conflict)

- **Split into four runs, shipped in one window** (bug-pipeline batching rule: unrelated subsystems never share a
  run). Run A = B134 + B135 + B214 (order money path, DB lane). Run B = B215 (migration). Run C = B216 (billing).
  Run D = B131 + B141 (removed customer).
- **B215: migration APPROVED.** Build the OrderIdempotencyKey table as ruled; it goes to prod through
  prod-migrate.mjs with a fresh backup BEFORE the deploy, inside train 4's window.
- **B141: GUARD ONLY, and hide the removed seller from GET /buyer/sellers. NO refresh-token revocation.**
  This OVERRIDES the "(both)" above. Reason, verified 2026-09-10: BuyerRefreshToken has no tenantId (it is
  account-wide), so revoking would log the buyer out of every OTHER wholesaler's portal too; and all 45
  seller-scoped routes in buyer.controller.ts plus the 6 in buyer-payments.controller.ts already pass through
  BuyerSellerContextGuard, so the guard fix alone refuses the removed seller on the very next request. The five
  unguarded routes are account-level (getSellers, getInviteDetails, acceptInvite, requestSeller,
  disconnectFromSeller); getSellers must filter the removed seller so the switcher never offers a dead one.
- **Data repair: READ-ONLY reports during train 4** for B214 (orphaned spendable credit notes), B131 (orders or
  invoices generated for removed customers), B215 (doubled merge totals) and B216 (stale downgrade on a
  reinstated tenant). SELECT-only, session forced read-only, row ids and counts, no client identifiers. The owner
  decides any repair separately; no backfill ships with a fix.
- **Fable 5.1 is out of usage credits** (probe HTTP 429). S4/S5 for all four runs are authored by Opus 5, the
  documented fallback; in-engine Fable stages fall back to Opus @ xhigh (proven on the Next 15 run).
