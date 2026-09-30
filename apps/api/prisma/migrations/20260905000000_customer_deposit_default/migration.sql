-- Per-customer default deposit percent ("50% upfront + remainder on terms").
-- Additive only — one nullable column, no backfill.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "defaultDepositPercent" DECIMAL(5,2);
