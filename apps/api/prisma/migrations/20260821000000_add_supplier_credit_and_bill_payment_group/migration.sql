-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "paymentGroupId" TEXT,
ADD COLUMN     "supplierCreditId" TEXT;

-- CreateTable
CREATE TABLE "SupplierCredit" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "balance" DECIMAL(10,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,

    CONSTRAINT "SupplierCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierCredit_supplierId_idx" ON "SupplierCredit"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierCredit_tenantId_idx" ON "SupplierCredit"("tenantId");

-- CreateIndex
CREATE INDEX "BillPayment_paymentGroupId_idx" ON "BillPayment"("paymentGroupId");

-- CreateIndex
CREATE INDEX "BillPayment_supplierCreditId_idx" ON "BillPayment"("supplierCreditId");

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_supplierCreditId_fkey" FOREIGN KEY ("supplierCreditId") REFERENCES "SupplierCredit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCredit" ADD CONSTRAINT "SupplierCredit_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCredit" ADD CONSTRAINT "SupplierCredit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
