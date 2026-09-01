# F07 · Spec — order lifecycle, stock conservation and teardown

**Status: IMPLEMENTED — proven, pending merge** · Scale: major. Scope: exactly B10, B56, B64, B65, B105, B108, B116.
All money math via `pricing.ts` helpers (`roundMoney`); no new deps; no schema change; no
migration. Repo conventions: NestJS module-boundary mocks, class-validator DTOs, Conventional
Commits, Prettier.

## Requirements

### B56 — delivered goods block the cancel

- **R1 (P0, jest):** `cancelImpact(id)` additionally reports `deliveredUnits: number` — the
  3-dp-rounded sum of `deliveredQty` over the order's non-CANCELLED lines — and returns
  `canCancel: false` whenever `deliveredUnits > 0.001`, independent of payments.
  `blockingPayments` semantics unchanged.
- **R2 (P0, jest):** `assertCancellableOrThrow` (hence `changeStatus(...CANCELLED)`, single and
  bulk) throws `BadRequestException` with copy naming the delivered quantity and the two real
  alternatives (record a return / edit the undelivered lines) when the block is delivered-goods;
  the existing payments message is untouched when payments block.
- **R3 (P1, jest mobile + ride-along web):** `describeCancelImpact` in BOTH mirrors renders a
  dedicated delivered-goods `blockedReason` when `canCancel:false` with empty
  `blockingPayments` and delivered units present — never the broken "has been paid: ." string.
  BOTH `lib/api/orders.ts` types (web **and mobile** — review caught the mobile one being
  missed, which broke `apps/mobile` typecheck) gain the additive field. **Corrected at review:**
  `deliveredUnits` is **optional** on `CancelImpactLike` and read as `(x ?? 0) > 0.001`. A client
  build can be older or newer than the API answering it, and an absent field must degrade to a
  safe generic reason rather than crash the only warning shown before live invoices are voided.
  (Web mirror has no unit runner — D1; the mobile jest spec is the proof for the shared shape,
  byte-mirrored copy. The mobile order screen must pass `copy.title`, not a hardcoded one.)

### B64 — cancel returns stock; reopen re-takes it

- **R4 (P0, jest):** the CANCELLED branch of `changeStatus`, inside its existing Serializable
  `tenantTransaction`, credits back each product's undelivered remainder — via
  `settleStockForEdit(tx, order(pre-cancel status), activeItems, [])` so the credit is clamped
  to `max(0, qty − deliveredQty)` per product, under the same FOR UPDATE lock — and then flips
  every surviving (non-CANCELLED) OrderItem to `CANCELLED` in the same tx. Item flip happens
  AFTER invoice voiding (invoice logic reads active items).
- **R5 (P0, jest):** DRAFT→CANCELLED credits nothing (drafts never decremented;
  `settleStockForEdit`'s internal DRAFT guard, passing the pre-cancel status, covers it).
- **R6 (P0, jest):** `reopenOrder` re-decrements exactly what a post-F07 cancel credited: it
  reads the CANCELLED lines BEFORE flipping them to PENDING, and after the flip re-takes
  `qty − deliveredQty` per product through `settleStockForEdit` (staff warn-only oversell
  semantics — reopen is staff-only, `user` undefined). Orders cancelled BEFORE this fix carry
  no CANCELLED items, so reopen re-decrements nothing for them — consistent with their
  no-credit-back history (era consistency; see build plan).

### B65 — deleteOrder reverses the regulated ledger

- **R7 (P0, jest):** `deleteOrder` calls `ledger.reverseInvoiceEntries({ invoiceId, db: tx })`
  for each linked invoice INSIDE the existing transaction, BEFORE that invoice's rows are
  deleted (mirroring `deleteInvoice`'s ordering and no-`preserveReturns` shape).
  `OrdersModule` imports `RegulatedModule`; `OrdersService` injects `RegulatedLedgerService`.

### B105 — auto-invoice awaited, retried, surfaced

- **R8 (P0, jest):** in `changeStatus`'s DELIVERED branch, the no-draft path AWAITS
  `createInvoiceFromOrderWithTenant(id, capturedTenantId)`; a `ConflictException` (the P2002
  invoice-number race) is retried up to 3 total attempts (each attempt regenerates the number
  internally).
- **R9 (P0, jest):** if creation still fails, `changeStatus` throws a `ConflictException`
  whose message states the order IS delivered, the invoice was NOT created, and points at the
  real retry path. **Corrected at review:** the control is labelled **"Generate Invoice (full
  order)"** (`page.tsx:3425` → `POST /invoices/from-order/:orderId`); the first implementation
  invented a "Create Invoice" label that does not exist on the page, which sends the operator
  hunting for a missing button — the same dead end R9 exists to close. The status write is not
  reverted (physical delivery happened). No more silent 200. **Also corrected at review:** the
  throw is raised AFTER the delivery notification/messaging block, not inline — the goods
  arrived, so an invoicing failure must not suppress the customer's delivery push (pin T23).
- **R10 (P1, jest):** the happy path still returns the updated order and still runs the
  credit-settle and notification steps after the awaited creation.

### B108 — credit settle retried; send() catch-up made true

- **R11 (P0, jest):** the best-effort Serializable settle in the DELIVERED branch retries up to
  3 total attempts (100ms/300ms backoff) before giving up; final failure logs at `error` (not
  `warn`) with the order id. Delivery still does not fail on settle failure (deliberate,
  preserved).
- **R12 (P0, jest):** `send()` and `sendEmail()` call
  `await this.creditNotes.settleOrderCreditsInTx(tx, updated.orderId)` (request-scoped
  tenantId default) BEFORE computing `explicitIds`/running `autoApplyOldestCreditsInTx`, when
  `updated.orderId` is set — so the documented "send() catches up" fallback actually applies
  explicit-amount credits (at the operator's amount; settle clamps, money never moves twice).
  The explicit-id exclusion for the oldest-first sweep is KEPT.
- **R13 (P1):** the false comment at the swallow site is rewritten to describe the now-true
  behavior.

### B116 — set-based decrement + explicit tx budget

- **R14 (P0, jest):** the order-create `tenantTransaction` passes explicit
  `{ timeout: 20000, maxWait: 5000 }`.
- **R15 (P0, jest):** the per-line decrement loop is replaced by ONE set-based raw UPDATE
  joining a VALUES list, with per-product qty AGGREGATED first (two lines of the same product
  must decrement the summed qty — Postgres `UPDATE … FROM` applies only one row per join key).
  Oversell/warn validation semantics unchanged (still per-line check against the locked read).
- **R16 (P1, jest):** P2002 retry behavior unchanged.

### B10 — the "editing closed" banner renders

- **R17 (P0, e2e T2 / proven-pending-deploy):** on the operator order-detail page, when
  `!canEdit`, a banner renders for BOTH emitted reasons: `"STATUS"` → "Order cancelled —
  editing closed"; `"DISPATCHED"` (buyer semantics, kept for robustness) → existing "Out for
  delivery — editing closed". Stale comments corrected (banner comment :2291; consistent with
  :1759 P5-08/R1 comment). Proof: NEW e2e spec 27 + its `playwright.config.ts` `projects[]`
  entry IN THE SAME PR (spec-26 precedent: without the entry the spec never runs).

## Lifecycle / state sweep (what changes, what deliberately doesn't)

- Cancel: gains stock credit-back + item flip + delivered-block. Wallet release + void order
  preserved. Notifications unchanged.
- Reopen: gains re-decrement. PAID-invoice block unchanged.
- Delete: gains ledger reversal only. Return-block, payment-block, wallet release, commission
  guard unchanged.
- Deliver: creation now awaited; draft-reconcile path unchanged (already awaited); settle
  retried.
- Send/sendEmail: gains settle-before-sweep; DRAFT→SENT flip, status recompute unchanged.
- Create: same locks, same oversell semantics, same order-number retry; only the decrement
  write shape + tx options change.
- **Non-goals:** B208 (manual price on buyer merge); DRAFT-promotion stock decrement (recorded
  residual); any Bull-queue retry infra (dead DI stays dead); UI redesign of the cancel dialog
  beyond the blocked-reason copy; `settleStockForEdit`'s own per-line write loop; T3 proofs.

## Deploy-day / entitlement answers

- No flags, no entitlements, no migration, no backfill required for the CODE. Existing data:
  D4 repair-as-we-go (separate post-deploy step, build plan §repair) for identifiable B56/B64
  damage; pre-fix cancelled orders reopen WITHOUT re-decrement by design (era consistency).
- Rollback story: single revert of the one PR restores prior behavior; no persisted-state
  shape changes.
- Behavior deltas an operator will notice on deploy day: (1) cancels of orders with delivered
  units are refused with actionable copy; (2) mark-delivered can now return an error when
  invoicing genuinely fails (previously a false success) — the order stays delivered and the
  error names the retry path.
