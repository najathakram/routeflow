-- Row 354 (SA-767 count follow-up), fix B: an index for the stock-count idempotency read, which looks a count
-- session's movements up by `reference` (STOCK_COUNT-<sessionId>) and had no index on it (a scan of the tenant's
-- whole ledger under the product locks). Additive only: ONE plain B-tree index, no column, constraint or data change.
--
--   CREATE INDEX "StockMovement_tenantId_reference_idx" ON "StockMovement"("tenantId", "reference");
--
-- The tenant column leads because every reader is tenant-scoped (the isolation extension adds `tenantId = ?`). The
-- existing "StockMovement_tenantId_idx" becomes a left prefix of this one; dropping it is a separate LATER change
-- (never in this one) and only if the write cost shows.
--
-- Locking: Prisma runs this file in ONE transaction, so CONCURRENTLY is unavailable; the CREATE INDEX holds a SHARE
-- lock (writes to "StockMovement" wait, reads do not) for the build. "StockMovement" is the ledger's hottest table,
-- so `lock_timeout` makes the migration fail fast (and roll back whole) rather than queue behind a long writer. The
-- build time at production size is measured and quoted in the PR; the OWNER applies it in a low-traffic window.
-- An index changes no query result, so the app is correct whether this is applied before or after the deploy; the
-- PR is not LANDED until the owner has applied it through apps/api/scripts/prod-migrate.mjs and the drift gate
-- exits 0 (L-184). NO prod apply from this PR: it waits for the next migration sitting.
--
-- Rollback (instant):
--   DROP INDEX "StockMovement_tenantId_reference_idx";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateIndex
-- reason: Prisma runs the file in one transaction, so CONCURRENTLY is unavailable; additive and instant to roll back, applied by the owner in a low-traffic window under lock_timeout 5s
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "StockMovement_tenantId_reference_idx" ON "StockMovement"("tenantId", "reference");

COMMIT;
