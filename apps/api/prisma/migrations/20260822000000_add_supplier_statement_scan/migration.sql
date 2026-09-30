-- CreateEnum
CREATE TYPE "SupplierStatementScanStatus" AS ENUM ('SCANNED', 'APPLIED', 'DISCARDED');

-- CreateTable
CREATE TABLE "SupplierStatementScan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "fileKey" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "byteSize" INTEGER,
    "pageCount" INTEGER,
    "fileHash" TEXT NOT NULL,
    "extractedPayload" JSONB NOT NULL,
    "model" TEXT,
    "scanDurationMs" INTEGER,
    "supplierNameRaw" TEXT,
    "supplierId" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "openingBalance" DECIMAL(12,2),
    "closingBalance" DECIMAL(12,2),
    "lineCount" INTEGER,
    "status" "SupplierStatementScanStatus" NOT NULL DEFAULT 'SCANNED',
    "appliedPaymentGroupId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "scannedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierStatementScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierStatementScan_tenantId_fileHash_idx" ON "SupplierStatementScan"("tenantId", "fileHash");

-- CreateIndex
CREATE INDEX "SupplierStatementScan_tenantId_supplierId_idx" ON "SupplierStatementScan"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierStatementScan_tenantId_status_idx" ON "SupplierStatementScan"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "SupplierStatementScan" ADD CONSTRAINT "SupplierStatementScan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierStatementScan" ADD CONSTRAINT "SupplierStatementScan_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
