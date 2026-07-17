-- RF-3 (regulated subcategory reporting breakdown): additive-only. RegulatedSalesLedger
-- gains an OPTIONAL classification pointer to a TrackedSubcategory, for the reporting /
-- filing breakdown only. No money math changes, no backfill, no existing-row edits — a
-- null is the pre-RF-3 (section-only) case. Idempotent so a partial re-run is safe.

-- AlterTable
ALTER TABLE "RegulatedSalesLedger" ADD COLUMN IF NOT EXISTS "trackedSubcategoryId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RegulatedSalesLedger_trackedSubcategoryId_idx" ON "RegulatedSalesLedger"("trackedSubcategoryId");

-- AddForeignKey (Postgres has no ADD CONSTRAINT IF NOT EXISTS — name-guard it so a
-- re-run is a no-op). SetNull mirrors Product/OrderItem/InvoiceItem: a subcategory
-- delete must never block the append-only ledger, only drop the finer breakdown.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RegulatedSalesLedger_trackedSubcategoryId_fkey'
  ) THEN
    ALTER TABLE "RegulatedSalesLedger"
      ADD CONSTRAINT "RegulatedSalesLedger_trackedSubcategoryId_fkey"
      FOREIGN KEY ("trackedSubcategoryId") REFERENCES "TrackedSubcategory"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
