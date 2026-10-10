-- Sitting-B schema bundle (SA-603 / 603a / 603b / 603c): ONE migration for the owner's second sitting.
--   1. "Product"."portalVisible" (spec 06: hide a product from the buyer portal): a constant-default
--      NOT NULL ADD COLUMN (metadata-only on Postgres 11+, no table rewrite).
--   2. Released-code columns: "Product"."retiredSku"/"retiredBarcode"/"retiredUnitSku" and
--      "ProductBarcode"."retiredCode" (nullable, no default), and "ProductBarcode"."code" DROP NOT NULL.
--      The app releases a deactivated product's codes into the retired* columns (the full uniques stay
--      exactly as they are; NO backfill: an inactive product keeps its codes until a create/update/
--      reactivate collides with it and releases them in the same transaction).
--   3. Product NAME uniqueness among ACTIVE products (SA-603b option i): DROP INDEX IF EXISTS on the two
--      prod-only all-rows partial uniques ("Product_tenantId_name_root_key",
--      "Product_tenantId_parent_name_key": names CONFIRMED by the owner's STEP 0 against prod, which
--      also recorded 0 active duplicate roots, 0 active duplicate variants) + two active-only partial
--      unique indexes. Raw SQL: Prisma cannot declare a partial unique index.
--   4. "EmailDelivery" (spec 08: the transactional-email log): 6-value status enum + table + 3 indexes +
--      a tenant FK (ON DELETE CASCADE); no subject/body column (PII minimal); contentFingerprint is a
--      SHA-256 hash, never content. Retention (90 days) is an app cron.
--   5. "PolicyValue" + "PolicyScopeType" (#1337 folded in, SA-603c): new, empty table, 2 indexes, a tenant FK.
--   6. "NotificationEvent" += STAFF_NEW_ORDER, BUYER_ORDER_EDITED, BUYER_ORDER_CANCELLED. ADD VALUE inside
--      the wrap is legal (PG >= 12); a value added in a transaction cannot be USED in it, and nothing here
--      uses them (only app code, after the commit).
--
-- LOCK PROFILE per table (every acquisition is bounded by lock_timeout below):
--   "Product":         the first ALTER TABLE takes ACCESS EXCLUSIVE and, because locks are held until COMMIT, it is
--                      HELD through the two partial unique index builds to the end of this transaction: reads AND
--                      writes on "Product" are blocked for the whole window. Expect about a second at today's
--                      catalog size (small keys, partial indexes); run off-peak. lock_timeout bounds only the wait
--                      to ACQUIRE each lock, not the time it is then held.
--   "ProductBarcode":  ADD COLUMN + DROP NOT NULL, metadata-only (ACCESS EXCLUSIVE, held to COMMIT).
--   "EmailDelivery", "PolicyValue": new and empty; the FKs take SHARE ROW EXCLUSIVE on "Tenant" (held to COMMIT).
--   "NotificationEvent": a lock on the type only, no table.
--
-- Everything is additive except the ONE DROP NOT NULL (reason below) and the two IF EXISTS index drops.
-- If a lock wait exceeds 5s the migration rolls back and is recorded FAILED: recover with
--   prisma migrate resolve --rolled-back 20260929220000_sitting_b_bundle
-- from apps/api, then re-run. NEVER `--applied`.
--
-- Pre-checks (read-only): the columns/tables/enums are absent, no failed migration is pending, and
-- "ProductBarcode"."code" is currently NOT NULL.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "PolicyScopeType" AS ENUM ('TENANT', 'CATEGORY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED', 'WOULD_SEND', 'OPTED_OUT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationEvent" ADD VALUE 'STAFF_NEW_ORDER';
ALTER TYPE "NotificationEvent" ADD VALUE 'BUYER_ORDER_EDITED';
ALTER TYPE "NotificationEvent" ADD VALUE 'BUYER_ORDER_CANCELLED';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "portalVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "retiredBarcode" TEXT,
ADD COLUMN     "retiredSku" TEXT,
ADD COLUMN     "retiredUnitSku" TEXT;

-- Product NAME uniqueness (SA-603b option i): make the name unique among ACTIVE products only, on
-- prod AND on fresh databases. Raw SQL: Prisma cannot declare a partial unique index (the schema keeps
-- @@index([tenantId, name])). The two DROPs remove the ALL-rows partial uniques that exist only on
-- prod (created 2026-05-04 by the migration folder 20260504000000_variant_name_per_parent, which is not
-- in this repo); their names below were CONFIRMED against prod by the owner's STEP 0. IF EXISTS makes the drops a no-op on a database that never had them; drop and
-- create sit in this ONE transaction so there is no window without a constraint. Both new indexes are
-- partial on small keys (ACCESS EXCLUSIVE on "Product" held to COMMIT: see the lock profile in the header).
-- Gates (SA-603b): the owner's count-only duplicate check returned 0 (STEP 0); F2's NO-DRIFT proof on fresh +
-- seeded DBs runs on the final sha; if it fails these four statements are removed and the name check stays app-only.
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
