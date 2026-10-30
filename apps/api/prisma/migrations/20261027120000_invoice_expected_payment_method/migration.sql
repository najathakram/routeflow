-- SA-1026 Part A (owner answer 1, 2026-10-27): the staff's payment intent on an invoice, so a named customer's sale can be
-- saved with nothing paid yet and read "To collect" until a payment clears it.
--   "Invoice" "expectedPaymentMethod" "PaymentMethod" NULL (the existing enum; the API only ever writes CHECK today)
--   CREATE INDEX "Invoice_tenantId_expectedPaymentMethod_idx" ON "Invoice"("tenantId", "expectedPaymentMethod") (the
--   tenant-wide "To collect" list and the AR aging column).
--   NULL = no intent: every existing invoice, and an On account sale as today. NO backfill, no default.
--   "To collect" itself is NOT stored: it is derived from this column and the invoice status on every read.
--
-- METADATA-ONLY column: nullable, no default (catalog-only ADD COLUMN, no rewrite, no scan). The index is built on a
-- populated "Invoice" table: it blocks writes to "Invoice" for the build. RUN OFF-PEAK (the owner's sitting).
-- LOCK PROFILE: ONE transaction; `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT: a lock wait longer than 5s fails and
-- rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261027120000_invoice_expected_payment_method` from apps/api, then re-run;
-- NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge the code that reads or writes this column.
--
-- Rollback (instant; nothing else references it):
--   DROP INDEX "Invoice_tenantId_expectedPaymentMethod_idx";
--   ALTER TABLE "Invoice" DROP COLUMN "expectedPaymentMethod";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "expectedPaymentMethod" "PaymentMethod";

-- CreateIndex
-- reason: index on populated "Invoice" columns: blocks writes to "Invoice" for the build; the owner runs this sitting off-peak and decides from the prod row count in the PR body
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "Invoice_tenantId_expectedPaymentMethod_idx" ON "Invoice"("tenantId", "expectedPaymentMethod");

COMMIT;
