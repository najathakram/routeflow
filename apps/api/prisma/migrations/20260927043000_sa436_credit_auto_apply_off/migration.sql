-- SA-436 PR-1 (#2401, owner ruling 2026-09-27: credit auto-apply OFF by default). ONE additive migration.
--
-- 1. "TenantConfig"."creditAutoApplyOnSend" BOOLEAN NOT NULL DEFAULT false. The send transaction reads it; OFF
--    (every existing tenant, per the ruling) skips the oldest-first credit sweep. An order's hand-picked credit
--    intents still settle.
-- 2. "CreditNote"."autoApplyExcluded" BOOLEAN NOT NULL DEFAULT false: an operator kept this note out of the sweep.
-- 3. "InvoicePayment"."autoApplied" BOOLEAN NOT NULL DEFAULT false: the sweep wrote this CREDIT_NOTE payment.
--    Existing rows read as manual.
--    Each ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only in Postgres 11+ (no table rewrite, no scan).
-- 4. A NEW, EMPTY table "CreditNoteApplyBlock" plus its enum: the don't-re-apply memory for a (credit note,
--    invoice) pair. UNIQUE ("creditNoteId", "invoiceId"). FKs to Tenant, CreditNote and Invoice are ON DELETE
--    CASCADE. "tenantId" is NOT NULL from birth. Nothing writes to it until the #2401 code ships.
--
-- lock_timeout bounds the WAIT for the brief ACCESS EXCLUSIVE lock each ADD COLUMN needs, and for the locks the
-- new table's FKs take on "Tenant", "CreditNote" and "Invoice" (SET LOCAL: scoped to this transaction).
--
-- ORDERING: apply to prod BEFORE the PR that adds these fields to the Prisma schema merges. The redeployed
-- client selects the new columns on every read of InvoicePayment, CreditNote and TenantConfig, so it 500s until
-- they exist. The reverse order is safe.
--
-- Rollback (instant while the table is empty and no code reads the columns):
--   DROP TABLE "CreditNoteApplyBlock";
--   DROP TYPE "CreditNoteApplyBlockReason";
--   ALTER TABLE "TenantConfig" DROP COLUMN "creditAutoApplyOnSend";
--   ALTER TABLE "CreditNote" DROP COLUMN "autoApplyExcluded";
--   ALTER TABLE "InvoicePayment" DROP COLUMN "autoApplied";

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "CreditNoteApplyBlockReason" AS ENUM ('UNAPPLIED', 'UNTICKED', 'VOID_REVERSAL');

-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "autoApplied" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "autoApplyExcluded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "creditAutoApplyOnSend" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CreditNoteApplyBlock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" "CreditNoteApplyBlockReason" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteApplyBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditNoteApplyBlock_invoiceId_idx" ON "CreditNoteApplyBlock"("invoiceId");

-- CreateIndex
CREATE INDEX "CreditNoteApplyBlock_tenantId_idx" ON "CreditNoteApplyBlock"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteApplyBlock_creditNoteId_invoiceId_key" ON "CreditNoteApplyBlock"("creditNoteId", "invoiceId");

-- AddForeignKey
ALTER TABLE "CreditNoteApplyBlock" ADD CONSTRAINT "CreditNoteApplyBlock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteApplyBlock" ADD CONSTRAINT "CreditNoteApplyBlock_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteApplyBlock" ADD CONSTRAINT "CreditNoteApplyBlock_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

