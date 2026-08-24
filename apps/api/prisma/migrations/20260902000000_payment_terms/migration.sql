-- Payment terms model: durable "Net N" label + deposit schedule + per-customer/
-- per-supplier defaults. Additive only — five nullable columns, no backfill.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "defaultPaymentTerms" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "defaultTerms" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "depositDueDate" TIMESTAMP(3),
ADD COLUMN     "depositPercent" DECIMAL(5,2),
ADD COLUMN     "paymentTermsLabel" TEXT;

-- AlterTable
ALTER TABLE "VendorBill" ADD COLUMN     "termsLabel" TEXT;

