-- Units rebuild P0a: tenant unit names and multi-level ladders. ADDITIVE ONLY: one new table
-- ("TenantUnit"), nullable columns with no default, indexes, and two nullable SET NULL foreign keys.
-- No data writes; the backfill is a separate later script.
--
-- LOCK PROFILE: ADD COLUMN of a nullable column without a default is metadata-only (no rewrite, no
-- scan). ACCESS EXCLUSIVE is held only for the catalog change; lock_timeout below bounds the wait
-- behind a long writer. The two FK adds on "ProductUnit"/"ProductBarcode" cover columns that are NULL
-- on every existing row, so the validation scan has nothing to check.
--
-- HARD DEPLOY ORDER (L-184): Prisma selects every scalar, so code that knows these columns merged
-- BEFORE they exist breaks reads (P2022). Owner sitting -> `prod-migrate.mjs` (fresh backup first) ->
-- `schema-drift.mjs` exit 0 -> ONLY THEN merge the PR that ships the code.
--
-- Rollback: drop the added columns, indexes and constraints, then DROP TABLE "TenantUnit" (nothing reads them yet).
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261008000000_units_p0a_tenant_units_ladders
-- from apps/api, then re-run. NEVER `--applied`.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "baseUnitLabel" TEXT,
ADD COLUMN     "invoiceLineCode" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "baseLabel" TEXT;

-- AlterTable
ALTER TABLE "ProductUnit" ADD COLUMN     "perParent" INTEGER,
ADD COLUMN     "retiredSku" TEXT,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "tenantUnitId" TEXT;

-- AlterTable
ALTER TABLE "ProductBarcode" ADD COLUMN     "productUnitId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "lineCode" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "CreditNoteItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "lineCode" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "EstimateItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "VendorBillItem" ADD COLUMN     "baseLabel" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "baseLabel" TEXT,
ADD COLUMN     "packLabel" TEXT;

-- CreateTable
CREATE TABLE "TenantUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "plural" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantUnit_tenantId_idx" ON "TenantUnit"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantUnit_tenantId_nameKey_key" ON "TenantUnit"("tenantId", "nameKey");

-- CreateIndex
CREATE INDEX "ProductUnit_tenantUnitId_idx" ON "ProductUnit"("tenantUnitId");

-- CreateIndex
CREATE INDEX "ProductUnit_tenantId_sku_idx" ON "ProductUnit"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "ProductBarcode_productUnitId_idx" ON "ProductBarcode"("productUnitId");

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_tenantUnitId_fkey" FOREIGN KEY ("tenantUnitId") REFERENCES "TenantUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantUnit" ADD CONSTRAINT "TenantUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_productUnitId_fkey" FOREIGN KEY ("productUnitId") REFERENCES "ProductUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
