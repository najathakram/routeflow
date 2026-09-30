-- CreateEnum
CREATE TYPE "BuyerPaymentRequestKind" AS ENUM ('CARD', 'CASH');

-- CreateEnum
CREATE TYPE "BuyerPaymentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TenantStripeConnect" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "connectedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantStripeConnect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerPaymentRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "buyerAccountId" TEXT,
    "invoiceId" TEXT,
    "kind" "BuyerPaymentRequestKind" NOT NULL,
    "status" "BuyerPaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "paymentGroupId" TEXT,
    "failureReason" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerPaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantStripeConnect_tenantId_key" ON "TenantStripeConnect"("tenantId");

-- CreateIndex
CREATE INDEX "TenantStripeConnect_stripeAccountId_idx" ON "TenantStripeConnect"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerPaymentRequest_stripeSessionId_key" ON "BuyerPaymentRequest"("stripeSessionId");

-- CreateIndex
CREATE INDEX "BuyerPaymentRequest_tenantId_status_idx" ON "BuyerPaymentRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "BuyerPaymentRequest_customerId_idx" ON "BuyerPaymentRequest"("customerId");

-- CreateIndex
CREATE INDEX "BuyerPaymentRequest_tenantId_createdAt_idx" ON "BuyerPaymentRequest"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "BuyerPaymentRequest_paymentGroupId_idx" ON "BuyerPaymentRequest"("paymentGroupId");

-- AddForeignKey
ALTER TABLE "TenantStripeConnect" ADD CONSTRAINT "TenantStripeConnect_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPaymentRequest" ADD CONSTRAINT "BuyerPaymentRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPaymentRequest" ADD CONSTRAINT "BuyerPaymentRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPaymentRequest" ADD CONSTRAINT "BuyerPaymentRequest_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPaymentRequest" ADD CONSTRAINT "BuyerPaymentRequest_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

