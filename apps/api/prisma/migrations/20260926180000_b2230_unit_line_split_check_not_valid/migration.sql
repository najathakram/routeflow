-- #2230 / SA-388d (B718's over-bill shape): a line sold by a named unit whose pack factor is > 1 and
-- whose qty is > 0 must carry a readable split — boxes >= 1 OR pieces >= 1. A part-unit split
-- (0 boxes + 5 pieces, a broken Case at the door) is VALID (SA-178); an "Each" line (factor 1) stores
-- no split and is exempt; a zero-quantity line is exempt. Only the ALL-EMPTY split is refused: its
-- count cannot be read, and a reader that falls back to qty-as-boxes bills it 12x. The writers assert
-- the same predicate first (apps/api/src/orders/unit-line-split.ts); this is the database backstop.
--
-- Part 1 of 2: ADD the CHECK as NOT VALID — metadata only, no table scan; enforced for every NEW
-- insert/update from the moment it commits. Part 2 (a separate, later migration) VALIDATEs existing
-- rows, and lands ONLY after the owner-run census reads zero:
--   railway run --service postgres node apps/api/scripts/report-b2230-unit-lines-without-boxes.mjs
--
-- A CHECK, not a column change: Prisma does not model CHECK constraints, so the schema and the
-- generated client stay untouched and the drift gate stays green (same as T6, 20260920220000).
--
-- Rollback (instant, no data touched):
--   ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_unitLine_split_chk";
--   ALTER TABLE "InvoiceItem" DROP CONSTRAINT "InvoiceItem_unitLine_split_chk";
--
-- lock_timeout: each ADD CONSTRAINT takes a brief ACCESS EXCLUSIVE lock, and a waiting one blocks the
-- readers queued behind it. Both statements are metadata-only and instant; if a wait exceeds 5s the
-- transaction rolls back (nothing half-added) and the migration is recorded FAILED — recover with
-- `prisma migrate resolve --rolled-back 20260926180000_b2230_unit_line_split_check_not_valid` from
-- apps/api, then re-run. NEVER `--applied`: that would mark the guard installed when it is not.
SET lock_timeout = '5s';

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_unitLine_split_chk" CHECK ("unitLabel" IS NULL OR COALESCE("unitsPerBox", 1) <= 1 OR "qty" <= 0 OR COALESCE("boxes", 0) >= 1 OR COALESCE("pieces", 0) >= 1) NOT VALID;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_unitLine_split_chk" CHECK ("unitLabel" IS NULL OR COALESCE("unitsPerBox", 1) <= 1 OR "qty" <= 0 OR COALESCE("boxes", 0) >= 1 OR COALESCE("pieces", 0) >= 1) NOT VALID;
