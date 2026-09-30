-- Sitting-B schema bundle (SA-603 / SA-603a): one migration for the owner's second sitting.
--   1. "Product"."portalVisible" (spec 06: hide a product from the buyer portal), a constant-default
--      NOT NULL ADD COLUMN (metadata-only on Postgres 11+, no table rewrite).
--   2. Released-code columns: "Product"."retiredSku"/"retiredBarcode"/"retiredUnitSku" and
--      "ProductBarcode"."retiredCode" (nullable, no default), and "ProductBarcode"."code" DROP NOT NULL.
--      The app releases a deactivated product's codes into the retired* columns (the full uniques stay
--      exactly as they are; NO partial index, NO backfill: an inactive product keeps its codes until a
--      create/update/reactivate collides with it and releases them in the same transaction).
--   2b. Product NAME uniqueness among ACTIVE products (two partial unique indexes, SA-603b; gated).
--   3. "EmailDelivery" (spec 08): the transactional-email log: new enum + table + 3 indexes + a tenant FK
--      (ON DELETE CASCADE); no subject/body column (PII minimal). Retention (90 days) is an app cron.
-- Purely additive except the single DROP NOT NULL above and the two prod-only index drops (IF EXISTS); every existing-table statement is metadata-only
-- (no index build on "Product" or "ProductBarcode"). Each ALTER takes a brief ACCESS EXCLUSIVE lock,
-- bounded by lock_timeout below (SET LOCAL: scoped to this migration's transaction). If the wait
-- exceeds 5s the migration rolls back and is recorded FAILED: recover with
--   prisma migrate resolve --rolled-back 20260929220000_sitting_b_bundle
-- from apps/api, then re-run. NEVER `--applied`.
--
-- Pre-checks (read-only): the columns/table/enum are absent, no failed migration is pending, and
-- "ProductBarcode"."code" is currently NOT NULL (see SA-603 / SA-603a).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "PolicyScopeType" AS ENUM ('TENANT', 'CATEGORY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED', 'WOULD_SEND', 'OPTED_OUT');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "portalVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "retiredBarcode" TEXT,
ADD COLUMN     "retiredSku" TEXT,
ADD COLUMN     "retiredUnitSku" TEXT;

-- Product NAME uniqueness (SA-603b option i): make the name unique among ACTIVE products only, on
-- prod AND on fresh databases. Raw SQL: Prisma cannot declare a partial unique index (the schema keeps
-- @@index([tenantId, name])). The two DROPs remove the ALL-rows partial uniques that exist only on
-- prod (created 2026-05-04 by the migration folder 20260504000000_variant_name_per_parent, which is not
-- in this repo); their names below come from that commit and MUST be confirmed by the owner's STEP 0
-- (SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Product' AND indexdef ILIKE '%name%')
-- before the sitting. IF EXISTS makes the drops a no-op on a database that never had them; drop and
-- create sit in this ONE transaction so there is no window without a constraint. Both new indexes are
-- partial on small keys (a SHARE lock on "Product" for about a second at today's catalog size).
-- GATED (SA-603b): executed NO-DRIFT proof on fresh + seeded DBs and a count-only duplicate check = 0;
-- if either fails these four statements are removed and the name check stays app-only.
DROP INDEX IF EXISTS "Product_tenantId_name_root_key";
DROP INDEX IF EXISTS "Product_tenantId_parent_name_key";
CREATE UNIQUE INDEX "Product_tenant_root_name_active_key" ON "Product"("tenantId", "name") WHERE "parentProductId" IS NULL AND "isActive";
CREATE UNIQUE INDEX "Product_tenant_parent_name_active_key" ON "Product"("tenantId", "parentProductId", "name") WHERE "parentProductId" IS NOT NULL AND "isActive";

-- AlterTable
-- reason: SA-603a: a released level code is NULL (retiredCode keeps it); NULLs are distinct under the
-- unique (tenantId, code, level), so a released row stops colliding. Metadata-only; the ONE DROP NOT NULL.
ALTER TABLE "ProductBarcode" ADD COLUMN     "retiredCode" TEXT,
ALTER COLUMN "code" DROP NOT NULL;

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

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentFingerprint" TEXT,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyValue_tenantId_key_scopeType_scopeId_supersededAt_idx" ON "PolicyValue"("tenantId", "key", "scopeType", "scopeId", "supersededAt");

-- CreateIndex
CREATE INDEX "PolicyValue_tenantId_idx" ON "PolicyValue"("tenantId");

-- CreateIndex
CREATE INDEX "EmailDelivery_tenantId_createdAt_idx" ON "EmailDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_entityType_entityId_idx" ON "EmailDelivery"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "EmailDelivery_providerMessageId_idx" ON "EmailDelivery"("providerMessageId");

-- AddForeignKey
ALTER TABLE "PolicyValue" ADD CONSTRAINT "PolicyValue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
