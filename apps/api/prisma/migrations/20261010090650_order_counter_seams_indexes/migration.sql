-- Sitting 3 (SA-741r2, owner ruling: always split), folder 7b: the two btree indexes on "Order" for the counter seams:
--   - "Order" ("tenantId", "counterSale", "createdAt")
--   - "Order" ("soldById")  (the foreign key column added in folder 7: without it every hard delete of a "User" would
--     scan "Order" for the ON DELETE SET NULL action)
-- Kept apart from the ALTER TABLE folder on purpose: a plain CREATE INDEX takes only a SHARE lock, so READS of "Order"
-- continue while WRITES wait for each build. Built on a populated table, so the build time scales with the "Order" row count
-- in the PR body: run off-peak, AFTER 20261010090600_counter_seams.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback:
--   DROP INDEX "Order_soldById_idx";
--   DROP INDEX "Order_tenantId_counterSale_createdAt_idx";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateIndex
-- reason: index on populated "Order" (counterSale, createdAt are existing columns): SHARE lock only, reads continue and writes wait for the build; the owner runs this sitting off-peak and the PR body carries the prod row count
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "Order_tenantId_counterSale_createdAt_idx" ON "Order"("tenantId", "counterSale", "createdAt");

-- CreateIndex
-- reason: index on "Order"."soldById", an all-NULL column until the counter code ships; SHARE lock only, reads continue and writes wait for the build
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "Order_soldById_idx" ON "Order"("soldById");

COMMIT;
