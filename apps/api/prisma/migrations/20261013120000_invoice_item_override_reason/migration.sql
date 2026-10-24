-- H3b (SA ruling, schema part): carry the staff price-override reason and author from the order
-- line onto the invoice line. Mirrors "OrderItem"."overrideReason" / "overriddenBy" (both TEXT,
-- nullable). The order-to-invoice copiers copy both columns verbatim; they are STAFF-ONLY reads
-- (never on the buyer portal or the customer PDF).
-- Two nullable columns with no default: metadata-only in Postgres (no table rewrite, no scan).
-- No backfill: every existing invoice line reads NULL.
-- Sorts after 20261013000000_order_source_recorded (#3418); the two folders are independent.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies inside the one transaction: if the ALTER waits
-- longer than 5s for its ACCESS EXCLUSIVE lock it fails and rolls the file back (recorded FAILED;
-- recover with `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns.
--
-- Rollback (instant while nullable and unindexed):
--   ALTER TABLE "InvoiceItem" DROP COLUMN "overrideReason", DROP COLUMN "overriddenBy";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN "overrideReason" TEXT, ADD COLUMN "overriddenBy" TEXT;

COMMIT;
