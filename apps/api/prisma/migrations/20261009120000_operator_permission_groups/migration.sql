-- Per-operator feature groups: the "OperatorPermissionGroup" enum plus two additive columns on "User".
--   "deniedPermissionGroups": the groups switched OFF for a user. The empty array means every group, so
--     every existing row keeps its current access and no backfill is needed.
--   "permissionsVersion": a counter bumped on every write to the array (compare-and-set token).
-- Nothing reads either column yet; the app code that ships with this migration only reports them.
--
-- LOCK PROFILE: CREATE TYPE takes no table lock. Both columns are NOT NULL with a CONSTANT default, which
-- is metadata-only on PG >= 11 (the default is stored in pg_attribute and applied lazily on read): no table
-- rewrite and no scan. ACCESS EXCLUSIVE on "User" is held only for the catalog change; lock_timeout below
-- bounds the wait behind a long writer.
--
-- Rollback (instant, nothing depends on it yet):
--   ALTER TABLE "User" DROP COLUMN "deniedPermissionGroups", DROP COLUMN "permissionsVersion";
--   DROP TYPE "OperatorPermissionGroup";
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261009120000_operator_permission_groups
-- from apps/api, then re-run. NEVER `--applied`.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "OperatorPermissionGroup" AS ENUM ('ORDERS', 'DISPATCH', 'CUSTOMERS', 'CATALOG', 'PRICING', 'REGULATED', 'FINANCE', 'NOTIFICATIONS', 'REPORTS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deniedPermissionGroups" "OperatorPermissionGroup"[] NOT NULL DEFAULT '{}',
ADD COLUMN     "permissionsVersion" INTEGER NOT NULL DEFAULT 0;

COMMIT;
