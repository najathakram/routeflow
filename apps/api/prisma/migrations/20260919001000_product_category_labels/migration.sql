-- Multi-category product labels (2026-09-19) — additive only.
-- See local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md §1.1-1.2.
-- Deliberately separate from TrackedCategory; Product.category (free text) is
-- untouched. Effective label set is computed dynamically at read time — never
-- snapshotted — so this migration adds no backfill.

-- CreateEnum
CREATE TYPE "LabelMode" AS ENUM ('INCLUDE', 'EXCLUDE');

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategoryLabel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "mode" "LabelMode" NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategoryLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_tenantId_name_key" ON "ProductCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ProductCategoryLabel_tenantId_categoryId_idx" ON "ProductCategoryLabel"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategoryLabel_productId_categoryId_key" ON "ProductCategoryLabel"("productId", "categoryId");

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategoryLabel" ADD CONSTRAINT "ProductCategoryLabel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategoryLabel" ADD CONSTRAINT "ProductCategoryLabel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategoryLabel" ADD CONSTRAINT "ProductCategoryLabel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
