-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "deliveryWindowEnd" TEXT,
ADD COLUMN     "deliveryWindowStart" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "requestedDeliveryDate" TIMESTAMP(3),
ADD COLUMN     "templateId" TEXT;

-- CreateTable
CREATE TABLE "OrderTemplate" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "daysOfWeek" INTEGER[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTemplateItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderTemplate_customerId_idx" ON "OrderTemplate"("customerId");

-- CreateIndex
CREATE INDEX "OrderTemplate_isActive_idx" ON "OrderTemplate"("isActive");

-- CreateIndex
CREATE INDEX "OrderTemplateItem_templateId_idx" ON "OrderTemplateItem"("templateId");

-- CreateIndex
CREATE INDEX "Order_templateId_idx" ON "Order"("templateId");

-- CreateIndex
CREATE INDEX "Order_requestedDeliveryDate_idx" ON "Order"("requestedDeliveryDate");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplate" ADD CONSTRAINT "OrderTemplate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplateItem" ADD CONSTRAINT "OrderTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OrderTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderTemplateItem" ADD CONSTRAINT "OrderTemplateItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
