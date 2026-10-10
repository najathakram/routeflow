-- #2118 (plan A4): read-path indexes for the sales-facts layer (apps/api/src/sales-facts/).
-- Additive only: four plain B-tree indexes, no column, constraint or data change.
--
-- 1. "CreditNoteItem"("invoiceItemId") — per-line credited amounts on the product sales page
--    (a credit note's items looked up by the page's invoice line ids).
-- 2. "CreditNote"("tenantId", "createdAt") — the accrual credit-note term is keyed on
--    "createdAt" (B440); every tenant-window read of it was a heap scan.
-- 3. "Return"("tenantId", "refundedAt") — the external-refund term is keyed on "refundedAt".
-- 4. "Invoice"("customerId", "issueDate") — buyer-filtered line pages here and the customer
--    insights reads (#2106-a) window one customer's invoices on the analytics date.
--
-- No "InvoiceItem"("tenantId", "productId"): legacy nested-write lines can carry a NULL
-- "tenantId", so an index led by it answers the wrong question (plan A4).
--
-- Locking: Prisma runs this file in ONE transaction, so CONCURRENTLY is unavailable; each
-- CREATE INDEX holds a SHARE lock (writes to that table wait, reads do not) for the build.
-- "Invoice" is the only large table here and builds in seconds at production size. The
-- lock_timeout makes the migration fail fast (and roll back whole) rather than queue behind a
-- long writer. Indexes change no query result, so the app is correct whether this is applied
-- before or after the deploy; the PR is not LANDED until the owner has applied it through
-- apps/api/scripts/prod-migrate.mjs and the drift gate exits 0 (L-184).
--
-- Rollback (instant):
--   DROP INDEX "CreditNoteItem_invoiceItemId_idx";
--   DROP INDEX "CreditNote_tenantId_createdAt_idx";
--   DROP INDEX "Return_tenantId_refundedAt_idx";
--   DROP INDEX "Invoice_customerId_issueDate_idx";

SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "CreditNoteItem_invoiceItemId_idx" ON "CreditNoteItem"("invoiceItemId");

-- CreateIndex
CREATE INDEX "CreditNote_tenantId_createdAt_idx" ON "CreditNote"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Return_tenantId_refundedAt_idx" ON "Return"("tenantId", "refundedAt");

-- CreateIndex
CREATE INDEX "Invoice_customerId_issueDate_idx" ON "Invoice"("customerId", "issueDate");
