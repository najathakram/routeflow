-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "baseUnitLabel" TEXT,
ADD COLUMN     "invoiceLineCode" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "baseLabel" TEXT;

-- AlterTable
ALTER TABLE "ProductUnit" ADD COLUMN     "perParent" INTEGER,
ADD COLUMN     "retiredSku" TEXT,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "tenantUnitId" TEXT;

-- AlterTable
ALTER TABLE "ProductBarcode" ADD COLUMN     "productUnitId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "lineCode" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "CreditNoteItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "lineCode" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "EstimateItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "VendorBillItem" ADD COLUMN     "baseLabel" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- CreateTable
CREATE TABLE "TenantUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "plural" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantUnit_tenantId_idx" ON "TenantUnit"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantUnit_tenantId_nameKey_key" ON "TenantUnit"("tenantId", "nameKey");

-- CreateIndex
CREATE INDEX "ProductUnit_tenantUnitId_idx" ON "ProductUnit"("tenantUnitId");

-- CreateIndex
CREATE INDEX "ProductUnit_tenantId_sku_idx" ON "ProductUnit"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "ProductBarcode_productUnitId_idx" ON "ProductBarcode"("productUnitId");

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_tenantUnitId_fkey" FOREIGN KEY ("tenantUnitId") REFERENCES "TenantUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantUnit" ADD CONSTRAINT "TenantUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_productUnitId_fkey" FOREIGN KEY ("productUnitId") REFERENCES "ProductUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

