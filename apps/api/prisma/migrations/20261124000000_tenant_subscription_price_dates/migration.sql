-- SA-1261 rule 9 (P-40): three nullable price-protection dates on "TenantSubscription", migration only.
--   "priceProtectedUntil"  TIMESTAMP(3) NULL   end of a tenant's price protection
--   "priceNoticeAt"        TIMESTAMP(3) NULL   when the price-change notice was sent
--   "foundingLockUntil"    TIMESTAMP(3) NULL   end of the founding price lock
-- No default, no backfill. Nothing reads or writes these columns yet.
-- LOCK PROFILE: ONE transaction; a brief ACCESS EXCLUSIVE on "TenantSubscription" for a metadata-only ADD COLUMN (no rewrite, no scan).
-- `SET LOCAL lock_timeout = '5s'` bounds the wait; a timeout rolls the file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261124000000_tenant_subscription_price_dates` from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): the generated client selects these columns on every read, so merge only after the owner sitting:
-- fresh backup, `prod-migrate.mjs`, `schema-drift.mjs` exit 0, THEN merge.
-- Rollback: ALTER TABLE "TenantSubscription" DROP COLUMN "priceProtectedUntil", DROP COLUMN "priceNoticeAt", DROP COLUMN "foundingLockUntil";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "TenantSubscription" ADD COLUMN     "foundingLockUntil" TIMESTAMP(3),
ADD COLUMN     "priceNoticeAt" TIMESTAMP(3),
ADD COLUMN     "priceProtectedUntil" TIMESTAMP(3);

COMMIT;
