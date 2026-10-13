-- Sitting 3 (SA-741r2), folder 2/10: Return.refundTender, how a refund was paid out.
-- One nullable column typed with the EXISTING enum "PaymentMethod" (no CREATE TYPE, no default): metadata-only.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes it yet):
--   ALTER TABLE "Return" DROP COLUMN "refundTender";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Return" ADD COLUMN     "refundTender" "PaymentMethod";

COMMIT;
