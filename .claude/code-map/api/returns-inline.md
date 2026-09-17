# api — Returns Inside Order Creation (INLINE returns)

New capability, landing across PR-1a–5 (design: `local-assets/handoff/2026-09-15/order-returns/`;
not committed — a local planning artifact, read at build time only). STANDARD (existing
post-delivery RMA) stays documented in [`feature-modules-3/returns.md`](feature-modules-3/returns.md) —
this file covers only the new `kind: INLINE` path, added incrementally per PR. PR-1a/1b/1c
(schema, quote pricing, capture/issue/approve/reject/cancel) are landed; PR-1d (tenant grant) is
blocked on B467 (DB-backed specs), see "Not yet built" below.

## PR-1a (2026-09-15) — schema + shared readers

- **Migration** `prisma/migrations/20260915180000_returns_inline_schema/` — additive only, every
  NOT NULL column defaulted (Squawk `adding-required-field` clean). New enum `ReturnKind`
  (`STANDARD | INLINE`, `sales.prisma`) on `Return.kind` (`@default(STANDARD)`). New nullable
  columns on `Return` (capture/hold/approval/mismatch/credit-split fields, §2.2 of the design) and
  `ReturnItem` (source-order provenance + per-item pricing fields) — all unused until PR-1c/1d
  writes them; `Return.returnKey` carries a new `@@unique([tenantId, returnKey])`.
  `RETURN_KIND_VALUES`/`ReturnKind` mirrored in `packages/types/api/enums.ts` + a row in
  `common/enum-parity.spec.ts`'s `ENUM_TABLE` (L-072) — bumps `PINNED_PRISMA_ENUM_COUNT` 84→85
  and `common/schema-folder.spec.ts`'s `EXPECTED_ENUM_COUNT` 84→85.
  `RETURN_HOLD_REASON_VALUES`/`RETURN_PRICE_SOURCE_VALUES` are plain-string const arrays (same
  CREATE-TYPE-avoidance reasoning as `Return.refundMethod`) — no Prisma enum, no parity row.
  `MODEL_DOMAIN` (`split-prisma-schema.mjs`) untouched — no new model, and `ReturnKind` sits in
  `sales.prisma`, which already holds `Return` (the membership check `split-prisma-schema.mjs
--check` runs).
- **`returns/returns-pieces.util.ts`** (new) — B4/m-6 shared accounting, used by both the
  STANDARD flow today and the (PR-1c/1d) INLINE capture flow:
  - `soldPiecesForProduct(order, productId)` — sold pieces = the SUM of the product's
    non-CANCELLED `OrderItem` lines (fixes the pre-fix bug: `create()` used to `.find()` a
    single line, undercounting a product split across two lines on one order).
  - `firstNonCancelledLine(order, productId)` — lowest `position`, nulls last; the axis a future
    box/piece-aware DTO conversion would key off (unused by today's identity conversion).
  - `standardReturnPieces(order, productId, qty)` — converts a STANDARD return DTO's `qty` to
    pieces + a `toLineUnit` converter back, for refusal-message formatting. Identity today
    (`ReturnItem.qty`/DTO `qty` is already pieces, like `OrderItem.qty` — see file header) — a
    named seam so a future non-identity conversion changes one place, not every caller.
  - `returnedPiecesByProduct(tx, orderId)` — prior-returned pieces per product for a SOURCE
    order, summing STANDARD `Return` rows (`Return.orderId`) AND INLINE `ReturnItem` rows
    (`ReturnItem.sourceOrderId`) — kind-aware from day one, even though no INLINE row exists
    until PR-1c/1d. Replaces `returns.service.ts create()`'s old inline `existingReturns` read.
- **`returns/returns.service.ts` — kind branching (M6/§2.3).** Every standard-path method
  (`create/findAll/findOne/cancel/reject/markInTransit/receive/processRefund/approve`) refuses an
  INLINE-kind return with `BadRequestException("INLINE_RETURN_USE_INLINE_ENDPOINTS")` — INLINE
  gets its own endpoints/state machine in PR-1c/1d, never these. `findAll`'s `where` always carries
  `kind: "STANDARD"`; `create()` always writes `kind: "STANDARD"` explicitly. `create()`'s per-item
  validation loop now goes through `soldPiecesForProduct`/`standardReturnPieces`/
  `returnedPiecesByProduct` instead of its old inline `.find()` + `existingReturns` read — refusal
  message text is byte-identical (`toLineUnit` is the identity conversion today).
  `customers.service.ts`'s three bulk-delete `Return`/`ReturnItem` cleanup sites (`deleteCustomer`,
  `batchDelete`, `deleteImportedCustomers`) were reviewed and left kind-agnostic on purpose — a
  hard/soft customer delete removes every `Return` regardless of kind; nothing INLINE-specific to
  miss (its `CreditNote`/`OrderCreditNote` rows are already covered by the existing credit-note
  cleanup).
- **`create()` — customer-keyed lock (§5).** A new `IdempotencyService.acquireLock` call
  (`hashFor(order.customerId, tenantId, "returns.customer")`), placed after the existing
  idempotency lock/check and the unlocked order read, before the order-row `FOR UPDATE` — gated
  `if (this.idempotency)` (the field is `@Optional()`), unconditional on an `Idempotency-Key`
  header (unlike the key-scoped lock above it). Serializes STANDARD and (PR-1c/1d) INLINE returns
  for the same customer so `returnedPiecesByProduct`'s read can't race across two orders.
- **`regulated/regulated-ledger.service.ts` — `reverseReturnEntries` idempotency key widened
  from `returnId` alone to `(returnId, orderId)`.** An INLINE return's goods can span MULTIPLE
  source orders; this method is called once PER source order (design §5: STANDARD callers keep
  passing `ret.orderId`, a no-op change for them). `unreverseReturnEntries` (keyed by `returnId`
  alone, deletes every REVERSAL row for the return) is unchanged.
- **Specs:** `returns-pieces.util.spec.ts` (new — unit coverage for the shared readers, incl.
  STANDARD-after-INLINE / INLINE-after-STANDARD ordering); `returns-kind-branch.spec.ts` (new — the
  9-method refusal matrix + `findAll`/`create`'s explicit `kind: "STANDARD"`);
  `returns-overreturn.spec.ts` gains the B4 multi-line-sum probes + the §3.5 box-split STANDARD DTO
  literal, and its/`returns-idempotency.spec.ts`/`returns-numbering.spec.ts`'s transaction-client
  stubs gained a `returnItem: { findMany }` mock (the shared reader queries it too) —
  `returns-idempotency.spec.ts`'s `acquireLock` call-count pins (REG-RET-IDEM-3/9) were updated for
  the new customer lock, and its mock's `acquireLock` releases a `returns.customer`-scoped hash
  immediately (rather than holding it for a whole `create()` call with no matching release hook,
  which would deadlock every second call in the suite — every test there reuses one customer).
  `regulated-ledger.service.spec.ts` gains the widened-key probes.

### Fix round (independent Opus refute-first review, same PR)

- **F1 (money, the review's headline finding):** `priceReturn`'s never-invoiced legacy basis
  (`allInvoices.length === 0` branch) still priced off a single `.find()`-matched line's per-unit
  rate while `create()`'s cap now sums a product's qty across every non-CANCELLED line — a product
  split across two differently-priced lines could price the WHOLE pooled return at one line's rate
  and over-credit. Fixed by pooling qty/subtotal per product in that branch too (same pattern the
  invoiced branch already uses), with `refundQty = min(returned, sold)` as a second backstop.
- **F2:** `soldPiecesForProduct`'s CANCELLED exclusion and `firstNonCancelledLine`'s `position` sort
  were silently no-ops in production — none of the four `order.lineItems` selects in
  `returns.service.ts` (`create`/`findAll`/`processRefund`/`findOne`) fetched `status`/`position`.
  Added both fields to all four selects (and `subtotal` where F1's fix needed it, `create`'s select
  didn't have it before either). The existing "CANCELLED line doesn't count" test only passed
  because its MOCK supplied fields the real query never selected — a real coverage hole, not a real
  guarantee; the select fix is what actually closes it.
- `findOne`'s `orderedQty` enrichment now also uses `soldPiecesForProduct` (was the same single-line
  `.find()` as F1) so the operator UI's shown cap matches what `create()` actually enforces;
  `unitPrice` stays a single line's rate (display-only, no one line to attribute a pooled rate to).
- `regulated-ledger.service.spec.ts`'s "two source orders" test was rewritten: the original used the
  file's shared `arrange()` helper, a call-order `mockResolvedValueOnce` queue that never inspects
  `where` — it passed identically against the UN-widened key, so it proved nothing. New version
  drives a real `where`-aware fake store keyed on `(returnId, orderId)`.
- New `returns-customer-lock.spec.ts` — the condition-4 revert probe (concurrent lock exclusion) was
  missing entirely; `returns-idempotency.spec.ts`'s shared mock releases the customer-hash lock
  immediately by design (holding it would deadlock that file's many sequential same-customer tests),
  so genuine mutual exclusion needed its own dedicated mock that holds the lock until the enclosing
  transaction resolves, mirroring the real `pg_advisory_xact_lock`'s commit-time release. Two
  concurrent STANDARD `create()`s on different orders for one customer stand in for the "STANDARD
  vs. INLINE" pair the brief asked for, since no INLINE endpoint exists yet to seed a real one.

## PR-1b (2026-09-16, #809) — quote pricing engine

- **`returns/inline-returns-pricing.ts`** — pure engine (design §3): matches a requested return
  qty against a customer's invoiced sales (matching set = `REAL_INVOICE_STATUSES` union non-VOID
  DRAFT of a DELIVERED/PARTIALLY_DELIVERED order, 90-day sold window), allocates newest-order-first
  per `(sourceOrderId, productId)` against `returnedPiecesByProduct` (PR-1a), and prices each chunk
  via `priceSellingUnitChunk` (shared by matched/unreferenced/manual — `computeLineSubtotal` +
  `normalizeBoxesPieces`, never `qty * unitPrice` on a boxed line): **matched**
  (`prorateLineSubtotal`, discount share, m-7 zero-tax guard, snapshot `line.taxRate` — never the
  tenant's current rate), **unreferenced** (tier/`CustomerPrice` or base price, tax via
  `currentTaxRate` since PR-1c), or **staff manual override**. `CandidateInvoiceLine.piecesQty`
  (added in the fix round) is the ONLY axis used for pooling/capping against sold pieces — `qty`
  stays the proration axis inside `priceMatchedChunk`, so a selling-unit line's boxes are never
  pooled as if they were pieces.
- **`InlineReturnsQuoteService.quote(dto, user): Promise<...>`** — wires the DB reads (customer,
  `CustomerPrice`, products, matching-set invoices) into the pure engine. M8: a DRIVER caller must
  supply `routeRunStopId` and can only quote for that stop's own customer on their own IN_PROGRESS,
  non-COMPLETED/SKIPPED run (mirrors `orders.service.ts`'s B309 guard) — checked before any other
  read. `UserRole.CUSTOMER` refused with an explicit `ForbiddenException` at the top (Q5 — buyers
  keep the post-delivery `returns.service.ts` flow), defense-in-depth alongside the controller's
  `@Roles`.
- **`POST /returns/inline/quote`** (`returns.controller.ts`, OPERATOR/TENANT_ADMIN/DRIVER, never
  CUSTOMER) gated `@RequireAddon("orders_inline_returns")`, registered **ENFORCED from day one**
  (owner-answers.md Q-A's written exception to "new gates ship dark" — zero existing users, blast
  radius empty by construction).
- Customer lookup uses `findFirst({where:{id, deletedAt:null}})`, never `findUnique` (bypasses the
  tenant-scoping post-filter — B131 convention).
- **Specs:** `inline-returns-pricing.spec.ts` (all 7 §3.5 literal oracles pinned with revert
  probes — box-split, selling-unit, BOGO, discount-share, exempt x2, rate-change; oracle 8 is
  PR-1a's), `inline-returns-quote.service.spec.ts` (M8 scoping + wiring).

## PR-1c (2026-09-16, #816) — capture/issue/approve/reject/cancel

- **`returns/inline-returns.service.ts` — `InlineReturnsService`.** `capture(dto, user)`: CUSTOMER
  refused up front (Q5); an unlocked pre-read resolves an already-captured `returnKey` (required on
  `CaptureInlineReturnDto` — no client calls this route yet, so every capture is replay-safe from
  day one) WITHOUT opening a transaction, routed through the SAME post-processing tail as a fresh
  capture (a stuck RECEIVED row — issue failed after capture committed — is retried here too, not
  just on a fresh capture); only trusted as a replay when it matches THIS `(customerId, orderId)`
  pair (a collision across two unrelated requests 409s). Inside the transaction: the same
  customer-scoped advisory lock STANDARD returns use (§5), an `Order FOR UPDATE` read, prices via
  `InlineReturnsQuoteService`'s engine, restocks + reverses the regulated ledger per source order,
  then either mints a standalone credit note immediately (`mintStandaloneInTx`, credit-notes.
  service.ts) or — above the driver cap (`sumInlineReturnCredit`, driver-cap Σ over the order's
  prior INLINE captures) — holds the WHOLE credit for approval (**HIGH-4**: restock/ledger reversal
  are DEFERRED to `approve()` for a held return, never applied at capture). A driver capture must be
  on their own CURRENT route run. `approve(id, user, dto?)`: the driver-cap claim now lives inside
  the SAME transaction as the mint/link (a failure rolls back atomically); throws before any
  restock/ledger reversal when the held/override amount rounds to ≤ $0.001 (use `reject()` instead).
  `reject(id, user)` and `cancel(id, user)` (m-5) undo a captured return's stock/ledger/credit
  effects — `cancel` skips restock entirely for a never-captured PENDING row, and writes a
  COMPENSATING (negative-qty) stock movement rather than deleting the original by a fragile
  reference-prefix match.
- **`credit-notes.service.ts` §6.3 — exclude an INLINE return's own credit from the general sweep
  until its carrying order is "met".** `isOrderMetInTx(tx, orderId)`: the order's non-VOID invoices
  must ALL be fully paid (CONFIRMED-basis `sumConfirmed`, never a bare not-VOID filter — a
  DRAFT/PENDING payment must not count, #816 payment-status-filter review) or the order is
  CANCELLED; **not met when there are no invoices yet** (the order-entry-time common case —
  MED-6, a pre-fix fallthrough silently treated "no invoice" as "met"). `isSystemOwnedInlineCreditInTx`
  identifies the ONE standalone CN an INLINE return minted for ITS OWN carrying order (no new
  column — a join through `Return`). `autoApplyOldestCreditsInTx` excludes while unmet;
  `syncOrderCreditSelections` never drops/re-amounts the system-owned intent. `mintStandaloneInTx`
  (m-1) / `cancelStandaloneInTx` (m-5, restores CREDIT_NOTE-method `InvoicePayment` rows — kept as
  a not-VOID filter, `scan-ok: draft-payment-not-void`: that payment shape is an internal ledger
  write this service creates atomically as CONFIRMED, never DRAFT/PENDING).
- **`orders.service.ts` — `ORDER_BELOW_RETURN_CREDIT` guard.** A DRIVER order-item edit that would
  drop the order's gross below its already-committed inline-return credit (`sumInlineReturnCredit`,
  `returns/inline-return-credit.util.ts`) is refused — read AFTER the existing `Order FOR UPDATE`,
  so it sees every inline return committed before this edit's lock was granted. Staff edits are NOT
  capped here (they can also approve/reduce a held return). Sits alongside, not instead of, B451's
  `assertMoneyInvariantsOrThrow` guard at the same call site.
- **`common/tax-rate.ts`'s `currentTaxRate`** (see `bootstrap-and-money-pricing.md`) resolves
  PR-1b's deferred unreferenced-chunk tax-rate item.
- **Specs:** `inline-returns.service.spec.ts`, `credit-notes.inline-returns.spec.ts`,
  `inline-return-credit.util.spec.ts`, `orders.inline-return-cap-guard.spec.ts`,
  `returns/dto/{approve,capture}-inline-return.dto.spec.ts`.

## Not yet built (tracked here so the next PR starts from this file, not a re-read)

Alerts, web/mobile UI, `CreditNote.taxAmount`, and B467 (DB-backed specs proving the transactional
invariants — advisory locking, `Order FOR UPDATE`, the driver-cap Σ, `returnKey` replay races —
against a real Postgres, not mocked Prisma; **required before PR-1d or any tenant grant**) — PR-1d/e,
per the design's §10 PR plan.
