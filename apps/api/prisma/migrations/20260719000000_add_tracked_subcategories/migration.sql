-- Phase 4 (subcategories): additive-only. A TrackedSubcategory is a classification
-- child under a TrackedCategory (section); Product/OrderItem/InvoiceItem gain an
-- optional nullable pointer to it. No existing column/row changes, no backfill.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "trackedSubcategoryId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "trackedSubcategoryId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "trackedSubcategoryId" TEXT;

-- CreateTable
CREATE TABLE "TrackedSubcategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trackedCategoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedSubcategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedSubcategory_tenantId_idx" ON "TrackedSubcategory"("tenantId");

-- CreateIndex
CREATE INDEX "TrackedSubcategory_trackedCategoryId_idx" ON "TrackedSubcategory"("trackedCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedSubcategory_tenantId_trackedCategoryId_name_key" ON "TrackedSubcategory"("tenantId", "trackedCategoryId", "name");

-- CreateIndex
CREATE INDEX "Product_trackedSubcategoryId_idx" ON "Product"("trackedSubcategoryId");

-- CreateIndex
CREATE INDEX "OrderItem_trackedSubcategoryId_idx" ON "OrderItem"("trackedSubcategoryId");

-- CreateIndex
CREATE INDEX "InvoiceItem_trackedSubcategoryId_idx" ON "InvoiceItem"("trackedSubcategoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_trackedSubcategoryId_fkey" FOREIGN KEY ("trackedSubcategoryId") REFERENCES "TrackedSubcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_trackedSubcategoryId_fkey" FOREIGN KEY ("trackedSubcategoryId") REFERENCES "TrackedSubcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_trackedSubcategoryId_fkey" FOREIGN KEY ("trackedSubcategoryId") REFERENCES "TrackedSubcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedSubcategory" ADD CONSTRAINT "TrackedSubcategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedSubcategory" ADD CONSTRAINT "TrackedSubcategory_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
