-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'REVIEW', 'COMMITTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "StockCountLineMode" AS ENUM ('REPLACE', 'ADD');

-- CreateTable
CREATE TABLE "StockCountSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "committedById" TEXT,
    "discardedAt" TIMESTAMP(3),
    "notes" TEXT,
    "movementReference" TEXT,
    "amendsSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCountSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "sessionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mode" "StockCountLineMode" NOT NULL DEFAULT 'REPLACE',
    "countedQty" DECIMAL(10,3) NOT NULL,
    "boxes" INTEGER,
    "pieces" INTEGER,
    "expectedQty" DECIMAL(10,3) NOT NULL,
    "unitCostOverride" DECIMAL(10,4),
    "countedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockCountSession_tenantId_status_idx" ON "StockCountSession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StockCountSession_tenantId_startedAt_idx" ON "StockCountSession"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "StockCountLine_tenantId_idx" ON "StockCountLine"("tenantId");

-- CreateIndex
CREATE INDEX "StockCountLine_productId_idx" ON "StockCountLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_sessionId_productId_key" ON "StockCountLine"("sessionId", "productId");

-- AddForeignKey
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_committedById_fkey" FOREIGN KEY ("committedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_amendsSessionId_fkey" FOREIGN KEY ("amendsSessionId") REFERENCES "StockCountSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StockCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countedById_fkey" FOREIGN KEY ("countedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
