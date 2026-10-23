-- SA-772 folder 3 / SA-760 R-3 (B1105), sitting 4: an order invoice's explicit billing role.
--   CREATE TYPE "InvoiceOrderBillingRole" ('MIRROR','PARTIAL','REMAINDER','MANUAL') (SA-760 rule text)
--   "Invoice" "orderBillingRole" "InvoiceOrderBillingRole" NULL, with NO index in v1 (it is read per order; the existing
--   "Invoice"("orderId") index serves it).
--   NULL = not stamped: legacy invoices keep NULL until the R-3 census + dry-run backfill; billingRoleOf() infers until then.
-- Renamed from SA-772's 20261015090200 to sort after master's 20261016120000_units_prices_v2_schema (SA-814 §4).
--
-- METADATA-ONLY: a new type and one nullable column with no default (catalog-only ADD COLUMN, no rewrite, no scan).
-- LOCK PROFILE: ONE transaction; ACCESS EXCLUSIVE on "Invoice" from the ALTER to COMMIT, held only for the catalog update.
-- `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT: a lock wait longer than 5s fails and rolls the whole file back
-- (recorded FAILED; recover with `prisma migrate resolve --rolled-back 20261020090300_invoice_order_billing_role` from
-- apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes this column (SA-760 R-3).
--
-- Rollback (instant; nothing reads or writes it until R-3):
--   ALTER TABLE "Invoice" DROP COLUMN "orderBillingRole";
--   DROP TYPE "InvoiceOrderBillingRole";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "InvoiceOrderBillingRole" AS ENUM ('MIRROR', 'PARTIAL', 'REMAINDER', 'MANUAL');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "orderBillingRole" "InvoiceOrderBillingRole";

COMMIT;
