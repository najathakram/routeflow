-- SA-827 PR2: "Customer"."invoiceUnitDefault", the customer-wide invoice unit (rule 5 of the SA-827 ruling). LEGACY = not set
-- (the invoice falls through to the line / tier / product / business setting, i.e. today's behaviour); PIECES = mixed boxes
-- list each item and boxes show their pieces; PACK = always the unit sold. DISPLAY ONLY: no money, tax, stock or ledger
-- column reads it. Additive: one new enum and one column with a constant default.
--
-- DRAFTED FOR THE NEXT SITTING: committed with the code, NOT applied to any shared or production database by this change.
-- Apply order is the usual one (fresh backup, `prod-migrate.mjs`, `schema-drift.mjs` exit 0, THEN the code that reads or
-- writes the column).
--
-- DEPLOY-DAY BEHAVIOUR: every existing customer reads LEGACY from the constant default, so every existing invoice renders
-- exactly as it does today. Nothing changes until an operator sets a customer to Pieces or Packs.
--
-- LOCK PROFILE: ADD COLUMN ... NOT NULL DEFAULT <constant> is a catalog-only change on PostgreSQL >= 11 (no table
-- rewrite); it takes ACCESS EXCLUSIVE on "Customer" for an instant. CREATE TYPE locks nothing anyone waits on.
-- `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that waits longer than 5s
-- for its lock fails and rolls the whole file back (recover with `prisma migrate resolve --rolled-back <folder>` from
-- apps/api, then re-run; NEVER `--applied`).
--
-- Rollback (only once no deployed code reads the column):
-- ALTER TABLE "Customer" DROP COLUMN "invoiceUnitDefault"; DROP TYPE "InvoiceUnitDefault";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "InvoiceUnitDefault" AS ENUM ('LEGACY', 'PIECES', 'PACK');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "invoiceUnitDefault" "InvoiceUnitDefault" NOT NULL DEFAULT 'LEGACY';

COMMIT;
