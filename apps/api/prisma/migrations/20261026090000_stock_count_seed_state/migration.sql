-- SA-999 (row 562 S1): the seed-state of a stock count, so a commit can refuse a count whose seed has not finished.
--   StockCountSession.seedPlannedLines  INTEGER NULL      (lines the batched seed will write; NULL = nothing seeded)
--   StockCountSession.seedCompletedAt   TIMESTAMP(3) NULL (stamped by the final seed batch, in its own transaction)
--   CHECK "StockCountSession_seed_completed_needs_planned_chk": seedCompletedAt IS NULL OR seedPlannedLines IS NOT NULL
--   CHECK "StockCountSession_seed_planned_nonneg_chk":          seedPlannedLines IS NULL OR seedPlannedLines >= 0
-- NO backfill: every existing row keeps both NULL ("legacy": committable as before). planned set + completedAt NULL is
-- "seeding" (the commit answers 409 STOCK_COUNT_SEEDING); completedAt set is "complete".
-- The CHECKs are raw SQL (Prisma does not model them), so the schema and the drift gate are unaffected (the T6
-- precedent, 20260920220000_t6_tenantid_check_not_valid).
--
-- Additive only: two nullable columns (metadata-only ADD COLUMN, no rewrite, no default) and two CHECKs added NOT
-- VALID (no table scan; every existing row has both columns NULL, which satisfies both CHECKs, and Postgres enforces
-- them on every later INSERT and UPDATE).
-- LOCK PROFILE: ONE transaction, ONE ALTER TABLE; a brief ACCESS EXCLUSIVE lock (metadata only) held until COMMIT.
-- `SET LOCAL lock_timeout = '5s'` bounds the wait; a timeout rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261026090000_stock_count_seed_state` from apps/api, then re-run; NEVER
-- `--applied`).
-- DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and ONLY THEN merge
-- the code that reads or writes these columns (PR #3834).
--
-- Rollback (instant; nothing else references the columns):
--   ALTER TABLE "StockCountSession" DROP CONSTRAINT "StockCountSession_seed_completed_needs_planned_chk",
--     DROP CONSTRAINT "StockCountSession_seed_planned_nonneg_chk", DROP COLUMN "seedCompletedAt", DROP COLUMN "seedPlannedLines";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "StockCountSession" ADD COLUMN "seedPlannedLines" INTEGER,
ADD COLUMN "seedCompletedAt" TIMESTAMP(3),
ADD CONSTRAINT "StockCountSession_seed_completed_needs_planned_chk"
  CHECK ("seedCompletedAt" IS NULL OR "seedPlannedLines" IS NOT NULL) NOT VALID,
ADD CONSTRAINT "StockCountSession_seed_planned_nonneg_chk"
  CHECK ("seedPlannedLines" IS NULL OR "seedPlannedLines" >= 0) NOT VALID;

COMMIT;
