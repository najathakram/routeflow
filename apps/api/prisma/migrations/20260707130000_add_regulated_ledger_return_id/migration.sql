-- AlterTable
ALTER TABLE "RegulatedSalesLedger" ADD COLUMN     "returnId" TEXT;

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_returnId_idx" ON "RegulatedSalesLedger"("returnId");
