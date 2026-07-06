-- Phase 4 (Regulated Items) — W1 schema foundation + tobacco→category backfill.
--
-- ADDITIVE + REVERSIBLE. Adds 4 new models, 6 enums, and nullable/defaulted
-- columns on Product/OrderItem/InvoiceItem/Invoice/Order/RouteRunStop. Nothing
-- is dropped, renamed, or truncated. `Product.isTobacco` is KEPT as a shadow
-- column for one release; this migration only reads it (backfill), never writes
-- or removes it. Apply to prod only via `railway run npx prisma migrate deploy`.
-- Rollback procedure: see ROLLBACK.md alongside this file (fully reversible;
-- isTobacco stays authoritative so a rollback is non-breaking).

-- CreateEnum
CREATE TYPE "TrackedCategoryTaxType" AS ENUM ('EXCISE_PER_UNIT', 'PERCENT_OF_SALE', 'PER_VOLUME', 'DEPOSIT_PER_CONTAINER', 'NONE');

-- CreateEnum
CREATE TYPE "InvoiceTreatment" AS ENUM ('SEPARATE_INVOICE', 'SEPARATE_SECTION', 'LINE_TAX');

-- CreateEnum
CREATE TYPE "ReportCadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('NONE', 'PENDING_REVIEW', 'VERIFIED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuthorizationSource" AS ENUM ('RETAILER_SUBMITTED', 'WHOLESALER_ADDED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SALE', 'REVERSAL');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "trackedCategoryId" TEXT;

-- AlterTable
ALTER TABLE "RouteRunStop" ADD COLUMN     "ageCheckRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identityCheckRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "hasRegulated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "categoryTaxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "trackedCategoryId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "invoiceGroupId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "categoryTaxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "trackedCategoryId" TEXT;

-- CreateTable
CREATE TABLE "TrackedCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxType" "TrackedCategoryTaxType" NOT NULL DEFAULT 'NONE',
    "rate" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "unitBasis" TEXT,
    "priceIncludesTax" BOOLEAN NOT NULL DEFAULT false,
    "invoiceTreatment" "InvoiceTreatment" NOT NULL DEFAULT 'SEPARATE_INVOICE',
    "appliesScope" JSONB,
    "requiresLicense" BOOLEAN NOT NULL DEFAULT false,
    "reportTemplate" TEXT NOT NULL DEFAULT 'GENERIC',
    "reportCadence" "ReportCadence" NOT NULL DEFAULT 'MONTHLY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAuthorization" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "trackedCategoryId" TEXT NOT NULL,
    "status" "AuthorizationStatus" NOT NULL DEFAULT 'NONE',
    "source" "AuthorizationSource" NOT NULL DEFAULT 'WHOLESALER_ADDED',
    "licenseNumber" TEXT,
    "expiresAt" TIMESTAMP(3),
    "documentKey" TEXT,
    "verifiedById" TEXT,
    "verifiedByName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorizationOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "trackedCategoryId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "acknowledgedTenant" TEXT,
    "acceptedById" TEXT,
    "acceptedByName" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthorizationOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegulatedSalesLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trackedCategoryId" TEXT NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL DEFAULT 'SALE',
    "orderId" TEXT,
    "orderItemId" TEXT,
    "invoiceId" TEXT,
    "invoiceItemId" TEXT,
    "creditNoteId" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "unitBasisQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "netSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "categoryTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "soldAt" TIMESTAMP(3) NOT NULL,
    "periodBucket" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegulatedSalesLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedCategory_tenantId_idx" ON "TrackedCategory"("tenantId");

-- CreateIndex
CREATE INDEX "TrackedCategory_tenantId_active_idx" ON "TrackedCategory"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedCategory_tenantId_name_key" ON "TrackedCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "CustomerAuthorization_tenantId_idx" ON "CustomerAuthorization"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerAuthorization_customerId_idx" ON "CustomerAuthorization"("customerId");

-- CreateIndex
CREATE INDEX "CustomerAuthorization_trackedCategoryId_idx" ON "CustomerAuthorization"("trackedCategoryId");

-- CreateIndex
CREATE INDEX "CustomerAuthorization_status_idx" ON "CustomerAuthorization"("status");

-- CreateIndex
CREATE INDEX "CustomerAuthorization_expiresAt_idx" ON "CustomerAuthorization"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAuthorization_customerId_trackedCategoryId_key" ON "CustomerAuthorization"("customerId", "trackedCategoryId");

-- CreateIndex
CREATE INDEX "AuthorizationOverride_tenantId_idx" ON "AuthorizationOverride"("tenantId");

-- CreateIndex
CREATE INDEX "AuthorizationOverride_customerId_idx" ON "AuthorizationOverride"("customerId");

-- CreateIndex
CREATE INDEX "AuthorizationOverride_trackedCategoryId_idx" ON "AuthorizationOverride"("trackedCategoryId");

-- CreateIndex
CREATE INDEX "AuthorizationOverride_customerId_trackedCategoryId_idx" ON "AuthorizationOverride"("customerId", "trackedCategoryId");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_tenantId_idx" ON "RegulatedSalesLedger"("tenantId");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_trackedCategoryId_idx" ON "RegulatedSalesLedger"("trackedCategoryId");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_tenantId_trackedCategoryId_periodBucke_idx" ON "RegulatedSalesLedger"("tenantId", "trackedCategoryId", "periodBucket");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_invoiceId_idx" ON "RegulatedSalesLedger"("invoiceId");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_invoiceItemId_idx" ON "RegulatedSalesLedger"("invoiceItemId");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_orderItemId_idx" ON "RegulatedSalesLedger"("orderItemId");

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_creditNoteId_idx" ON "RegulatedSalesLedger"("creditNoteId");

-- CreateIndex
CREATE INDEX "Product_tenantId_trackedCategoryId_idx" ON "Product"("tenantId", "trackedCategoryId");

-- CreateIndex
CREATE INDEX "OrderItem_trackedCategoryId_idx" ON "OrderItem"("trackedCategoryId");

-- CreateIndex
CREATE INDEX "Invoice_invoiceGroupId_idx" ON "Invoice"("invoiceGroupId");

-- CreateIndex
CREATE INDEX "InvoiceItem_trackedCategoryId_idx" ON "InvoiceItem"("trackedCategoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedCategory" ADD CONSTRAINT "TrackedCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAuthorization" ADD CONSTRAINT "CustomerAuthorization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAuthorization" ADD CONSTRAINT "CustomerAuthorization_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAuthorization" ADD CONSTRAINT "CustomerAuthorization_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizationOverride" ADD CONSTRAINT "AuthorizationOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizationOverride" ADD CONSTRAINT "AuthorizationOverride_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizationOverride" ADD CONSTRAINT "AuthorizationOverride_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatedSalesLedger" ADD CONSTRAINT "RegulatedSalesLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatedSalesLedger" ADD CONSTRAINT "RegulatedSalesLedger_trackedCategoryId_fkey" FOREIGN KEY ("trackedCategoryId") REFERENCES "TrackedCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill (additive + idempotent): generalize the hardcoded tobacco flag into a
-- TrackedCategory. Tobacco becomes seed row #1 of the generic system. Re-runnable
-- (ON CONFLICT DO NOTHING + IS NULL / = false guards). Reads `isTobacco`; never
-- writes or drops it (kept as a shadow column for one release).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) One "Tobacco" category per tenant that currently sells tobacco.
--    taxType=NONE preserves today's warn-only behavior (no auto excise) until the
--    W3 calculator ships. requiresLicense=FALSE preserves today's exact behavior
--    (tobacco is warn-only, never blocked) — enabling the license requirement is
--    an explicit per-tenant decision wired in W2/W6, NOT an automatic flip. Every
--    seeded field is editable via the W2 CRUD. CA_CDTFA / MONTHLY mirror the
--    existing tobacco report. gen_random_uuid() is core in PostgreSQL 13+.
INSERT INTO "TrackedCategory" (
  "id", "tenantId", "name", "taxType", "rate", "unitBasis",
  "priceIncludesTax", "invoiceTreatment", "requiresLicense",
  "reportTemplate", "reportCadence", "active", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), t."tenantId", 'Tobacco', 'NONE', 0, 'pack',
  false, 'SEPARATE_INVOICE', false,
  'CA_CDTFA', 'MONTHLY', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "tenantId"
  FROM "Product"
  WHERE "isTobacco" = true AND "tenantId" IS NOT NULL
) t
ON CONFLICT ("tenantId", "name") DO NOTHING;

-- 2) Link each tenant's tobacco products to its Tobacco category.
UPDATE "Product" p
SET "trackedCategoryId" = tc."id"
FROM "TrackedCategory" tc
WHERE tc."tenantId" = p."tenantId"
  AND tc."name" = 'Tobacco'
  AND p."isTobacco" = true
  AND p."trackedCategoryId" IS NULL;

-- 3) Flag existing orders that contain a catalog tobacco line as regulated.
--    Uses a set-membership semi-join (better plan than a correlated EXISTS); the
--    INNER JOIN drops ad-hoc/unlisted lines (productId IS NULL). The
--    hasRegulated = false guard keeps it idempotent.
UPDATE "Order" o
SET "hasRegulated" = true
WHERE o."hasRegulated" = false
  AND o."id" IN (
    SELECT DISTINCT oi."orderId"
    FROM "OrderItem" oi
    JOIN "Product" pr ON pr."id" = oi."productId"
    WHERE pr."isTobacco" = true
  );
