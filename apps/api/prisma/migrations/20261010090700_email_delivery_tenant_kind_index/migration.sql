-- Sitting 3 (SA-741r2), folder 8/10: btree index on "EmailDelivery" ("tenantId", "kind", "createdAt").
-- Built on existing columns of a table that has rows (the log of every email sent): the build blocks writes to
-- "EmailDelivery" while it runs (inserts queue behind it). Run off-peak; the PR body carries the prod row count.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback:
--   DROP INDEX "EmailDelivery_tenantId_kind_createdAt_idx";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateIndex
-- reason: index on populated "EmailDelivery" columns: blocks inserts for the build; the owner runs this sitting off-peak and the PR body carries the prod row count
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "EmailDelivery_tenantId_kind_createdAt_idx" ON "EmailDelivery"("tenantId", "kind", "createdAt");

COMMIT;
