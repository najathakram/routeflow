-- SA-772 folder 1 / SA-761 T-1 (row 316), sitting 4: the sales-tax rate snapshot on orders and order lines.
--   CREATE TYPE "TaxRateSource" ('TENANT_DEFAULT','CUSTOMER_EXEMPT','LEGACY_INFERRED'). LEGACY_INFERRED is the SEAM NOW:
--   the B294 census/backfill labels a pre-snapshot order whose rate was inferred from its totals, with no later enum change.
--   "Order"     "taxRate" DECIMAL(9,6) NULL, "taxRateSource" "TaxRateSource" NULL
--   "OrderItem" "taxRate" DECIMAL(9,6) NULL
--   The stored unit is the FRACTION (0.08875), like "InvoiceItem"."taxRate"; 6 dp = a percent to 4 dp (SA-814 §3).
--   CHECKs "Order_taxRate_range_chk" / "OrderItem_taxRate_range_chk": "taxRate" IS NULL OR 0 <= "taxRate" <= 1.
-- Renamed from SA-772's 20261015090000 to sort after master's 20261016120000_units_prices_v2_schema (SA-814 §4).
--
-- METADATA-ONLY: the type is new, every column is nullable with no default (catalog-only ADD COLUMN, no rewrite, no
-- scan). The two CHECKs are NOT VALID, so adding them scans nothing either; Postgres still enforces them on every
-- INSERT and UPDATE from the moment this commits. Every existing row is NULL, so a later VALIDATE (SHARE UPDATE
-- EXCLUSIVE, writes continue) is a formality and is NOT part of this folder. CHECKs are raw SQL (Prisma does not
-- model them), so the schema and the drift gate are unaffected by them.
--
-- LOCK PROFILE: ONE transaction. ACCESS EXCLUSIVE on "Order" and "OrderItem" from their ALTER to COMMIT, held only for
-- the catalog updates. `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT: a statement that waits longer than 5s for
-- its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261020090100_sales_tax_snapshot` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (SA-761 T-2 / T-3).
--
-- Rollback (instant; nothing reads or writes these until SA-761 T-2):
--   ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_taxRate_range_chk";
--   ALTER TABLE "Order" DROP CONSTRAINT "Order_taxRate_range_chk";
--   ALTER TABLE "OrderItem" DROP COLUMN "taxRate";
--   ALTER TABLE "Order" DROP COLUMN "taxRateSource", DROP COLUMN "taxRate";
--   DROP TYPE "TaxRateSource";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "TaxRateSource" AS ENUM ('TENANT_DEFAULT', 'CUSTOMER_EXEMPT', 'LEGACY_INFERRED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "taxRate" DECIMAL(9,6),
ADD COLUMN     "taxRateSource" "TaxRateSource";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "taxRate" DECIMAL(9,6);

-- Raw-SQL CHECKs (Prisma does not model CHECK constraints). NOT VALID: no scan; enforced on new writes.
ALTER TABLE "Order" ADD CONSTRAINT "Order_taxRate_range_chk" CHECK ("taxRate" IS NULL OR ("taxRate" >= 0 AND "taxRate" <= 1)) NOT VALID;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_taxRate_range_chk" CHECK ("taxRate" IS NULL OR ("taxRate" >= 0 AND "taxRate" <= 1)) NOT VALID;

COMMIT;
