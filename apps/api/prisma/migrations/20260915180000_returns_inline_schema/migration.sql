-- CreateEnum
CREATE TYPE "ReturnKind" AS ENUM ('STANDARD', 'INLINE');

-- AlterTable
ALTER TABLE "Return" ADD COLUMN     "kind" "ReturnKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "returnKey" TEXT,
ADD COLUMN     "capturePayload" JSONB,
ADD COLUMN     "capturedById" TEXT,
ADD COLUMN     "capturedRole" TEXT,
ADD COLUMN     "routeRunStopId" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "captureAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "captureError" TEXT,
ADD COLUMN     "heldAmount" DECIMAL(10,2),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "mismatch" JSONB,
ADD COLUMN     "alertedAt" TIMESTAMP(3),
ADD COLUMN     "creditSubtotal" DECIMAL(10,2),
ADD COLUMN     "creditTax" DECIMAL(10,2),
ADD COLUMN     "creditCategoryTax" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "sourceOrderId" TEXT,
ADD COLUMN     "sourceInvoiceItemId" TEXT,
ADD COLUMN     "sourceOrderItemId" TEXT,
ADD COLUMN     "unitPrice" DECIMAL(10,2),
ADD COLUMN     "subtotal" DECIMAL(10,2),
ADD COLUMN     "taxAmount" DECIMAL(10,2),
ADD COLUMN     "categoryTax" DECIMAL(10,2),
ADD COLUMN     "boxes" INTEGER,
ADD COLUMN     "pieces" INTEGER,
ADD COLUMN     "unitsPerBox" INTEGER,
ADD COLUMN     "priceSource" TEXT,
ADD COLUMN     "originalPrice" DECIMAL(10,2),
ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "overriddenBy" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Return_tenantId_returnKey_key" ON "Return"("tenantId", "returnKey");

-- CreateIndex
CREATE INDEX "Return_kind_idx" ON "Return"("kind");

-- CreateIndex
CREATE INDEX "ReturnItem_sourceOrderId_productId_idx" ON "ReturnItem"("sourceOrderId", "productId");
