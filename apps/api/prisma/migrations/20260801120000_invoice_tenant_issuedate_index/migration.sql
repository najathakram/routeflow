-- issueDate is the date every revenue/analytics surface filters on (revenue trend,
-- gross margin, AOV, bookkeeping sales-by-item, tobacco monthly, and the new
-- per-product demand series) but it carried no index — those queries all fell back to
-- a heap scan filtered by tenantId. Mirrors the existing RfInvoice(tenantId, issuedAt).
--
-- Additive and reversible: creates an index only, no column or data changes.
-- Deliberately NOT CONCURRENTLY — Prisma runs migrations inside a transaction, which
-- forbids it, and at current row counts the lock is imperceptible.
CREATE INDEX IF NOT EXISTS "Invoice_tenantId_issueDate_idx" ON "Invoice"("tenantId", "issueDate");
