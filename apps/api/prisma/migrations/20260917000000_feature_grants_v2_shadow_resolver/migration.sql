-- Feature grants v2, PR-0a (brief A) + PR-3 (brief B) schema, design 2026-09-17 §2.
-- Additive only: two new enums, two new tables, one new column with a DEFAULT on an
-- existing table (#795's TenantFeatureOverride) — no drops, no backfill. Named with a
-- later timestamp than #795's own 20260916050000_tenant_feature_override; the two
-- migrations are independent and apply in either order relative to each other.

-- CreateEnum
CREATE TYPE "FeatureOverrideKind" AS ENUM ('PILOT', 'SUPPORT', 'COMP', 'TRIAL', 'GRANDFATHER');

-- CreateEnum
CREATE TYPE "FeatureSource" AS ENUM ('OVERRIDE_DENY', 'OVERRIDE_GRANT', 'ADDON_SKU', 'PRESET', 'NONE', 'UNKNOWN');

-- AlterTable: PR-3 override kind, DEFAULT 'COMP' for #795's existing rows and any caller
-- that doesn't set one explicitly.
ALTER TABLE "TenantFeatureOverride" ADD COLUMN "kind" "FeatureOverrideKind" NOT NULL DEFAULT 'COMP';

-- CreateTable
CREATE TABLE "FeatureResolverDiff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "before" BOOLEAN NOT NULL,
    "after" BOOLEAN NOT NULL,
    "source" "FeatureSource" NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,
    "explainedAt" TIMESTAMP(3),
    "explanation" TEXT,

    CONSTRAINT "FeatureResolverDiff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureResolverDiff_tenantId_featureKey_before_after_key" ON "FeatureResolverDiff"("tenantId", "featureKey", "before", "after");

-- CreateIndex
CREATE INDEX "FeatureResolverDiff_tenantId_idx" ON "FeatureResolverDiff"("tenantId");

-- CreateIndex
CREATE INDEX "FeatureResolverDiff_explainedAt_idx" ON "FeatureResolverDiff"("explainedAt");

-- AddForeignKey
ALTER TABLE "FeatureResolverDiff" ADD CONSTRAINT "FeatureResolverDiff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TenantFeatureConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "settings" JSONB,
    "reason" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantFeatureConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantFeatureConfig_tenantId_featureKey_key" ON "TenantFeatureConfig"("tenantId", "featureKey");

-- CreateIndex
CREATE INDEX "TenantFeatureConfig_tenantId_idx" ON "TenantFeatureConfig"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantFeatureConfig" ADD CONSTRAINT "TenantFeatureConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
