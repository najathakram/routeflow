-- SA-650 (counter sales, item C step 1): "FulfillPath" += PICKUP (counter sale / in-store pickup).
-- ONE value, in its OWN migration, so nothing else rides on it. Nothing WRITES PICKUP yet: the four
-- write DTOs keep refusing it until the counter-sale API lands; list filters accept it.
--
-- ADD VALUE inside the BEGIN/COMMIT wrap is legal on PG >= 12; a value added in a transaction cannot be
-- USED in that transaction, and nothing here uses it (only app code, after the commit).
--
-- LOCK PROFILE: a lock on the enum type only, no table is touched or rewritten. The lock wait is bounded
-- by lock_timeout below.
--
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261004150000_fulfil_path_pickup
-- from apps/api, then re-run. NEVER `--applied`.
--
-- Ordering: sorts after the PC branch migrations 20261003120000 / 20261003120100 (feat/shipped-emails).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "FulfillPath" ADD VALUE 'PICKUP';

COMMIT;
