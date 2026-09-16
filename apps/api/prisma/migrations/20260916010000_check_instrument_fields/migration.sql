-- Post-dated check payments, PR-1 (schema + shared helpers only; additive-only,
-- no behavior change — every new column is nullable, every new enum value is
-- unused by any read/write path in this PR; later PRs wire reads/writes).

-- CreateEnum
CREATE TYPE "CheckReturnReason" AS ENUM ('NSF', 'ACCOUNT_CLOSED', 'STOP_PAYMENT', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to more than one enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum. Each ADD VALUE below is its own statement for that reason,
-- even though each enum only gains a single value here.

-- PaymentStatus.PENDING: a CHECK payment recorded and held but not yet
-- clearable/bankable — see finance.prisma's comment on the enum for why
-- this is neither DRAFT nor PAID. Unused by any read/write path in this PR.
ALTER TYPE "PaymentStatus" ADD VALUE 'PENDING';

-- NotificationEvent.CHECK_RETURNED: fired on a CHECK bounce by a later PR's
-- check-lifecycle transition wiring. Unused (no firing site) in this PR.
ALTER TYPE "NotificationEvent" ADD VALUE 'CHECK_RETURNED';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "feeForPaymentId" TEXT;

-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "bounceReason" "CheckReturnReason",
ADD COLUMN     "checkDate" DATE,
ADD COLUMN     "checkNumber" TEXT,
ADD COLUMN     "nsfFeeInvoiceId" TEXT,
ADD COLUMN     "replacesPaymentId" TEXT;

-- AlterTable
ALTER TABLE "AdvancePayment" ADD COLUMN     "sourcePaymentId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "creditHoldAt" TIMESTAMP(3),
ADD COLUMN     "creditHoldById" TEXT,
ADD COLUMN     "creditHoldReason" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "checksDigestSentForDay" DATE;

-- CreateIndex
CREATE INDEX "InvoicePayment_tenantId_checkDate_idx" ON "InvoicePayment"("tenantId", "checkDate");

-- CreateIndex
CREATE INDEX "InvoicePayment_tenantId_checkStatus_idx" ON "InvoicePayment"("tenantId", "checkStatus");

-- CreateIndex
CREATE INDEX "AdvancePayment_sourcePaymentId_idx" ON "AdvancePayment"("sourcePaymentId");
