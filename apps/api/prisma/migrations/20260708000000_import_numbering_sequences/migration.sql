-- Migration & Batch Import — Phase 1: numbering continuity.
-- Additive only: one new enum + one new table. No changes to existing tables,
-- no data backfill. Safe to apply to production (empty new table).

-- CreateEnum
CREATE TYPE "DocumentNumberType" AS ENUM ('INVOICE', 'ESTIMATE', 'CREDIT_NOTE', 'PAYMENT');

-- CreateTable
CREATE TABLE "NumberingSequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "docType" "DocumentNumberType" NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NumberingSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NumberingSequence_tenantId_idx" ON "NumberingSequence"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NumberingSequence_tenantId_docType_key" ON "NumberingSequence"("tenantId", "docType");
