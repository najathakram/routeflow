-- CreateEnum
CREATE TYPE "ImportFileStatus" AS ENUM ('QUEUED', 'PROCESSING', 'CLEAN', 'NEEDS_REVIEW', 'DUPLICATE', 'FAILED', 'POSTED');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PROCESSING', 'READY', 'POSTED', 'PARTIALLY_POSTED');

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BATCH_BILLS',
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PROCESSING',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "cleanCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "dupeCount" INTEGER NOT NULL DEFAULT 0,
    "postedCount" INTEGER NOT NULL DEFAULT 0,
    "meteredScans" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportQueueItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT,
    "status" "ImportFileStatus" NOT NULL DEFAULT 'QUEUED',
    "extractedPayload" JSONB,
    "supplierMatchId" TEXT,
    "supplierName" TEXT,
    "invoiceNumber" TEXT,
    "total" DECIMAL(12,2),
    "duplicateOfInvoiceId" TEXT,
    "confidence" DECIMAL(5,4),
    "unmatchedLines" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "vendorBillId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_status_idx" ON "ImportBatch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_createdAt_idx" ON "ImportBatch"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportQueueItem_tenantId_batchId_idx" ON "ImportQueueItem"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "ImportQueueItem_batchId_status_idx" ON "ImportQueueItem"("batchId", "status");

-- CreateIndex
CREATE INDEX "ImportQueueItem_duplicateOfInvoiceId_idx" ON "ImportQueueItem"("duplicateOfInvoiceId");

-- AddForeignKey
ALTER TABLE "ImportQueueItem" ADD CONSTRAINT "ImportQueueItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

