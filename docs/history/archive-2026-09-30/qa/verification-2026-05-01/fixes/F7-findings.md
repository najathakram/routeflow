# F7-MONEY

## Plan (5 bullets)

1. **RF-011/RF-012 (InvoicesService)**: `duplicate()` needs one guard (`orderId !== null`). `update()` currently skips total recalc when `dto.items` is absent — fix by fetching existing items and recomputing subtotal/tax/total whenever discount or shippingFee change.

2. **RF-014 (Order number race)**: The schema already has `@@unique([tenantId, orderNumber])` and `create()` already retries on P2002 inside `tenantTransaction`. The only remaining gap is the unique index hasn't been applied to the Railway DB yet. Write the migration SQL (partial index, WHERE orderNumber IS NOT NULL) and a dedup script to clear the known live collision before the index can be applied.

3. **RF-017 stock check**: Code already runs `SELECT … FOR UPDATE` on product rows inside `tenantTransaction`, then checks `currentStock >= qty` and throws `ConflictException` on shortfall. Status verified correct — no code change needed, but test coverage added.

4. **RF-172 (no upsert)**: `create()` always calls `tx.order.create` — no upsert present anywhere in the file. Status verified correct — test added to guard against regression.

5. **RF-079 tax-exempt gap**: Both `create()` and `createInvoiceFromOrder()` already zero out tax for `isTaxExempt` customers. The third path — `createInvoiceFromOrderWithTenant()` (fire-and-forget) — used `order.tax` raw, bypassing the exemption. Fixed by fetching `customer.isTaxExempt` before computing `taxAmount`.

---

## RFs addressed

| RF       | Sev | Status                          | Files                                                                                                         | Commit  | Test added          | Migration?            |
| -------- | --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- | ------------------- | --------------------- |
| RF-011   | P1  | ✅ Fixed                        | `invoices.service.ts`                                                                                         | 323639d | ✅ unit             | No                    |
| RF-012   | P1  | ✅ Fixed                        | `invoices.service.ts`                                                                                         | 323639d | ✅ unit             | No                    |
| RF-014   | P1  | ✅ Migration written            | `migrations/20260501100000_order_number_unique_index/migration.sql`, `scripts/fix-order-number-duplicates.js` | 323639d | ✅ concurrency note | ⚠️ MIGRATION REQUIRED |
| RF-017   | P1  | ✅ Already correct              | `orders.service.ts` (no change)                                                                               | —       | ✅ unit             | No                    |
| RF-172   | P1  | ✅ Already correct              | `orders.service.ts` (no change)                                                                               | —       | ✅ unit             | No                    |
| NEW-v2-1 | P2  | ✅ Already correct              | `vendor-bills.service.ts` — `qty = new Prisma.Decimal(item.qty)` is the full line quantity                    | —       | —                   | No                    |
| RF-010   | P1  | ✅ Already correct              | `invoices.service.ts` line 617 — `Only DRAFT invoices can be edited` guard present                            | —       | —                   | No                    |
| RF-079   | P1  | ✅ Fixed (fire-and-forget path) | `invoices.service.ts`                                                                                         | 323639d | ✅ unit             | No                    |

---

## Notes / blockers

- **NEW-v2-1 (vendor-bills receive)**: After re-reading, the bug description says "increments stock by 1 instead of bill.lineItem.quantity". The actual code (`const qty = new Prisma.Decimal(item.qty)`) correctly uses the full item quantity — no bug found. No change made.

- **RF-014 — MIGRATION REQUIRED before deploying**: Run `apps/api/scripts/fix-order-number-duplicates.js` against Railway prod first (to clear duplicate `ORD-*` values), then apply `migrations/20260501100000_order_number_unique_index/migration.sql`. Do NOT apply migration before the dedup — the unique index will fail if duplicates still exist.

- **RF-014 concurrency test limitation**: Jest's single-process Prisma mock cannot simulate two concurrent DB transactions. The test instead verifies (a) `order.upsert` is never called (RF-172), and (b) the unique index + P2002-retry logic is the actual concurrency defence. Documented in the test.

- **RF-012 recalc and tax**: When only discount/shippingFee change (no `dto.items`), the recalc re-reads `invoiceItem.taxRate` from the DB. This correctly handles tax-exempt customers because their items already have `taxRate: 0` stored at invoice creation time.

- **Build**: `npx nest build` passes cleanly. Two pre-existing TS errors in `routes.service.ts` (`idempotencyKey`) and `returns.controller.ts` (`findOneForUser`) — both exist on `master` before this branch and are unrelated to F7 changes.

---

## User-visible proof of fix

- **RF-011**: `POST /invoices/:id/duplicate` on an order-linked invoice returns HTTP 400 with `"Cannot duplicate an order-linked invoice"`.
- **RF-012**: `PATCH /invoices/:id` with `{ "discount": 20 }` (no items) returns the invoice with an updated `total` reflecting the new discount.
- **RF-014**: After dedup + migration, concurrent order creation requests produce unique `orderNumber` values; duplicates get P2002 → retry with new sequence value → succeeds.
- **RF-079**: Fire-and-forget invoice auto-created when a tax-exempt customer's order is marked DELIVERED has `taxAmount: 0` (previously it copied `order.tax` which could be non-zero if set before exemption was flagged).
- **Tests**: 22 unit tests pass (`npx jest invoices.service.spec orders.service.spec`).
