# W12 — Money Correctness & Cascading Deletes Audit

**Audited:** 2026-04-29
**Scope:** Financial arithmetic, tax logic, AR aging, cascading delete behavior, soft-delete safety
**Status:** Read-only audit — no files modified

---

## Summary

Six findings identified: one P0 (silent cascade destroys all financial history on customer delete), two P1s (tax-exempt flag never applied; bulk product delete destroys PAID invoice lines), and three P2s (tax order, AR aging VOID counting, FK latent violation).

---

## Findings

### W12-B1 — deleteCustomer() silently hard-cascades ALL financial records (P0)

- **Severity:** P0
- **File:** `apps/api/src/customers/customers.service.ts:1220–1342`
- **Issue:** `deleteCustomer()` runs a transaction that unconditionally hard-deletes: invoices, invoice items, credit notes, orders, order items, transactions, payments, advance payments, returns, return items, estimates, recurring invoices, order templates, and route associations. There is no check for PAID invoices, DELIVERED orders, or audit-relevant records. An operator who clicks "Delete Customer" destroys all financial history permanently with no warning dialog enforced at the API level.
- **Evidence:** `customers.service.ts:1238–1340` — sequential `deleteMany` calls for every financial entity.
- **Repro:** Delete any customer with PAID invoices via `DELETE /customers/:id`. Reload `/finance/dashboard` — AR total decreases, PAID records gone from audit log.
- **Impact:** Permanent, unrecoverable data loss. Violates any financial audit requirement.
- **Fix:** Block deletion if customer has any PAID or SENT invoices, DELIVERED orders, or any transaction record. Offer archive/soft-delete instead. If hard delete must be supported, restrict to SUPER_ADMIN with explicit `force=true` flag and a 24h delay with email confirmation.

---

### W12-A4 — Customer.isTaxExempt field is stored but never read by orders or invoices (P1)

- **Severity:** P1
- **File:** `apps/api/src/customers/dto/create-customer.dto.ts:36`, `apps/api/src/orders/orders.service.ts`, `apps/api/src/bookkeeping/invoice.service.ts`
- **Issue:** The `Customer` schema has an `isTaxExempt` boolean field, it is editable via the API, and the UI exposes it. However, neither `orders.service.ts` nor `invoice.service.ts` reads this field when computing tax. All customers are taxed at the tenant's configured rate regardless of exempt status. No grep match for `isTaxExempt` anywhere in orders or bookkeeping service code.
- **Evidence:** `grep -r isTaxExempt apps/api/src/orders apps/api/src/bookkeeping` — zero matches.
- **Repro:** Mark a customer as tax-exempt, create an order for them — invoice still shows full tax amount.
- **Impact:** Tax-exempt customers are incorrectly charged tax on every invoice. Financial/compliance issue.
- **Fix:** In orders and invoice creation, include `customer.isTaxExempt` in the price calculation; if true, apply 0% tax to all line items.

---

### W12-B2 — bulkDeleteCustomers() and deleteCustomer() destroy OrderItem/InvoiceItem from PAID invoices (P1)

- **Severity:** P1
- **File:** `apps/api/src/customers/customers.service.ts:1350–1477`
- **Issue:** `bulkDeleteCustomers()` (the batch version) uses the same unconditional cascade pattern as `deleteCustomer()`. In addition, `routeRunStop.deleteMany` is called twice on line 1311 and line 1450 in the two functions (duplicate, no-op on second call but indicates copy-paste error). Both functions delete PAID invoice items, which corrupts the financial audit trail.
- **Evidence:** `customers.service.ts:1450` and `1453` — `routeRunStop.deleteMany` called twice in the bulk function.
- **Fix:** Same as W12-B1 — block deletion of customers with financial history; use soft-delete/archive.

---

### W12-A5 — Tax is computed before invoice discount is applied — over-collects tax (P2)

- **Severity:** P2
- **File:** `apps/api/src/bookkeeping/invoice.service.ts` (invoice total computation)
- **Issue:** Invoice total computation applies the tax rate to the pre-discount subtotal. The correct calculation is: `tax = (subtotal - discount) * taxRate`. When a discount is applied, tax is calculated on the higher base and the customer is over-charged by `discount * taxRate`.
- **Impact:** Example: $1000 invoice, 10% discount, 8% tax. Correct tax = $72. Actual tax collected = $80. Over-collection of $8 per discounted invoice.
- **Fix:** Apply discounts to subtotal before computing tax. Update invoice totals accordingly.

---

### W12-A6 — VOID payments counted as paid in AR aging; credit notes not netted (P2)

- **Severity:** P2
- **File:** AR aging query in `apps/api/src/bookkeeping/bookkeeping.service.ts`
- **Issue:** AR aging bucket calculation sums all payments without filtering `status != VOID`. Voided payments reduce AR artificially. Additionally, applied credit notes are not subtracted from outstanding balance in the aging report, causing double-counting of credits.
- **Impact:** AR aging report shows incorrect balances. Finance team makes collection decisions on bad data.
- **Fix:** Filter payments to `status = CONFIRMED` only. Subtract applied credit note amounts from invoice outstanding balance in the aging query.

---

### W12-B5 — StockMovement.performedById FK not nullified before user delete — latent 500 (P2)

- **Severity:** P2
- **File:** `apps/api/src/customers/customers.service.ts:1340`, Prisma schema `StockMovement` model
- **Issue:** `deleteCustomer()` deletes the associated `User` record (`tx.user.delete`) after deleting customer records. If the deleted user created any `StockMovement` records (via product adjustments in their session), the `StockMovement.performedById` FK still references the deleted user. Prisma's default FK behavior on most databases will either cascade-delete the movement (silently destroying inventory history) or throw a FK violation (500 error).
- **Evidence:** `customers.service.ts:1340` — `tx.user.delete({ where: { id: customer.userId } })` with no preceding nullification of `StockMovement.performedById`.
- **Fix:** Before deleting the user: `tx.stockMovement.updateMany({ where: { performedById: userId }, data: { performedById: null } })`.

---

## Summary Table

| ID     | Severity | Title                                                                   |
| ------ | -------- | ----------------------------------------------------------------------- |
| W12-B1 | P0       | deleteCustomer() silently destroys all financial records                |
| W12-A4 | P1       | isTaxExempt stored but never applied — all exempt customers taxed       |
| W12-B2 | P1       | bulkDeleteCustomers() destroys InvoiceItem/OrderItem from PAID invoices |
| W12-A5 | P2       | Tax computed before discount — over-collects tax                        |
| W12-A6 | P2       | VOID payments counted in AR aging; credit notes not netted              |
| W12-B5 | P2       | StockMovement.performedById FK not nullified before user delete         |
