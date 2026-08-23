-- Sales agents & commissions (flag.sales_agents, PR-C). Additive only — new
-- enums/tables/columns, one Order column (commissionRatePct), no drops, no
-- backfill. Generated via `prisma migrate diff` from master (post-PR-B/MSRP,
-- 20260831000000_add_msrp_pricing) to this schema; the partial unique index
-- below is hand-appended (Prisma DSL cannot express a WHERE-qualified unique
-- index) following the precedent in
-- 20260826000000_stripe_connect_event_ledger (BuyerPaymentRequest_open_request_key).

-- CreateEnum
CREATE TYPE "SalesAgentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'STOPPED_FOR_NEW');

-- CreateEnum
CREATE TYPE "CommissionRateSource" AS ENUM ('ORDER_OVERRIDE', 'CUSTOMER_RATE', 'AGENT_DEFAULT', 'NONE');

-- CreateEnum
CREATE TYPE "CommissionAccrualStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAYABLE', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "CommissionAdjustmentKind" AS ENUM ('CLAWBACK', 'RATE_CHANGE', 'REASSIGNMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CommissionStatementStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "CommissionStatementLineKind" AS ENUM ('CLAIM', 'ADJUSTMENT', 'CARRYFORWARD');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "commissionRatePct" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "SalesAgent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "status" "SalesAgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "stopNewBusinessAt" TIMESTAMP(3),
    "userId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,

    CONSTRAINT "SalesAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesAgentRate" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "SalesAgentRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCommissionRate" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "CustomerCommissionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAssignment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "AgentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionAccrual" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "basisDate" TIMESTAMP(3) NOT NULL,
    "baseAmount" DECIMAL(10,2) NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "rateSource" "CommissionRateSource" NOT NULL,
    "accruedAmount" DECIMAL(10,2) NOT NULL,
    "payableAmount" DECIMAL(10,2) NOT NULL,
    "claimedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "CommissionAccrualStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,

    CONSTRAINT "CommissionAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionAdjustment" (
    "id" TEXT NOT NULL,
    "accrualId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "CommissionAdjustmentKind" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "CommissionAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionStatement" (
    "id" TEXT NOT NULL,
    "statementNumber" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "status" "CommissionStatementStatus" NOT NULL DEFAULT 'PENDING',
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,

    CONSTRAINT "CommissionStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionStatementLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "kind" "CommissionStatementLineKind" NOT NULL,
    "accrualId" TEXT,
    "adjustmentId" TEXT,
    "carriedFromStatementId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT,
    "tenantId" TEXT,

    CONSTRAINT "CommissionStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPayout" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expenseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "CommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesAgent_userId_key" ON "SalesAgent"("userId");

-- CreateIndex
CREATE INDEX "SalesAgent_tenantId_idx" ON "SalesAgent"("tenantId");

-- CreateIndex
CREATE INDEX "SalesAgent_tenantId_status_idx" ON "SalesAgent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SalesAgentRate_agentId_effectiveFrom_idx" ON "SalesAgentRate"("agentId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "SalesAgentRate_tenantId_idx" ON "SalesAgentRate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesAgentRate_tenantId_agentId_effectiveFrom_key" ON "SalesAgentRate"("tenantId", "agentId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CustomerCommissionRate_customerId_effectiveFrom_idx" ON "CustomerCommissionRate"("customerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CustomerCommissionRate_tenantId_idx" ON "CustomerCommissionRate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCommissionRate_tenantId_customerId_effectiveFrom_key" ON "CustomerCommissionRate"("tenantId", "customerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AgentAssignment_customerId_effectiveFrom_idx" ON "AgentAssignment"("customerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AgentAssignment_agentId_idx" ON "AgentAssignment"("agentId");

-- CreateIndex
CREATE INDEX "AgentAssignment_tenantId_idx" ON "AgentAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "CommissionAccrual_agentId_status_idx" ON "CommissionAccrual"("agentId", "status");

-- CreateIndex
CREATE INDEX "CommissionAccrual_customerId_idx" ON "CommissionAccrual"("customerId");

-- CreateIndex
CREATE INDEX "CommissionAccrual_tenantId_basisDate_idx" ON "CommissionAccrual"("tenantId", "basisDate");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionAccrual_tenantId_invoiceId_agentId_key" ON "CommissionAccrual"("tenantId", "invoiceId", "agentId");

-- CreateIndex
CREATE INDEX "CommissionAdjustment_agentId_idx" ON "CommissionAdjustment"("agentId");

-- CreateIndex
CREATE INDEX "CommissionAdjustment_accrualId_idx" ON "CommissionAdjustment"("accrualId");

-- CreateIndex
CREATE INDEX "CommissionAdjustment_tenantId_idx" ON "CommissionAdjustment"("tenantId");

-- CreateIndex
CREATE INDEX "CommissionStatement_agentId_status_idx" ON "CommissionStatement"("agentId", "status");

-- CreateIndex
CREATE INDEX "CommissionStatement_tenantId_idx" ON "CommissionStatement"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionStatement_tenantId_statementNumber_key" ON "CommissionStatement"("tenantId", "statementNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionStatementLine_adjustmentId_key" ON "CommissionStatementLine"("adjustmentId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionStatementLine_carriedFromStatementId_key" ON "CommissionStatementLine"("carriedFromStatementId");

-- CreateIndex
CREATE INDEX "CommissionStatementLine_statementId_idx" ON "CommissionStatementLine"("statementId");

-- CreateIndex
CREATE INDEX "CommissionStatementLine_accrualId_idx" ON "CommissionStatementLine"("accrualId");

-- CreateIndex
CREATE INDEX "CommissionStatementLine_tenantId_idx" ON "CommissionStatementLine"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPayout_expenseId_key" ON "CommissionPayout"("expenseId");

-- CreateIndex
CREATE INDEX "CommissionPayout_statementId_idx" ON "CommissionPayout"("statementId");

-- CreateIndex
CREATE INDEX "CommissionPayout_tenantId_idx" ON "CommissionPayout"("tenantId");

-- AddForeignKey
ALTER TABLE "SalesAgent" ADD CONSTRAINT "SalesAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesAgent" ADD CONSTRAINT "SalesAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesAgentRate" ADD CONSTRAINT "SalesAgentRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesAgentRate" ADD CONSTRAINT "SalesAgentRate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCommissionRate" ADD CONSTRAINT "CustomerCommissionRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCommissionRate" ADD CONSTRAINT "CustomerCommissionRate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCommissionRate" ADD CONSTRAINT "CustomerCommissionRate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAssignment" ADD CONSTRAINT "AgentAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAssignment" ADD CONSTRAINT "AgentAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAssignment" ADD CONSTRAINT "AgentAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAccrual" ADD CONSTRAINT "CommissionAccrual_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_accrualId_fkey" FOREIGN KEY ("accrualId") REFERENCES "CommissionAccrual"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "SalesAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementLine" ADD CONSTRAINT "CommissionStatementLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementLine" ADD CONSTRAINT "CommissionStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "CommissionStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementLine" ADD CONSTRAINT "CommissionStatementLine_accrualId_fkey" FOREIGN KEY ("accrualId") REFERENCES "CommissionAccrual"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementLine" ADD CONSTRAINT "CommissionStatementLine_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "CommissionAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatementLine" ADD CONSTRAINT "CommissionStatementLine_carriedFromStatementId_fkey" FOREIGN KEY ("carriedFromStatementId") REFERENCES "CommissionStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "CommissionStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One OPEN assignment per customer (effectiveTo IS NULL = current holder).
-- Prisma DSL cannot express partial unique indexes; precedent:
-- 20260826000000_stripe_connect_event_ledger (BuyerPaymentRequest_open_request_key).
CREATE UNIQUE INDEX "AgentAssignment_open_assignment_key"
  ON "AgentAssignment"("tenantId", "customerId")
  WHERE "effectiveTo" IS NULL;
