-- Units/PO minimal (2026-09-19) — additive only, zero backfill, no existing
-- column altered, no NOT NULL added to an existing table.
-- See local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §1.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "unitLabel" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "unitLabel" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "packSize" INTEGER,
ADD COLUMN     "sku" TEXT;

-- AlterTable
ALTER TABLE "VendorBill" ADD COLUMN     "purchaseOrderId" TEXT;

-- CreateTable
CREATE TABLE "ProductUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "factorToBase" INTEGER NOT NULL,
    "price" DECIMAL(10,2),
    "priceTier2" DECIMAL(10,2),
    "priceTier3" DECIMAL(10,2),
    "priceTier4" DECIMAL(10,2),
    "priceTier5" DECIMAL(10,2),
    "isDefaultSelling" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "packSize" INTEGER,
    "lastUnitCost" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductUnit_tenantId_idx" ON "ProductUnit"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductUnit_productId_label_key" ON "ProductUnit"("productId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ProductUnit_productId_factorToBase_key" ON "ProductUnit"("productId", "factorToBase");

-- CreateIndex
CREATE INDEX "SupplierProduct_tenantId_idx" ON "SupplierProduct"("tenantId");

-- CreateIndex
CREATE INDEX "SupplierProduct_supplierId_idx" ON "SupplierProduct"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_tenantId_supplierId_productId_key" ON "SupplierProduct"("tenantId", "supplierId", "productId");

-- Partial unique index: Prisma cannot express a WHERE clause on a unique
-- index, so this is raw SQL — same precedent as the Product name partial
-- indexes (see catalog.prisma's Product model comment,
-- migrations/20260504000000_variant_name_per_parent). The table is new and
-- empty, so this is a zero-risk lock.
-- reason: partial unique index, table is new and empty
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "SupplierProduct_tenantId_supplierId_supplierSku_key"
  ON "SupplierProduct"("tenantId", "supplierId", "supplierSku")
  WHERE "supplierSku" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "VendorBill_purchaseOrderId_key" ON "VendorBill"("purchaseOrderId");

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
