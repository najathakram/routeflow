-- SA-655 (counter sales, item C step 2): "Customer"."isWalkIn" marks the ONE system customer a tenant's
-- counter sales ring walk-ins against (created lazily by the API on the first walk-in sale).
--
-- Additive and nullable with NO default: null reads as "not a walk-in" for every existing row, so there
-- is no backfill and, on PG >= 11, no table rewrite (a metadata-only change).
--
-- Also (SA-672e): "Order"."counterSale" BOOLEAN NOT NULL DEFAULT false marks the orders the counter-sale
-- POST created, so GET by-key matches on a durable marker instead of a PICKUP + skipAutoMerge shape. A
-- constant default is metadata-only on PG >= 11 (no rewrite, no backfill: existing rows read false).
--
-- LOCK PROFILE: ALTER TABLE takes a brief ACCESS EXCLUSIVE lock on "Customer" and on "Order" while the
-- catalog entries are added. The lock wait is bounded by lock_timeout below, so a long-running transaction
-- on either table makes the migration fail fast instead of queueing behind it and blocking every read.
--
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261004160000_customer_is_walk_in
-- from apps/api, then re-run. NEVER `--applied`.
--
-- Ordering: sorts after the PICKUP migration 20261004150000_fulfil_path_pickup (which sorts after the
-- shipped-emails migrations 20261003120000 / 20261003120100).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "isWalkIn" BOOLEAN;
ALTER TABLE "Order" ADD COLUMN "counterSale" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
