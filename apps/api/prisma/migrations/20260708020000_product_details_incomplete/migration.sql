-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "detailsIncomplete" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Product_tenantId_detailsIncomplete_idx" ON "Product"("tenantId", "detailsIncomplete");

