-- SA-138 policy layer phase 1 (PR-A): per-tenant POLICY values (PolicyValue + PolicyScopeType).
-- Additive only — one new enum + one new table + two indexes + one FK; no drops, no backfill, no
-- change to any existing table. Nothing reads or writes this table until the tenant admin sets a
-- policy (no production call site reads a policy in phase 1).
--
-- Append-only by design: one ACTIVE row per (tenantId, key, scopeType, scopeId) is kept by the
-- `policy-write` advisory lock in PolicyService (Prisma cannot express that partial unique index),
-- and the resolver tie-breaks on the newest createdAt.
--
-- Prod: the owner applies this BEFORE merge (L-184) via
-- `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`, then the drift gate.
-- Rollback (instant, the table is new and unread): DROP TABLE "PolicyValue"; DROP TYPE "PolicyScopeType";

-- CreateEnum
CREATE TYPE "PolicyScopeType" AS ENUM ('TENANT', 'CATEGORY', 'CUSTOMER');

-- CreateTable
CREATE TABLE "PolicyValue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scopeType" "PolicyScopeType" NOT NULL,
    "scopeId" TEXT,
    "value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "setById" TEXT,
    "setByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,

    CONSTRAINT "PolicyValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyValue_tenantId_key_scopeType_scopeId_supersededAt_idx" ON "PolicyValue"("tenantId", "key", "scopeType", "scopeId", "supersededAt");

-- CreateIndex
CREATE INDEX "PolicyValue_tenantId_idx" ON "PolicyValue"("tenantId");

-- AddForeignKey
ALTER TABLE "PolicyValue" ADD CONSTRAINT "PolicyValue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

