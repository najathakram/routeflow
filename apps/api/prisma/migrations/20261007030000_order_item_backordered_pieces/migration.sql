-- SA-714 R1 (out-of-stock PR3, owner-approved): "OrderItem"."backorderedPieces" — the PIECES of a line
-- that were sold past available stock (currentStock's unit, B703). It drives a staff-only "Backorder"
-- tag on order-detail lines and the packing slip. Its OWN migration, nothing else rides on it.
-- Informational ONLY: no money, invoice, stock or status reader consumes it, and no restock job
-- rewrites it. NO backfill: every existing row reads 0, meaning "not backordered OR unknown".
--
-- LOCK PROFILE: a constant NOT NULL DEFAULT is metadata-only on PG >= 11 (the default is stored in
-- pg_attribute and applied lazily on read), so no table rewrite and no scan of "OrderItem". ACCESS
-- EXCLUSIVE is held only for the catalog change; lock_timeout below bounds the wait behind a long
-- writer, so a long transaction on "OrderItem" makes the migration fail fast instead of queueing
-- behind it and blocking every order read.
--
-- HARD DEPLOY ORDER (L-184): Prisma selects every scalar, so code that knows this column merged BEFORE it
-- exists breaks EVERY OrderItem read (P2022). Owner sitting -> `prod-migrate.mjs` (fresh backup first) ->
-- `schema-drift.mjs` exit 0 -> ONLY THEN merge the PR that ships the code.
--
-- Rollback (instant): ALTER TABLE "OrderItem" DROP COLUMN "backorderedPieces";
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261007030000_order_item_backordered_pieces
-- from apps/api, then re-run. NEVER `--applied`.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "backorderedPieces" DECIMAL(10,3) NOT NULL DEFAULT 0;

COMMIT;
