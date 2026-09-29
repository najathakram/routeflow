# B562 — history-preserving stock ledger and cost replay (SA-136, 2026-09-24)

Senior Architect spec (Fable). Grounded at origin/master 9e7e1721. Test tenants only; no flag flips.

## 0. What is wrong, in one line each (verified)

- `Product.currentStock` is moved with NO `StockMovement` row by: order create (`decrementStockForSale`,
  orders.service.ts :2106/:2577; order-templates.service.ts :602), order edit/cancel/uncancel
  (`settleStockForEdit`, orders.service.ts :2607/:2732/:2929/:4584/:5468), and the return-cancel undo
  (returns.service.ts :905-925, which ALSO `deleteMany`s the RETURN rows — a second history destroyer).
- `replayProduct` (inventory.service.ts :2640-2800) orders rows by `createdAt`, folds cost on
  PURCHASE / COST_BASIS / ADJUSTMENT-with-cost, treats SALE/RETURN/WRITE_OFF as stock-only, refuses on
  `counter − Σqty ≠ 0` (L-207, #934), and on no gap REWRITES every row's `avgCostAfter`/`stockAfter` plus
  `Product.averageCost`.
- `recordPurchase`/`recordAdjustment` OVERWRITE `createdAt` with `effectiveDate` (:249/:301), so a
  backdated row also loses its insertion time.
- Point-in-time COGS (`buildCostIndex`/`costAt`, common/invoiced-sales.ts :365-400) reads
  `avgCostAfter` by `createdAt`; invoiced sales, not SALE rows, are the COGS quantity source (unchanged).
- The corruption is real for AVCO even though a sale never changes the average: `nextAverageCost` weights
  by the stock ON HAND at each purchase. Buy 10 @ $1, sell 8, buy 10 @ $3: true average (2×1 + 10×3)/12
  = 2.6667; the sales-blind replay computes (10×1 + 10×3)/20 = 2.0. This pair is the hand-computed pin.

## 1. The invariant (the contract L-207 implies)

**Every write to `Product.currentStock` appends exactly one `StockMovement` row for that product in the
same transaction, with the signed quantity that moved the counter, a `reference`, a `performedById`
where a user exists, and `stockAfter` = the counter after the write.** Ledger-implied stock equals the
counter at every commit. Enforced mechanically (§6.2), not by review.

## 2. Sale-side movement shape

- Type `SALE`. `quantity` = −(pieces removed) on create / edit-increase / uncancel-restore; +(pieces
  credited) on edit-decrease / cancel (the UNDELIVERED credit `settleStockForEdit` already computes). A
  sale reversal is a positive SALE row — never RETURN (RETURN is the physical-return restock flow,
  returns-restock.util.ts) and never ADJUSTMENT (an ADJUSTMENT with a cost changes the average on replay).
- One row per product per stock event (the per-product delta the writers already compute), not per line.
  `reference` = `ORDER:<orderId>`; `notes` = the event: `CREATE` | `EDIT` | `CANCEL` | `UNCANCEL` |
  `TEMPLATE:<templateId>`. `performedById` = the acting user (`user.sub`) or null for the cron template run.
- `unitCost` = the product's cost at the moment, exactly as the existing SALE writer at
  inventory.service.ts :955-990 resolves it (AVCO → `averageCost`; STANDARD → `standardCost`; LAST_COST →
  last PURCHASE; FIFO → lot plan). Extract that writer into `inventory/sale-movement.ts`
  (`recordSaleMovement(tx, {productId, quantity, reference, notes, performedById})`) and call it from
  order-stock.ts; do not write a second cost resolver. `avgCostAfter` = the average (unchanged by a sale);
  `stockAfter` = the counter returned by the `product.update` that moved it — write the row AFTER the
  update, from the returned row, never from a pre-read.
- Where: inside `decrementStockForSale` and `settleStockForEdit` (order-stock.ts), which already hold the
  tx and the `FOR UPDATE` locks — no new lock. DRAFT orders move no stock and write no row (unchanged).
  A staff oversell still writes its row (`stockAfter` negative — the ledger must say so).
- Return-cancel undo (returns.service.ts :905-925): append reversing RETURN rows (negative quantity, same
  `reference`, notes `RETURN_CANCELLED`) instead of deleting the originals. Nothing deletes a movement.
- COGS readers are untouched: `invoiced-sales.ts` keeps invoiced sales as the quantity source; SALE rows
  exist for the stock ledger and the replay, and the header comment there is updated to say so.

## 3. Dates: `effectiveAt` is the accounting date; `createdAt` is write-once

- Add `StockMovement.effectiveAt DateTime @default(now())`, backfilled `= createdAt` in the same
  migration (additive; Squawk-clean; drift gate exit 0). `recordPurchase`/`recordAdjustment`/vendor-bill
  receive write `effectiveAt = effectiveDate` and STOP overriding `createdAt`.
- Replay ordering and the cost index order by `(effectiveAt, createdAt, id)`. For every existing row the
  two are equal, so PR-1 is behaviour-neutral.

## 4. The replay becomes history-preserving

- Snapshots are write-once: `avgCostAfter`/`stockAfter` on an existing row are never updated. A backdated
  row carries the snapshot of the state after ITS insertion (the counter after it, the average after it).
- `replayProduct` becomes a pure computation: (rows by `effectiveAt`) → implied stock, implied average
  (same fold as today), `gap = counter − implied stock`. Gap ≠ 0 → refuse / report exactly as now
  (throwOnGap / per-item degrade unchanged). Gap = 0 and `|impliedAvg − Product.averageCost| ≥ 0.0001`
  → APPEND one `COST_BASIS` row (`quantity 0`, `unitCost = impliedAvg`, `avgCostAfter = impliedAvg`,
  `stockAfter = counter`, `effectiveAt = now`, `reference = RECOMPUTE:<trigger>` where trigger is
  `PURCHASE:<movementId>` / `ADJUSTMENT:<movementId>` / `BILL:<billId>` / `ENDPOINT`, `notes` =
  `old → new`) and set `Product.averageCost = impliedAvg`. Nothing else is written. The correction is dated
  when it is made — the same rule SA-134 gives the regulated ledger; prior-period COGS reports do not move.
- `POST /inventory/recompute-costs`: `@Roles(TENANT_ADMIN)` (platform admin included), `dryRun` defaults
  TRUE, the apply path is the §4 append only, the response lists per product `{gap, oldAvg, newAvg,
correctionId | null}`. The UI stays hidden (#931) until PR-3 deploys; it may return afterwards as an
  admin-only "Check costs" (dry run) with apply behind confirm + reason. Audit row on every apply.

## 5. Backfill and repair (scripts only; dry-run default; owner-run)

Both scripts follow the B681/SA-134 script gates verbatim: read-only report first, content-hashed plan,
`--apply --plan --confirm-plan --guard-sha --i-have-a-fresh-backup`, `assertTestTenant` unless
`--live-tenant-override` with type-back, refuse if any row in the plan changed since the dry run, one
transaction, exit 0/1/2. Prod runs go through the lead's `railway run` warn-then-approve.

- **D1 — close the gap (after PR-2 deploys, once).** Per product: `drift = currentStock − Σquantity`.
  Report per tenant/product: drift, last movement, count and Σ line qty of non-DRAFT/non-CANCELLED
  orders (what the ledger never saw), whether OrderRevision covers the order's edits. Apply = ONE row per
  product with drift ≠ 0: type `SALE`, `quantity = drift` (negative when sales exceed), `unitCost` null,
  `reference = B562:BACKFILL:<planHash>`, `notes = "ledger gap closed at cutover"`, `effectiveAt = the
cutover timestamp`. Under the fold, SALE is stock-only, so the average is untouched. After D1 every
  product's gap is 0, and backdated purchases are accepted again — the user-facing half of (a). Idempotent
  on the reference.
- **D2 — repair the average (AVCO products only).** Report: for each AVCO product with ≥ 1 costful row
  AND a nonzero pre-D1 drift, recompute the average by replaying purchases/adjustments with sales
  interposed from Order rows (line qty at `Order.createdAt`, non-DRAFT/non-CANCELLED; the cancelled
  order's undelivered credit at its cancel time; edits from OrderRevision snapshots where they exist).
  Confidence per product: EXACT (no edits or every edit has a revision) / APPROX (edits without
  revisions). Columns: current average, reconstructed average, delta, valuation delta = stock × delta.
  The owner decides per product or by threshold. Apply = one `COST_BASIS` row per chosen product
  (`reference = B562:REPAIR:<planHash>`, notes with both figures and the confidence) + `Product.averageCost`.
  No existing row is touched; refuse if the reference exists. Rows whose snapshots the old replay already
  rewrote cannot be restored — the report lists them (drift ≠ 0 AND a costful row dated after the first
  order) so nobody expects a history that no longer exists.

## 6. Proof gates

1. **DB spec (real Postgres, the lead's gate)** — order create → SALE −qty, counter and `stockAfter`
   agree; edit +2 then −1 → two rows; cancel → +undelivered only (a delivered line credits nothing);
   uncancel → the restore row; template generate → row; DRAFT → no row; staff oversell → row with a
   negative `stockAfter`; return cancel → reversing RETURN rows, originals intact. Then
   `recomputeProductInTx` reports `gapDetected: false` on that product; a backdated purchase (`effectiveAt`
   before the sale) is ACCEPTED and appends exactly one COST_BASIS row; the §0 pair pins the average:
   2.6667 with the SALE rows present, and the same fixture with the rows deleted must REFUSE (the L-207
   guard still stands). Snapshots on pre-existing rows are byte-identical before and after the replay.
2. **Writer coverage spec** — every `currentStock: { increment | decrement }` site in apps/api/src is
   inside a function that also creates a `StockMovement` in the same tx, proven by AST (the
   `unit-line-writers.ast.spec.ts` / `sellable-writers-coverage.spec.ts` pattern), with a shrink-only
   allow-list for the two sites the bulk stock-count path pairs one level up. A new writer without a row
   is a red `npm run verify`.
3. **Gap detector** — `apps/api/scripts/stock-ledger-gap.mjs`: read-only, per tenant/product
   `counter − Σquantity`, exit 2 on any drift. Runs in `local:validate` after the DB lane and against prod
   after each deploy in this series (lead-authorised). It is the standing guard that the invariant holds,
   the way `schema-drift.mjs` guards the schema.
4. **Migration** — additive `effectiveAt` + backfill; `lint:migrations` clean; `local:drift` exit 0.

## 7. Staging (the SA's call): four PRs, in order, each with a tier-1 SA read at its sha

- **PR-1 schema + dates** — `effectiveAt`, backfill, writers stop overriding `createdAt`, replay and
  cost index order by `effectiveAt`. Behaviour-neutral for existing rows. Migration applied to prod
  BEFORE merge (L-184 ordering; exact backup command in the hand-off).
- **PR-2 writers** — `recordSaleMovement` extraction, order-stock.ts + template + return-cancel rows,
  the coverage spec, DB spec part 1, the gap detector. From this deploy on, the gap stops growing.
- **PR-3 replay** — write-once snapshots, COST_BASIS append, endpoint role + dryRun default, DB spec
  part 2 (backdated purchase accepted; the 2.6667 pin; refusal with rows deleted).
- **PR-4 scripts** — D1 and D2 with the §5 gates and their own DB specs on the `test` tenant. The owner
  runs D1 on prod after PR-2 is live and before PR-3's first backdated write; D2 on the owner's schedule.

Out of scope, filed separately: the vendor-bill un-receive path's own pairing (the builder verifies it
under §6.2 and files if unpaired); a per-line COGS snapshot on invoice lines (invoiced-sales.ts :356
"lines carry no unit cost") — a design item, not this bug.
