-- CreateEnum
CREATE TYPE "ImportEntityType" AS ENUM ('CUSTOMER', 'INVOICE', 'PAYMENT', 'PRODUCT', 'SUPPLIER', 'CREDIT_NOTE', 'VENDOR_BILL');

-- CreateTable
CREATE TABLE "ImportExternalRef" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "ImportEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalSource" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAlias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL DEFAULT '',
    "rawText" TEXT NOT NULL,
    "productId" TEXT,
    "expenseCategoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportExternalRef_tenantId_entityType_entityId_idx" ON "ImportExternalRef"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "ImportExternalRef_tenantId_entityType_idx" ON "ImportExternalRef"("tenantId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "ImportExternalRef_tenantId_externalSource_externalId_entity_key" ON "ImportExternalRef"("tenantId", "externalSource", "externalId", "entityType");

-- CreateIndex
CREATE INDEX "ProductAlias_tenantId_rawText_idx" ON "ProductAlias"("tenantId", "rawText");

-- CreateIndex
CREATE INDEX "ProductAlias_tenantId_supplierId_idx" ON "ProductAlias"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAlias_tenantId_supplierId_rawText_key" ON "ProductAlias"("tenantId", "supplierId", "rawText");

