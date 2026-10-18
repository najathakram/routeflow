-- SA-772 folder 2a / SA-814 §3 (B296), sitting 4: widen the invoice-line tax-rate precision IN PLACE.
--   "InvoiceItem"."taxRate"          DECIMAL(5,4) -> DECIMAL(9,6)  (NOT NULL DEFAULT 0 kept)
--   "RecurringInvoiceItem"."taxRate" DECIMAL(5,4) -> DECIMAL(9,6)  (NOT NULL DEFAULT 0 kept)
--   Both hold a FRACTION. 6 dp = a percent to 4 dp (7.0625%), the precision of "Order"/"OrderItem"."taxRate" (folder 1).
--   Lossless: every 4-dp value is exactly representable at 6 dp, so no stored rate or amount changes. Issued money is never
--   rewritten (SA-814 §3 ruling 4); old rows keep their 4-dp value.
-- Renamed from SA-772's 20261015090100 to sort after master's 20261016120000_units_prices_v2_schema (SA-814 §4).
--
-- 2a vs 2b: THIS folder is variant 2a, valid only when InvoiceItem + RecurringInvoiceItem < 500 000 rows, measured on the
-- day by `apps/api/scripts/report-sitting4-sizing.mjs`. At >= 500 000 rows, remove this folder and drop in variant 2b
-- (`invoice_line_tax_rate_expand`, additive "lineTaxRate" columns) under the SAME folder name slot. Only one of the two
-- may ever be in the migrations folder. BEFORE APPLY: replace <N> in the two reason lines below with the measured count.
--
-- LOCK PROFILE: RUN OFF-PEAK. This is the bundle's ONLY table rewrite: a numeric SCALE change rewrites the table and
-- rebuilds every index on it. Each ALTER takes ACCESS EXCLUSIVE (blocks READS and writes) on its table until COMMIT:
-- "InvoiceItem" (and its indexes) for the length of its rewrite, then "RecurringInvoiceItem" (small). One transaction:
-- `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT; a lock wait longer than 5s fails and rolls the whole file back
-- (nothing is half applied; recorded FAILED: recover with
-- `prisma migrate resolve --rolled-back 20261020090200_invoice_tax_rate_widen` from apps/api, then re-run; NEVER
-- `--applied`). Squawk's changing-column-type is whitelisted per statement below with the measured reason.
-- HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and ONLY THEN
-- merge the R5-1 code siblings (6-dp inferred rate, DTO @Max(1), web/mobile inputs).
--
-- Rollback: ALTER TABLE "InvoiceItem" ALTER COLUMN "taxRate" SET DATA TYPE DECIMAL(5,4);
--           ALTER TABLE "RecurringInvoiceItem" ALTER COLUMN "taxRate" SET DATA TYPE DECIMAL(5,4);
--   (also a rewrite; lossless ONLY while no 5th/6th-dp value has been written, i.e. before the R5-1 writer PR merges.)

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
-- reason: B296 precision; measured <N> rows; off-peak
-- squawk-ignore changing-column-type
ALTER TABLE "InvoiceItem" ALTER COLUMN "taxRate" SET DATA TYPE DECIMAL(9,6);

-- AlterTable
-- reason: B296 precision; measured <N> rows; off-peak
-- squawk-ignore changing-column-type
ALTER TABLE "RecurringInvoiceItem" ALTER COLUMN "taxRate" SET DATA TYPE DECIMAL(9,6);

COMMIT;
