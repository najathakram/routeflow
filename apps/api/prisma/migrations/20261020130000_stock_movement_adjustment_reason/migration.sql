-- SA-804(3) / SA-828 row 657: adjustment reasons. DRAFTED for migration sitting #2 — NOT applied anywhere yet.
--   enum   AdjustmentReason { DAMAGED EXPIRED THEFT SAMPLE COUNT_CORRECTION OTHER }
--   StockMovement.reason      "AdjustmentReason" NULL  (NULL = history and every non-ADJUSTMENT row)
--   StockMovement.reasonNote  TEXT NULL                (required by the API when reason = OTHER, 3-200 chars)
-- Additive only: two nullable columns (metadata-only ADD COLUMN, no rewrite, no backfill) and one new type.
-- Write-off is DERIVED from (type, sign, reason) — there is deliberately no write-off column.

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('DAMAGED', 'EXPIRED', 'THEFT', 'SAMPLE', 'COUNT_CORRECTION', 'OTHER');

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN "reason" "AdjustmentReason",
ADD COLUMN "reasonNote" TEXT;
