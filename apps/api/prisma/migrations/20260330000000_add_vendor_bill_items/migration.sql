-- AlterTable: add billDate to VendorBill
ALTER TABLE "VendorBill" ADD COLUMN "billDate" TIMESTAMP(3);

-- CreateTable: VendorBillItem
CREATE TABLE "VendorBillItem" (
    "id" TEXT NOT NULL,
    "vendorBillId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitCost" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorBillItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorBillItem_vendorBillId_idx" ON "VendorBillItem"("vendorBillId");

-- CreateIndex
CREATE INDEX "VendorBillItem_productId_idx" ON "VendorBillItem"("productId");

-- AddForeignKey
ALTER TABLE "VendorBillItem" ADD CONSTRAINT "VendorBillItem_vendorBillId_fkey" FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBillItem" ADD CONSTRAINT "VendorBillItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
