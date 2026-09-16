-- Feature grants PR-1: per-tenant entitlement overrides (TenantFeatureOverride).
-- Additive only — new enum + new table, no drops, no backfill. The partial unique
-- index below is hand-appended (Prisma DSL cannot express a WHERE-qualified unique
-- index) following the precedent in 20260901000000_add_sales_agents_commissions
-- (AgentAssignment_open_assignment_key).

-- CreateEnum
CREATE TYPE "FeatureOverrideEffect" AS ENUM ('GRANT', 'DENY');

-- CreateTable
CREATE TABLE "TenantFeatureOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "effect" "FeatureOverrideEffect" NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TenantFeatureOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantFeatureOverride_tenantId_featureKey_idx" ON "TenantFeatureOverride"("tenantId", "featureKey");

-- CreateIndex
CREATE INDEX "TenantFeatureOverride_featureKey_idx" ON "TenantFeatureOverride"("featureKey");

-- CreateIndex: partial unique — one non-revoked row per (tenantId, featureKey)
CREATE UNIQUE INDEX "TenantFeatureOverride_active_key"
  ON "TenantFeatureOverride"("tenantId", "featureKey")
  WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "TenantFeatureOverride" ADD CONSTRAINT "TenantFeatureOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
