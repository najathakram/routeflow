-- Sitting 3 (SA-741r2), folder 3/10: Order.idempotencyCartHash, a fingerprint of the cart behind an idempotency key.
-- One nullable TEXT column, no default, no index: metadata-only. ADD COLUMN on "Order" takes ACCESS EXCLUSIVE until
-- COMMIT, so run off-peak (see folder 7's note on a large Order table).
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes it yet):
--   ALTER TABLE "Order" DROP COLUMN "idempotencyCartHash";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "idempotencyCartHash" TEXT;

COMMIT;
