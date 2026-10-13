-- Index for the counter-sale "today" money-in query (GET /orders/counter-sale/today), which filters
-- InvoicePayment by tenant and paidAt window. Mirrors "InvoicePayment_tenantId_settledAt_idx".
--
-- Plain CREATE INDEX (not CONCURRENTLY): Prisma runs a migration in a transaction and CONCURRENTLY cannot run
-- inside one. The build takes a SHARE lock, so writes to "InvoicePayment" wait for its duration; the table is
-- small enough in production for that to be a non-event. Apply in the owner migration sitting.
CREATE INDEX "InvoicePayment_tenantId_paidAt_idx" ON "InvoicePayment"("tenantId", "paidAt");
