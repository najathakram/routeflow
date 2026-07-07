-- CreateEnum
CREATE TYPE "RegulatedFilingStatus" AS ENUM ('GENERATED', 'FAILED');

-- CreateTable
CREATE TABLE "RegulatedFiling" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trackedCategoryId" TEXT NOT NULL,
    "reportTemplate" TEXT NOT NULL,
    "cadence" "ReportCadence" NOT NULL DEFAULT 'MONTHLY',
    "periodKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "RegulatedFilingStatus" NOT NULL DEFAULT 'GENERATED',
    "totalQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "totalUnitBasisQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "totalNetSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalCategoryTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL,
    "csvKey" TEXT,
    "pdfKey" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,
    "generationCount" INTEGER NOT NULL DEFAULT 1,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegulatedFiling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegulatedFiling_tenantId_idx" ON "RegulatedFiling"("tenantId");

-- CreateIndex
CREATE INDEX "RegulatedFiling_tenantId_trackedCategoryId_idx" ON "RegulatedFiling"("tenantId", "trackedCategoryId");

-- CreateIndex
CREATE INDEX "RegulatedFiling_trackedCategoryId_idx" ON "RegulatedFiling"("trackedCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatedFiling_tenantId_trackedCategoryId_periodKey_key" ON "RegulatedFiling"("tenantId", "trackedCategoryId", "periodKey");

-- AddForeignKey
ALTER TABLE "RegulatedFiling" ADD CONSTRAINT "RegulatedFiling_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatedFiling" ADD CONSTRAINT "RegulatedFiling_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
