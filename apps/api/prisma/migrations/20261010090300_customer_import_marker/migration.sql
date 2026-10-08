-- Sitting 3 (SA-741r2), folder 4/10: Customer import marker (which import batch created a row, and when).
-- Two nullable columns, no default, no backfill, plus a btree index on ("tenantId", "importBatchId").
-- The index is built on a table that already has rows (the new column is all-NULL, the build is still a scan and
-- blocks writes to "Customer" while it runs): run off-peak; the PR body carries the prod row count.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes them yet):
--   DROP INDEX "Customer_tenantId_importBatchId_idx";
--   ALTER TABLE "Customer" DROP COLUMN "importBatchId", DROP COLUMN "importedAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "importedAt" TIMESTAMP(3);

-- CreateIndex
-- reason: "importBatchId" is a new all-NULL column; the build is a short scan of "Customer" (tenant-scoped rows, modest count), run off-peak
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "Customer_tenantId_importBatchId_idx" ON "Customer"("tenantId", "importBatchId");

COMMIT;
