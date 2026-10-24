-- Sitting 3 (SA-741r2), folder 1/10: TenantSubscription dunning, catch-up and coupon seams.
-- Adds 11 columns (9 nullable no-default, 2 BOOLEAN NOT NULL DEFAULT false: a constant default is metadata-only on
-- PG 11+, no rewrite), one btree index on "pastDueInvoiceId" and the CHECK "TenantSubscription_catchupState_chk".
-- TenantSubscription is one row per tenant (tiny); every new column is NULL/false on every existing row.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes these yet):
--   ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_catchupState_chk";
--   DROP INDEX "TenantSubscription_pastDueInvoiceId_idx";
--   ALTER TABLE "TenantSubscription" DROP COLUMN "pastDueSince", DROP COLUMN "pastDueInvoiceId", DROP COLUMN "pausedAt",
--     DROP COLUMN "catchupState", DROP COLUMN "catchupSessionId", DROP COLUMN "catchupInvoiceId",
--     DROP COLUMN "needsReconcile", DROP COLUMN "couponFull", DROP COLUMN "couponId", DROP COLUMN "couponEndsAt",
--     DROP COLUMN "couponSyncedAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "TenantSubscription" ADD COLUMN     "catchupInvoiceId" TEXT,
ADD COLUMN     "catchupSessionId" TEXT,
ADD COLUMN     "catchupState" TEXT,
ADD COLUMN     "couponEndsAt" TIMESTAMP(3),
ADD COLUMN     "couponFull" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "couponId" TEXT,
ADD COLUMN     "couponSyncedAt" TIMESTAMP(3),
ADD COLUMN     "needsReconcile" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pastDueInvoiceId" TEXT,
ADD COLUMN     "pastDueSince" TIMESTAMP(3),
ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- AddCheck
-- reason: "catchupState" is a new all-NULL column on a one-row-per-tenant table; the CHECK is satisfied by NULL, so validation finds nothing
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_catchupState_chk" CHECK ("catchupState" IS NULL OR "catchupState" IN ('SESSION_OPEN','AWAITING_FIRST_PAYMENT','RELEASING'));

-- CreateIndex
-- reason: "pastDueInvoiceId" is a new all-NULL column on a one-row-per-tenant table; the build is instant
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "TenantSubscription_pastDueInvoiceId_idx" ON "TenantSubscription"("pastDueInvoiceId");

COMMIT;
