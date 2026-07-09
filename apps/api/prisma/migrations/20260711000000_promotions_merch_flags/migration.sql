-- Phase 5 (P5-01): buyer merchandising flags + tenant promotions.
-- Additive only — new columns with safe defaults, new enums, new tables. No drops.

-- AlterTable: product merchandising flags surfaced on buyer tiles / smart collections.
ALTER TABLE "Product" ADD COLUMN     "isNew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isDeal" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT', 'FIXED', 'QTY_BREAK');
CREATE TYPE "PromotionScope" AS ENUM ('ALL', 'CATEGORY', 'PRODUCTS');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bannerText" TEXT,
    "type" "PromotionType" NOT NULL DEFAULT 'PERCENT',
    "value" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "minQty" INTEGER,
    "scope" "PromotionScope" NOT NULL DEFAULT 'ALL',
    "category" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PromotionProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_tenantId_idx" ON "Promotion"("tenantId");
CREATE INDEX "Promotion_tenantId_isActive_startsAt_endsAt_idx" ON "Promotion"("tenantId", "isActive", "startsAt", "endsAt");
CREATE UNIQUE INDEX "PromotionProduct_promotionId_productId_key" ON "PromotionProduct"("promotionId", "productId");
CREATE INDEX "PromotionProduct_tenantId_idx" ON "PromotionProduct"("tenantId");
CREATE INDEX "PromotionProduct_productId_idx" ON "PromotionProduct"("productId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
