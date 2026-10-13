-- PR #3418 MUST 5: "Order"."sourceRecorded" BOOLEAN NOT NULL DEFAULT false. It replaces the clock cutoff of the F1(i)
-- author rule: true = "Order"."source" was written from the creating principal (every create site of the new code
-- writes it); false = UNKNOWN_LEGACY (a row that predates this column carries the default source APP whoever made it),
-- judged on the STAFF channel. Every existing row reads false, which is exactly the intent: NO backfill.
--
-- LOCK PROFILE: a constant DEFAULT on Postgres 11+ is a catalog-only change (the default is stored in pg_attribute and
-- read for old rows): no table rewrite, no scan. The ALTER TABLE still takes ACCESS EXCLUSIVE on "Order" for that
-- moment, held until COMMIT. `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a
-- statement that waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261013000000_order_source_recorded` from apps/api, then re-run; NEVER
-- `--applied`). Run off-peak anyway ("Order" is the hottest table).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge the code that reads and writes this column.
--
-- Rollback: none needed for a code rollback (old code never reads the column; rows it creates get false = legacy
-- STAFF). To remove the column itself: ALTER TABLE "Order" DROP COLUMN "sourceRecorded";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "sourceRecorded" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
