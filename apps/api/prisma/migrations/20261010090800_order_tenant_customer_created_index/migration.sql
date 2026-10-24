-- Sitting 3 (SA-741r2), folder 9/10: btree index on "Order" ("tenantId", "customerId", "createdAt").
-- CONDITIONAL (G5a gate): keep only if the prod EXPLAIN (ANALYZE, BUFFERS) of the customer-orders query shows Order_customerId_idx + Sort/Filter over N rows; if dropped, remove this folder AND @@index([tenantId, customerId, createdAt]) from sales.prisma.
-- Built on existing columns of a populated table: blocks writes to "Order" for the build. RUN OFF-PEAK.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback:
--   DROP INDEX "Order_tenantId_customerId_createdAt_idx";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateIndex
-- reason: index on populated "Order" columns: blocks writes to "Order" for the build; the owner runs this sitting off-peak and decides from the prod row count in the PR body
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "Order_tenantId_customerId_createdAt_idx" ON "Order"("tenantId", "customerId", "createdAt");

COMMIT;
