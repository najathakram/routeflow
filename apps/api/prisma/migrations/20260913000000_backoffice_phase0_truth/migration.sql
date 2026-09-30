-- CreateEnum
CREATE TYPE "TenantClass" AS ENUM ('PRODUCTION', 'DEMO', 'TEST', 'INTERNAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TenantPlan" ADD VALUE 'GROWTH';
ALTER TYPE "TenantPlan" ADD VALUE 'SCALE';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "representsTenantId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "class" "TenantClass" NOT NULL DEFAULT 'PRODUCTION';

-- CreateIndex
CREATE UNIQUE INDEX "Customer_representsTenantId_key" ON "Customer"("representsTenantId");

-- CreateIndex
CREATE INDEX "Tenant_class_idx" ON "Tenant"("class");
