-- BUY_N_GET_M promotion type ("buy 5, get the 6th free"). Additive only: one enum
-- value + one nullable column, no backfill.
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in
-- Postgres, so this file is intentionally NOT wrapped in BEGIN/COMMIT and the
-- enum addition is its own statement, run first.

-- AlterEnum
ALTER TYPE "PromotionType" ADD VALUE 'BUY_N_GET_M';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "promoFreeUnits" INTEGER;
