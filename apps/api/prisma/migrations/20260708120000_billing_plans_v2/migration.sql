-- Plans & Billing — plans-as-data foundation (Phase 1).
--
-- ADDITIVE ONLY. Adds 4 enums, 2 enum values each to TenantStatus/TenantPlan,
-- 6 new tables (PlanVersion/PlanDefinition/AddonSku/MeterUsage/BillingEvent/
-- RfInvoice), and nullable/defaulted columns on Tenant/TenantSubscription/
-- TenantAddon. Nothing is dropped, renamed, or truncated. The TenantPlan enum
-- stays a legacy SHADOW — all entitlement logic reads the new string `planKey`.
-- New enum values (TEAM/BUSINESS/READ_ONLY) are NOT used anywhere in this
-- migration (safe under PostgreSQL's in-transaction ADD VALUE rule; prod is PG16).
-- Apply to prod only via `railway run --service postgres node scripts/prod-migrate.mjs`.
-- Fully reversible (drop the new tables/columns/enum values); no data destroyed.

-- CreateEnum
CREATE TYPE "PlanVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "MeterKey" AS ENUM ('SEATS', 'ROUTES', 'SCANS', 'MSGS');

-- CreateEnum
CREATE TYPE "AddonUnit" AS ENUM ('FLAT', 'PER_USER', 'PER_ROUTE');

-- AlterEnum
ALTER TYPE "TenantStatus" ADD VALUE 'READ_ONLY';

-- AlterEnum
-- This migration adds more than one value to the TenantPlan enum. On PostgreSQL
-- 12+ (prod is PG16) multiple ADD VALUE statements run in one migration; the new
-- values are not referenced until a later migration/runtime write.
ALTER TYPE "TenantPlan" ADD VALUE 'TEAM';
ALTER TYPE "TenantPlan" ADD VALUE 'BUSINESS';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "planVersionId" TEXT,
ADD COLUMN     "readOnlyReason" TEXT;

-- AlterTable
ALTER TABLE "TenantSubscription" ADD COLUMN     "planVersionId" TEXT,
ADD COLUMN     "planKey" TEXT,
ADD COLUMN     "cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "basePriceSnapshot" DECIMAL(10,2),
ADD COLUMN     "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "downgradeToPlanKey" TEXT,
ADD COLUMN     "downgradeEffectiveAt" TIMESTAMP(3),
ADD COLUMN     "retainedUserIds" TEXT[],
ADD COLUMN     "graceStartedAt" TIMESTAMP(3),
ADD COLUMN     "graceMeter" "MeterKey",
ADD COLUMN     "trialConvertedAt" TIMESTAMP(3),
ADD COLUMN     "nextChargeAt" TIMESTAMP(3),
ADD COLUMN     "failedPaymentCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TenantAddon" ADD COLUMN     "sku" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "priceSnapshot" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanDefinition" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DECIMAL(10,2),
    "annualPrice" DECIMAL(10,2),
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "seatsIncluded" INTEGER,
    "routesConcurrent" INTEGER,
    "scansIncluded" INTEGER,
    "msgsIncluded" INTEGER NOT NULL DEFAULT 200,
    "featureFlags" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlanDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddonSku" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DECIMAL(10,2) NOT NULL,
    "unit" "AddonUnit" NOT NULL DEFAULT 'FLAT',
    "includedAtPlan" TEXT,
    "meteredKey" "MeterKey",
    "capacityPerUnit" INTEGER,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "grantsFlags" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AddonSku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meter" "MeterKey" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeterUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "amountDelta" DECIMAL(10,2),
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL,
    "cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "pdfKey" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tenant_planVersionId_idx" ON "Tenant"("planVersionId");

-- CreateIndex
CREATE INDEX "TenantSubscription_planVersionId_idx" ON "TenantSubscription"("planVersionId");

-- CreateIndex
CREATE INDEX "TenantSubscription_downgradeEffectiveAt_idx" ON "TenantSubscription"("downgradeEffectiveAt");

-- CreateIndex
CREATE INDEX "TenantAddon_tenantId_sku_idx" ON "TenantAddon"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_version_key" ON "PlanVersion"("version");

-- CreateIndex
CREATE INDEX "PlanVersion_status_idx" ON "PlanVersion"("status");

-- CreateIndex
CREATE INDEX "PlanDefinition_planVersionId_idx" ON "PlanDefinition"("planVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanDefinition_planVersionId_planKey_key" ON "PlanDefinition"("planVersionId", "planKey");

-- CreateIndex
CREATE INDEX "AddonSku_planVersionId_idx" ON "AddonSku"("planVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AddonSku_planVersionId_sku_key" ON "AddonSku"("planVersionId", "sku");

-- CreateIndex
CREATE INDEX "MeterUsage_tenantId_meter_idx" ON "MeterUsage"("tenantId", "meter");

-- CreateIndex
CREATE UNIQUE INDEX "MeterUsage_tenantId_meter_periodStart_key" ON "MeterUsage"("tenantId", "meter", "periodStart");

-- CreateIndex
CREATE INDEX "BillingEvent_tenantId_createdAt_idx" ON "BillingEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_type_idx" ON "BillingEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "RfInvoice_number_key" ON "RfInvoice"("number");

-- CreateIndex
CREATE INDEX "RfInvoice_tenantId_issuedAt_idx" ON "RfInvoice"("tenantId", "issuedAt");

-- CreateIndex
-- DB backstop for the "at most one PUBLISHED and one DRAFT catalog version"
-- invariants. Prisma can't express partial-unique indexes, so they live in raw SQL
-- (same technique as the Product partial indexes). The service layer also guards;
-- a concurrent publish/createDraft that loses the race surfaces a clean P2002 → 409.
CREATE UNIQUE INDEX "PlanVersion_one_published" ON "PlanVersion"("status") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "PlanVersion_one_draft" ON "PlanVersion"("status") WHERE "status" = 'DRAFT';

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanDefinition" ADD CONSTRAINT "PlanDefinition_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddonSku" ADD CONSTRAINT "AddonSku_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterUsage" ADD CONSTRAINT "MeterUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfInvoice" ADD CONSTRAINT "RfInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the initial PUBLISHED plan catalog (version 7) + backfill existing tenants.
-- Additive + idempotent (ON CONFLICT DO NOTHING + IS NULL guards) so it is safe to
-- re-run. Prices/caps/flags mirror docs/design-package/project/specs/pricing-plans.md.
-- The platform-admin Plans editor manages later versions (draft → publish).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Published catalog version 7.
INSERT INTO "PlanVersion" ("id", "version", "status", "effectiveAt", "publishedAt", "publishedBy", "notes", "createdAt", "updatedAt")
VALUES ('planver_v7', 7, 'PUBLISHED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'system', 'Initial published catalog (Plans & Billing launch)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("version") DO NOTHING;

-- 2) Plan definitions. Caps: null = unlimited. featureFlags = the gated keys the
--    plan grants (core capabilities are implicit; OCR is included on every plan,
--    only the scan meter differs).
INSERT INTO "PlanDefinition" ("id", "planVersionId", "planKey", "name", "monthlyPrice", "annualPrice", "isCustom", "seatsIncluded", "routesConcurrent", "scansIncluded", "msgsIncluded", "featureFlags", "sortOrder")
VALUES
  ('plandef_v7_starter', 'planver_v7', 'STARTER', 'Starter', 59.00, 590.00, false, 1, 1, 20, 200,
    ARRAY['addon.ocr']::TEXT[], 0),
  ('plandef_v7_team', 'planver_v7', 'TEAM', 'Team', 149.00, 1490.00, false, 5, 3, 100, 200,
    ARRAY['flag.dispatch_live','flag.returns','flag.ap_bills','flag.reports','flag.credit_limits','flag.settlement','addon.ocr']::TEXT[], 1),
  ('plandef_v7_business', 'planver_v7', 'BUSINESS', 'Business', 349.00, 3490.00, false, 15, NULL, 300, 200,
    ARRAY['flag.dispatch_live','flag.returns','flag.ap_bills','flag.reports','flag.credit_limits','flag.settlement','flag.pricing_tiers','flag.analytics','flag.forecasting','flag.import_integrations','addon.buyer_portal','addon.ocr']::TEXT[], 2),
  ('plandef_v7_enterprise', 'planver_v7', 'ENTERPRISE', 'Enterprise', NULL, NULL, true, NULL, NULL, NULL, 200,
    ARRAY['flag.dispatch_live','flag.returns','flag.ap_bills','flag.reports','flag.credit_limits','flag.settlement','flag.pricing_tiers','flag.analytics','flag.forecasting','flag.import_integrations','flag.api_sso','addon.buyer_portal','addon.regulated_items','addon.ocr']::TEXT[], 3)
ON CONFLICT ("planVersionId", "planKey") DO NOTHING;

-- 3) Add-on SKU catalog (7 SKUs). Capacity-adding SKUs carry meteredKey +
--    capacityPerUnit; flag-granting SKUs carry grantsFlags.
INSERT INTO "AddonSku" ("id", "planVersionId", "sku", "name", "monthlyPrice", "unit", "includedAtPlan", "meteredKey", "capacityPerUnit", "stackable", "grantsFlags", "sortOrder")
VALUES
  ('addonsku_v7_seat', 'planver_v7', 'SEAT_EXTRA', 'Extra seat', 12.00, 'PER_USER', NULL, 'SEATS', 1, true, ARRAY[]::TEXT[], 0),
  ('addonsku_v7_buyer', 'planver_v7', 'BUYER_PORTAL', 'Buyer portal', 49.00, 'FLAT', 'BUSINESS', NULL, NULL, false, ARRAY['addon.buyer_portal']::TEXT[], 1),
  ('addonsku_v7_regulated', 'planver_v7', 'REGULATED_ITEMS', 'Regulated-Items Compliance', 39.00, 'FLAT', 'ENTERPRISE', NULL, NULL, false, ARRAY['addon.regulated_items']::TEXT[], 2),
  ('addonsku_v7_ocr', 'planver_v7', 'OCR_PACK_250', 'OCR scan pack (+250)', 19.00, 'FLAT', NULL, 'SCANS', 250, true, ARRAY[]::TEXT[], 3),
  ('addonsku_v7_forecasting', 'planver_v7', 'FORECASTING', 'Analytics + forecasting', 19.00, 'FLAT', 'BUSINESS', NULL, NULL, false, ARRAY['flag.analytics','flag.forecasting']::TEXT[], 4),
  ('addonsku_v7_route', 'planver_v7', 'ROUTE_EXTRA', 'Extra concurrent route', 15.00, 'PER_ROUTE', NULL, 'ROUTES', 1, true, ARRAY[]::TEXT[], 5),
  ('addonsku_v7_msg', 'planver_v7', 'MSG_BUNDLE_500', 'Messaging bundle (+500)', 10.00, 'FLAT', NULL, 'MSGS', 500, true, ARRAY[]::TEXT[], 6)
ON CONFLICT ("planVersionId", "sku") DO NOTHING;

-- 4) Pin every existing tenant to the published version (entitlement source).
UPDATE "Tenant" SET "planVersionId" = 'planver_v7' WHERE "planVersionId" IS NULL;

-- 5) Backfill subscription.planKey from the legacy enum. STARTER→STARTER,
--    PROFESSIONAL→BUSINESS (human-confirmed: closest tier by feature set),
--    ENTERPRISE→ENTERPRISE. Reads only pre-existing enum values (never the new
--    TEAM/BUSINESS enum members) and writes a plain TEXT key.
UPDATE "TenantSubscription" SET
  "planVersionId" = 'planver_v7',
  "planKey" = CASE "currentPlan"
    WHEN 'STARTER' THEN 'STARTER'
    WHEN 'PROFESSIONAL' THEN 'BUSINESS'
    WHEN 'ENTERPRISE' THEN 'ENTERPRISE'
    ELSE 'STARTER'
  END
WHERE "planKey" IS NULL;
