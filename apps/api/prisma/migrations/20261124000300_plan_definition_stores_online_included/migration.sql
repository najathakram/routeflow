-- SA-1269 (P-40b): one nullable INTEGER on "PlanDefinition", migration only.
--   "storesOnlineIncluded"  INTEGER NULL   online stores included in the plan (null = no cap)
-- No default, no backfill. Nothing reads or writes this column yet.
-- LOCK PROFILE: ONE transaction; a brief ACCESS EXCLUSIVE on "PlanDefinition" for a metadata-only ADD COLUMN (no rewrite, no scan).
-- `SET LOCAL lock_timeout = '5s'` bounds the wait; a timeout rolls the file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261124000300_plan_definition_stores_online_included` from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): the generated client selects this column on every read, so merge only after the owner sitting:
-- fresh backup, `prod-migrate.mjs`, `schema-drift.mjs` exit 0, THEN merge.
-- Rollback: ALTER TABLE "PlanDefinition" DROP COLUMN "storesOnlineIncluded";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "PlanDefinition" ADD COLUMN     "storesOnlineIncluded" INTEGER;

COMMIT;
