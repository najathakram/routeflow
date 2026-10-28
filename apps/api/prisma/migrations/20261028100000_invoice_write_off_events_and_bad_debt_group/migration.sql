-- SA-1050 PR-0 (bad-debt write-offs, folder 1 of 2, SCHEMA ONLY): the write-off ledger, who wrote the current write-off off,
-- and the BAD_DEBT permission group. Nothing in the app reads or writes any of it yet (PR-1 and later); this folder merges only
-- inside a migration sitting (#5).
--   "InvoiceWriteOffKind"      new enum: WRITE_OFF | REINSTATE
--   "InvoiceWriteOffEvent"     new table, one signed ledger row per movement (a WRITE_OFF is positive, a REINSTATE its exact
--                              negative). Three inline CHECKs: the kind / sign / pre-tax shape; dated unless an authorless
--                              imported write-off; a non-blank reason. FK to "Invoice" ON DELETE RESTRICT, FK to "User" ON DELETE
--                              SET NULL. Indexes ("tenantId","at") and ("invoiceId","createdAt"). No FK to "Tenant" (the ruling
--                              names only the two keys).
--   "Invoice"."writtenOffById" TEXT NULL (no default, no backfill, no FK)
--   "OperatorPermissionGroup"  += BAD_DEBT (last)
-- The new enum value is only ADDED here. Using it (the column default, the deny-list append) is folder 2,
-- 20261028100100_bad_debt_default_denied, because a value added in a transaction cannot be used until that transaction
-- commits ("unsafe use of new value").
--
-- Additive only: a new empty table, one nullable column (metadata-only, no rewrite), one enum value. Nothing dropped or rewritten.
-- LOCK PROFILE: ONE transaction. A brief ACCESS EXCLUSIVE on "Invoice" for the ADD COLUMN and SHARE ROW EXCLUSIVE on "Invoice" and
-- "User" for the two foreign keys, a lock on the enum type for ADD VALUE; no scan of an existing row (the new table is empty, so
-- the FKs and CHECKs validate nothing). `SET LOCAL lock_timeout = '5s'` bounds every wait; a timeout rolls the whole file back
-- (recorded FAILED; recover with `prisma migrate resolve --rolled-back 20261028100000_invoice_write_off_events_and_bad_debt_group`
-- from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, then folder 2, and ONLY THEN
-- merge any code that reads or writes these objects.
--
-- Rollback (nothing references the objects yet):
--   DROP TABLE "InvoiceWriteOffEvent"; DROP TYPE "InvoiceWriteOffKind"; ALTER TABLE "Invoice" DROP COLUMN "writtenOffById";
--   (a Postgres enum value cannot be dropped; BAD_DEBT stays, unused, which is harmless.)

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "InvoiceWriteOffKind" AS ENUM ('WRITE_OFF', 'REINSTATE');

-- AlterEnum
ALTER TYPE "OperatorPermissionGroup" ADD VALUE 'BAD_DEBT';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "writtenOffById" TEXT;

-- CreateTable
CREATE TABLE "InvoiceWriteOffEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "InvoiceWriteOffKind" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "preTax" DECIMAL(10,2) NOT NULL,
    "at" TIMESTAMP(3),
    "byId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceWriteOffEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvoiceWriteOffEvent_kind_sign_chk"
      CHECK ((kind = 'WRITE_OFF' AND amount > 0 AND "preTax" >= 0 AND "preTax" <= amount) OR (kind = 'REINSTATE' AND amount < 0 AND "preTax" <= 0 AND "preTax" >= amount)),
    CONSTRAINT "InvoiceWriteOffEvent_dated_chk"
      CHECK (at IS NOT NULL OR (kind = 'WRITE_OFF' AND "byId" IS NULL)),
    CONSTRAINT "InvoiceWriteOffEvent_reason_chk"
      CHECK (length(btrim(reason)) > 0)
);

-- SA-816 (d)1 backstop: NUMERIC accepts 'NaN'. The table is new and empty, so the constraints validate at once.
ALTER TABLE "InvoiceWriteOffEvent"
  ADD CONSTRAINT "InvoiceWriteOffEvent_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric),
  ADD CONSTRAINT "InvoiceWriteOffEvent_preTax_not_nan" CHECK ("preTax" <> 'NaN'::numeric);

-- CreateIndex
CREATE INDEX "InvoiceWriteOffEvent_tenantId_at_idx" ON "InvoiceWriteOffEvent"("tenantId", "at");

-- CreateIndex
CREATE INDEX "InvoiceWriteOffEvent_invoiceId_createdAt_idx" ON "InvoiceWriteOffEvent"("invoiceId", "createdAt");

-- AddForeignKey
ALTER TABLE "InvoiceWriteOffEvent" ADD CONSTRAINT "InvoiceWriteOffEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceWriteOffEvent" ADD CONSTRAINT "InvoiceWriteOffEvent_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
