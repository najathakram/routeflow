-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentNumberType" ADD VALUE 'RETURN';
ALTER TYPE "DocumentNumberType" ADD VALUE 'ORDER';

-- DropIndex
DROP INDEX "NumberingSequence_tenantId_docType_key";

-- AlterTable
ALTER TABLE "DriverLocation" ADD COLUMN     "accuracy" DECIMAL(8,2);

-- AlterTable
ALTER TABLE "RouteRun" ADD COLUMN     "settlementNote" TEXT,
ADD COLUMN     "settlementVariance" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "RouteRunStop" ADD COLUMN     "podHistory" JSONB,
ADD COLUMN     "skipReason" TEXT;

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "issueDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "condition" TEXT,
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "RecurringInvoice" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastRunStatus" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "impersonatedBy" TEXT;

-- AlterTable
ALTER TABLE "NumberingSequence" ADD COLUMN     "year" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_invoiceId_key" ON "Estimate"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "NumberingSequence_tenantId_docType_year_key" ON "NumberingSequence"("tenantId", "docType", "year");

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
