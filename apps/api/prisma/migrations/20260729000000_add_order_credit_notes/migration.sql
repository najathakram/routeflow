-- Order↔credit-note INTENT table (additive-only). Captures "apply credit X (up to
-- $amount, or its remaining balance when amount is null) to order Y". Money still
-- moves ONLY via InvoicePayment rows with method CREDIT_NOTE; this table lets the
-- settle pass re-apply operator selections idempotently across invoice rebuilds,
-- split invoices, and the partial-billing resync skip. Idempotent DDL.

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderCreditNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "orderId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "amount" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderCreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OrderCreditNote_orderId_creditNoteId_key" ON "OrderCreditNote"("orderId", "creditNoteId");
CREATE INDEX IF NOT EXISTS "OrderCreditNote_creditNoteId_idx" ON "OrderCreditNote"("creditNoteId");
CREATE INDEX IF NOT EXISTS "OrderCreditNote_tenantId_idx" ON "OrderCreditNote"("tenantId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderCreditNote_orderId_fkey') THEN
    ALTER TABLE "OrderCreditNote" ADD CONSTRAINT "OrderCreditNote_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderCreditNote_creditNoteId_fkey') THEN
    ALTER TABLE "OrderCreditNote" ADD CONSTRAINT "OrderCreditNote_creditNoteId_fkey"
      FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderCreditNote_tenantId_fkey') THEN
    ALTER TABLE "OrderCreditNote" ADD CONSTRAINT "OrderCreditNote_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
