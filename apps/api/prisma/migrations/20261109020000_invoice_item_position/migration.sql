-- W-1187 (SA ruling, D1): the slot of an invoice line, so an invoice lists its lines in the order the staff built the order.
--   InvoiceItem.position  INTEGER NULL
--   CHECK "InvoiceItem_position_nonneg_chk": position IS NULL OR position >= 0
-- NO default and NO backfill (owner Q2, "Leave them"): every existing line keeps NULL, and an invoice with any NULL
-- position keeps rendering A-Z through the SA-1058 comparator, exactly as it printed. A default of 0 would tie every
-- legacy line and silently lose that order. The column is DISPLAY ONLY: no total, tax, payment, credit, ledger or send
-- fingerprint reads it.
-- The CHECK is raw SQL (Prisma does not model it), so the schema and the drift gate see only the column (the T6
-- precedent, 20260920220000_t6_tenantid_check_not_valid; shape: 20261026090000_stock_count_seed_state).
--
-- Additive only: one nullable column (metadata-only ADD COLUMN, no rewrite, no default) and one CHECK added NOT VALID
-- (no table scan; every existing row is NULL, which satisfies it, and Postgres enforces it on every later INSERT and
-- UPDATE). No index: lines are read per invoice through "InvoiceItem_invoiceId_idx" and ordered in memory.
-- LOCK PROFILE: ONE transaction, ONE ALTER TABLE; a brief ACCESS EXCLUSIVE lock (metadata only) held until COMMIT.
-- `SET LOCAL lock_timeout = '5s'` bounds the wait; a timeout rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261109020000_invoice_item_position` from apps/api, then re-run; NEVER
-- `--applied`).
-- DEPLOY ORDER (L-184): apply to prod (owner sitting, fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and
-- ONLY THEN merge the code that writes the column (W-1187 PR-1c). This PR carries no code that reads or writes it.
--
-- Rollback (instant; nothing else references the column):
--   ALTER TABLE "InvoiceItem" DROP CONSTRAINT "InvoiceItem_position_nonneg_chk", DROP COLUMN "position";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN "position" INTEGER,
ADD CONSTRAINT "InvoiceItem_position_nonneg_chk"
  CHECK ("position" IS NULL OR "position" >= 0) NOT VALID;

COMMIT;
