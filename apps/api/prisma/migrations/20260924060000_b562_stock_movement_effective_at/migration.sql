-- B562 PR-1 (SA-136 §3, 2026-09-24): "StockMovement"."effectiveAt" is the accounting date of a movement;
-- "createdAt" becomes write-once insertion time.
--
-- 1. ADD COLUMN "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP. CURRENT_TIMESTAMP is stable, so
--    Postgres 11+ stores it as a fast default (metadata only, no table rewrite) and every existing row briefly
--    reads the migration's own timestamp.
-- 2. Backfill "effectiveAt" = "createdAt" for every existing row, in the same transaction. Until this PR's code
--    ships, every writer that supported a past effective date (recordPurchase, recordAdjustment, stock-count
--    commit, vendor-bill receive) wrote that date INTO "createdAt", so "createdAt" IS each existing row's
--    accounting date and the backfill makes every existing row read exactly as it does today. One UPDATE of
--    the whole table: it takes row locks on StockMovement (stock writers wait for it, nothing else does).
-- 3. A plain index on "effectiveAt", mirroring the existing "StockMovement_createdAt_idx" (the date-range
--    readers move to the new column). Prisma runs this file in ONE transaction, so CONCURRENTLY is not
--    available; the SHARE lock blocks StockMovement writes for the build. Run it in a quiet minute.
--
-- ORDERING: apply to prod BEFORE the PR that adds "effectiveAt" to the Prisma schema merges (L-184). The API
-- image runs `prisma generate` at build time, so merging redeploys a client that selects this column on every
-- StockMovement read: it 500s until the column exists. The reverse order is safe: old code names its columns
-- explicitly and ignores the new one.
--
-- WINDOW CATCH-UP (owner, once, after the PR-1 deploy reaches SUCCESS): between applying this file and the
-- deploy, OLD code still writes a backdated movement's date into "createdAt" and leaves "effectiveAt" at its
-- DEFAULT (the insert time). This statement restores those rows: exactly the rows inserted in the window whose
-- "createdAt" is earlier than their "effectiveAt". New code never writes such a row (its "createdAt" is the
-- insert time, after the deploy, and its "effectiveAt" is the effective date). <applied> is this migration's
-- "finished_at" in "_prisma_migrations"; <deployed> is the deploy's SUCCESS time.
--   UPDATE "StockMovement" SET "effectiveAt" = "createdAt"
--    WHERE "effectiveAt" BETWEEN '<applied>' AND '<deployed>' AND "createdAt" < "effectiveAt";
--
-- Rollback (instant; the index goes with the column):
--   ALTER TABLE "StockMovement" DROP COLUMN "effectiveAt";

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: every existing row's accounting date is its "createdAt"
UPDATE "StockMovement" SET "effectiveAt" = "createdAt";

-- CreateIndex
CREATE INDEX "StockMovement_effectiveAt_idx" ON "StockMovement"("effectiveAt");
