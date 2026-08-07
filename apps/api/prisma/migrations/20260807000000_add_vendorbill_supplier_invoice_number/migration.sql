-- Duplicate purchase-invoice detection: give VendorBill a real home for the
-- SUPPLIER's own invoice number. Until now that number only ever existed as free
-- text inside `notes` ("Supplier invoice #1234"), which the batch importer had to
-- regex back out and the mobile scanner dropped entirely — so the main scan path
-- had no way to recognise a document it had already imported.
--
-- Deliberately NOT unique. Prod predates the column (a backfill parses `notes`,
-- and pre-existing duplicates must not make the migration or later writes fail),
-- the same number legitimately recurs across different suppliers, and a VOIDed
-- bill must never block a re-scan. Postgres could express that as a partial
-- unique index, but Prisma cannot, and turning advisory dedup into a P2002 deep
-- inside the batch-post loop would fail imports that today recover cleanly.
-- Enforcement therefore lives in VendorBillsService.create().
--
-- Additive: nullable column + one index, no data change. IF NOT EXISTS because
-- this table's DDL history is not fully represented in migrations.
ALTER TABLE "VendorBill" ADD COLUMN IF NOT EXISTS "supplierInvoiceNumber" TEXT;

CREATE INDEX IF NOT EXISTS "VendorBill_tenantId_supplierInvoiceNumber_idx"
  ON "VendorBill"("tenantId", "supplierInvoiceNumber");
