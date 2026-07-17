-- R2 (preserve scan order): additive-only. OrderItem gains an OPTIONAL 0-based
-- ordinal capturing the order items were scanned/added, so line read-back matches
-- the (already scan-ordered) invoice. No money math, no backfill — legacy rows keep
-- a null position and sort LAST (Postgres NULLS LAST for ASC). Idempotent.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "position" INTEGER;
