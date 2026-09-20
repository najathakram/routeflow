-- Entitlement config survives downgrade -> re-upgrade (Lane B A2, owner ruling 2026-09-18).
-- Additive only: one enum, one new table, one index, one FK to Tenant. No backfill, no
-- existing row touched. Nothing writes to it until the (separate, flagged) service wiring lands.
-- Spec: local-assets/handoff/2026-09-19/SPEC-entitlement-snapshot-restore.md

-- CreateEnum
CREATE TYPE "SnapshotReason" AS ENUM ('DOWNGRADE', 'MANUAL');

-- CreateTable
CREATE TABLE "TenantFeatureConfigSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" "SnapshotReason" NOT NULL,
    "payload" JSONB NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "restoredToPlanKey" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,

    CONSTRAINT "TenantFeatureConfigSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantFeatureConfigSnapshot_tenantId_takenAt_idx" ON "TenantFeatureConfigSnapshot"("tenantId", "takenAt");

-- AddForeignKey
ALTER TABLE "TenantFeatureConfigSnapshot" ADD CONSTRAINT "TenantFeatureConfigSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

