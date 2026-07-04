-- CreateEnum
CREATE TYPE "TobaccoReportStatus" AS ENUM ('GENERATED', 'FAILED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "tobaccoLicenseExpiry" TIMESTAMP(3),
ADD COLUMN     "tobaccoLicenseNo" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "isTobacco" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "tobaccoLicenseNo" TEXT;

-- CreateTable
CREATE TABLE "TobaccoReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "TobaccoReportStatus" NOT NULL DEFAULT 'GENERATED',
    "totalQtyPurchased" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "totalPurchaseValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalQtySold" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "totalSalesValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalTaxCollected" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "endingStockQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "endingStockValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL,
    "csvKey" TEXT,
    "pdfKey" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,
    "generationCount" INTEGER NOT NULL DEFAULT 1,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TobaccoReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TobaccoReport_tenantId_idx" ON "TobaccoReport"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TobaccoReport_tenantId_periodYear_periodMonth_key" ON "TobaccoReport"("tenantId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "Product_tenantId_isTobacco_idx" ON "Product"("tenantId", "isTobacco");

-- AddForeignKey
ALTER TABLE "TobaccoReport" ADD CONSTRAINT "TobaccoReport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

