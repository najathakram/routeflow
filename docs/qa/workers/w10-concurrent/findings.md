# W10 — Concurrency & Race Condition Audit

**Audited:** 2026-04-29
**Source:** L1-D supervisor independent audit (W10 worker did not produce a file)
**Scope:** Order/invoice/credit-note number generation races, optimistic locking, TOCTOU patterns
**Status:** Read-only audit — no files modified

---

## Summary

Five concurrency findings identified. The most critical is order number duplication: the `MAX+1` pattern for `orderNumber` has no database unique constraint, enabling silent duplicate order numbers under concurrent load. The other four are race windows in invoice/credit-note creation and stop completion paths.

---

## Findings

### W10-001 — Order number generation: MAX+1 race with no unique constraint → silent duplicates (P1)
- **Severity:** P1
- **File:** `apps/api/src/orders/orders.service.ts:542–551`, `apps/api/prisma/schema.prisma:801`
- **Issue:** Order number generation uses `findFirst({ orderBy: { orderNumber: 'desc' } })` then `parseInt(...) + 1`, executed OUTSIDE any transaction. The `Order` schema has no `@@unique([tenantId, orderNumber])` constraint. Two concurrent `POST /orders` requests for the same tenant will read the same `lastOrder`, compute the same `seq`, and both create orders with identical `orderNumber` strings (e.g., both get `ORD-00042`). Unlike `Invoice` (which has `@@unique`), there is no database-level guard to reject the duplicate.
- **Evidence:**
  - `orders.service.ts:542-551` — `findFirst` outside transaction
  - `schema.prisma:828-836` — `@@index([status])`, `@@index([tenantId])` present but NO `@@unique([tenantId, orderNumber])`
  - Contrast: `schema.prisma:1208` — Invoice has `@@unique([tenantId, invoiceNumber])`
- **Impact:** Duplicate `orderNumber` values in DB. Corrupt financial records, broken invoice linkage, customer-facing display showing same number for two orders.
- **Fix:** Add `@@unique([tenantId, orderNumber])` to `Order` in schema. Handle the unique constraint violation in `createOrder()` with a retry.

---

### W10-002 — Invoice number generation: standalone `createInvoice` path not in transaction → 500 under concurrency (P2)
- **Severity:** P2
- **File:** `apps/api/src/invoices/invoices.service.ts:350`
- **Issue:** `generateInvoiceNumber()` can be called with or without a transaction client. The standalone `createInvoice` path calls it with no argument (`db = this.prisma`) — the read runs outside any transaction. Two concurrent standalone invoice creates will race; the unique constraint at `@@unique([tenantId, invoiceNumber])` will catch the duplicate but surface as a Prisma unique constraint error → unhandled 500.
- **Evidence:** `invoices.service.ts:350` — called without `txClient`. Compare safe call at line 249 (inside transaction).
- **Impact:** Concurrent invoice creation from the web UI throws 500 instead of succeeding. The safe path (`createInvoiceFromOrder` with txClient) is unaffected.
- **Fix:** Wrap the standalone `createInvoice` in a `tenantTransaction` and pass the tx client to `generateInvoiceNumber()`. Add retry-on-conflict logic in the number generation.

---

### W10-003 — Credit note balance check TOCTOU: two concurrent CNs can exceed invoice total (P2)
- **Severity:** P2
- **File:** `apps/api/src/credit-notes/credit-notes.service.ts:37–84`
- **Issue:** `create()` runs the balance check (lines 52–55: `aggregate creditsAlreadyIssued`) and the `creditNote.create` (lines 65–75) outside any transaction. Two concurrent `POST /credit-notes` calls for the same invoice will both read `creditsAlreadyIssued = $0`, both pass the balance check, and both be created — potentially generating credit notes totaling more than the invoice amount. A separate race on `creditNoteNumber` is caught by `@@unique([tenantId, creditNoteNumber])` but surfaces as a 500.
- **Evidence:** `credit-notes.service.ts:37–84` — no `prisma.tenantTransaction` wrapping.
- **Impact:** Over-issuance of credit notes → incorrect AR balances.
- **Fix:** Wrap `create()` in `prisma.tenantTransaction`. Re-read the aggregate inside the transaction before creating.

---

### W10-004 — `routes.service.ts::completeStop()` reads stop status pre-transaction → TOCTOU duplicate completion (P2)
- **Severity:** P2
- **File:** `apps/api/src/routes/routes.service.ts:975–1034`
- **Issue:** The stop status check (`if (stop.status === 'COMPLETED') throw ConflictException`) runs at line 980, OUTSIDE the transaction that starts at line 987. Two concurrent operator requests will both pass the pre-transaction check, both enter the transaction, and both successfully complete the stop. The `deliveryMutation.create` loop can then create duplicate mutations for each order item.
- **Evidence:** `routes.service.ts:975-980` — pre-transaction read. `orders.service.ts:1068-1073` — by contrast, driver path re-reads stop inside `tx`.
- **Fix:** Move the stop lookup inside the `tenantTransaction` callback, re-reading with the transaction client.

---

### W10-005 — `voidInvoice()` reads then writes without transaction — can void partially-paid invoice (P2)
- **Severity:** P2
- **File:** `apps/api/src/invoices/invoices.service.ts:795–806`
- **Issue:** `voidInvoice()` calls `findOneOrThrow(id)` (plain Prisma, no transaction) then calls `invoice.update(...)`. Between these two calls, a concurrent `recordPayment()` can transition the invoice from `SENT` → `PARTIAL`. The void proceeds on the stale `SENT` status check, voiding a partially-paid invoice and orphaning the payment record.
- **Evidence:** `invoices.service.ts:795–806` — no `tenantTransaction`. Compare `recordPayment()` at line 1019 which wraps in `tenantTransaction`.
- **Fix:** Wrap `voidInvoice()` in `tenantTransaction` and re-read the invoice inside the transaction before status check.

---

## Summary Table

| ID | Severity | Title |
|----|----------|-------|
| W10-001 | P1 | Order number: MAX+1 race with no unique constraint — silent duplicates |
| W10-002 | P2 | Invoice number: standalone path outside transaction → 500 under concurrency |
| W10-003 | P2 | Credit note balance check TOCTOU → over-issuance possible |
| W10-004 | P2 | completeStop (routes path) reads status pre-transaction → duplicate completion |
| W10-005 | P2 | voidInvoice TOCTOU — can void partially-paid invoice |
