-- Manual invoices due, PR1: the manual-pay lifecycle columns on "RfInvoice". ADDITIVE ONLY: every new
-- column is nullable or has a constant default, nothing is dropped or retyped. "status" stays a plain
-- string (OPEN | PAID | VOID; the legacy FAILED is never written) and is deliberately not a Prisma enum.
--
-- OWNER SITTING: before this is applied to production run the read-only count
--   railway run --service postgres node apps/api/scripts/report-rf-invoice-zero-rows.mjs
-- and require exit 0 (zero rows). The index waivers below are only true while that holds.
--
-- LOCK PROFILE: constant defaults are metadata-only on PG >= 11 (no rewrite). The two index builds are
-- plain (non-concurrent) because the table has no writer before this change. lock_timeout bounds the wait.
--
-- Rollback (instant while empty):
--   DROP INDEX "RfInvoice_tenantId_periodKey_key"; DROP INDEX "RfInvoice_status_dueDate_idx";
--   ALTER TABLE "RfInvoice" DROP COLUMN "currency", DROP COLUMN "dueDate", ... (each column below);
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261007120000_rf_invoice_manual_lifecycle
-- from apps/api, then re-run. NEVER `--applied`.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "RfInvoice" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "issuedById" TEXT,
ADD COLUMN     "lastSentAt" TIMESTAMP(3),
ADD COLUMN     "lines" JSONB,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paidById" TEXT,
ADD COLUMN     "paidMethod" TEXT,
ADD COLUMN     "paidNote" TEXT,
ADD COLUMN     "paidRef" TEXT,
ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodKey" TEXT,
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "sendCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- CreateIndex
-- reason: RfInvoice has no writer before this migration (0 rows)
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "RfInvoice_status_dueDate_idx" ON "RfInvoice"("status", "dueDate");

-- CreateIndex
-- reason: RfInvoice has no writer before this migration (0 rows)
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "RfInvoice_tenantId_periodKey_key" ON "RfInvoice"("tenantId", "periodKey");

COMMIT;
