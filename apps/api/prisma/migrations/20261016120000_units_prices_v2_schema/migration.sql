-- Units program S6 (PLAN specs/product-units-pricing §1.2; SA-795 (b), (g), (h)): the ONE additive schema folder of
-- the units/prices v2 program. Nothing reads or writes any of it yet; every value it adds equals today.
--   Product            packAuto INTEGER NOT NULL DEFAULT 0 + CHECK 0..31 (bit 0 = Retail/pricePerUnit, bits 1-4 =
--                      priceTier2-5; @routeflow/pricing PACK_AUTO_BITS); orderUnitRef TEXT NOT NULL DEFAULT 'pack';
--                      invoiceUnitRef TEXT
--   CustomerPrice      orderUnitRef, invoiceUnitRef (TEXT, nullable)
--   ProductTierUnit    NEW (tenantId, productId, tier 1..5, orderUnitRef, invoiceUnitRef), UNIQUE(productId, tier)
--   CustomerUnitPrice  NEW (tenantId, customerId, productId, unitRef, price DECIMAL(10,2) > 0),
--                      UNIQUE(customerId, productId, unitRef)
--   InvoiceItem, CreditNoteItem      invoiceUnitLabel TEXT, invoiceUnitFactor INTEGER (display-only snapshot, G1)
--   PurchaseOrderItem, VendorBillItem unitLabel, familyProductId (FK Product, ON DELETE SET NULL), familyGroupId (+ index)
-- Unit refs are "pack" | "base" | a ProductUnit.id (TEXT, no FK by design: a ref to a deleted unit is skipped).
--
-- BACKFILL: `orderUnitRef = 'pack'` on every existing product IS the constant column default. Since Postgres 11 an
-- ADD COLUMN with a non-volatile default is metadata-only: every existing row reads the default with no rewrite and
-- no UPDATE. packAuto likewise reads 0 on every row (every pack cell is "set", today). Fold A2 / M2 (tier copies ->
-- Auto bits) is a separate, owner-approved per-tenant DATA step, never this folder.
--
-- CHECKs are raw SQL (Prisma does not model them), so the schema and the drift gate are unaffected by them.
--
-- LOCK PROFILE: one transaction; `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT: a statement that waits longer
-- than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261016120000_units_prices_v2_schema` from apps/api, then re-run; NEVER
-- `--applied`).
--   * The six ALTER TABLE ... ADD COLUMN take a brief ACCESS EXCLUSIVE lock each; all are metadata-only.
--   * "Product_packAuto_range_chk" is added VALIDATED: it scans "Product" once while the ADD COLUMN's ACCESS
--     EXCLUSIVE lock is already held (every row is 0, so it cannot fail). NOT VALID + a later VALIDATE buys nothing
--     here: the lock is taken by the ADD COLUMN in the same transaction either way.
--   * The two familyGroupId indexes are built on POPULATED tables ("PurchaseOrderItem", "VendorBillItem"): each
--     build blocks writes to its table while it runs (all-NULL column, one sequential scan). Run off-peak; the PR
--     body carries the prod row counts.
--   * The two familyProductId FKs take SHARE ROW EXCLUSIVE on "Product" and the item table for their validation scan
--     (every value is NULL). The new tables are empty: their CREATE / CHECK / indexes / FKs lock nothing anyone
--     waits on beyond the FK targets' brief SHARE ROW EXCLUSIVE.
-- HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and ONLY
-- THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (instant: nothing reads these, every column is new):
--   DROP TABLE "CustomerUnitPrice"; DROP TABLE "ProductTierUnit";
--   ALTER TABLE "VendorBillItem" DROP COLUMN "familyGroupId", DROP COLUMN "familyProductId", DROP COLUMN "unitLabel";
--   ALTER TABLE "PurchaseOrderItem" DROP COLUMN "familyGroupId", DROP COLUMN "familyProductId", DROP COLUMN "unitLabel";
--   ALTER TABLE "CreditNoteItem" DROP COLUMN "invoiceUnitFactor", DROP COLUMN "invoiceUnitLabel";
--   ALTER TABLE "InvoiceItem" DROP COLUMN "invoiceUnitFactor", DROP COLUMN "invoiceUnitLabel";
--   ALTER TABLE "CustomerPrice" DROP COLUMN "invoiceUnitRef", DROP COLUMN "orderUnitRef";
--   ALTER TABLE "Product" DROP COLUMN "invoiceUnitRef", DROP COLUMN "orderUnitRef", DROP COLUMN "packAuto";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "invoiceUnitRef" TEXT,
ADD COLUMN     "orderUnitRef" TEXT NOT NULL DEFAULT 'pack',
ADD COLUMN     "packAuto" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "familyGroupId" TEXT,
ADD COLUMN     "familyProductId" TEXT,
ADD COLUMN     "unitLabel" TEXT;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "invoiceUnitFactor" INTEGER,
ADD COLUMN     "invoiceUnitLabel" TEXT;

-- AlterTable
ALTER TABLE "CreditNoteItem" ADD COLUMN     "invoiceUnitFactor" INTEGER,
ADD COLUMN     "invoiceUnitLabel" TEXT;

-- AlterTable
ALTER TABLE "VendorBillItem" ADD COLUMN     "familyGroupId" TEXT,
ADD COLUMN     "familyProductId" TEXT,
ADD COLUMN     "unitLabel" TEXT;

-- AlterTable
ALTER TABLE "CustomerPrice" ADD COLUMN     "invoiceUnitRef" TEXT,
ADD COLUMN     "orderUnitRef" TEXT;

-- CreateTable
CREATE TABLE "ProductTierUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "orderUnitRef" TEXT,
    "invoiceUnitRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTierUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerUnitPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitRef" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerUnitPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductTierUnit_tenantId_idx" ON "ProductTierUnit"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTierUnit_productId_tier_key" ON "ProductTierUnit"("productId", "tier");

-- CreateIndex
CREATE INDEX "CustomerUnitPrice_tenantId_idx" ON "CustomerUnitPrice"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerUnitPrice_productId_idx" ON "CustomerUnitPrice"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerUnitPrice_customerId_productId_unitRef_key" ON "CustomerUnitPrice"("customerId", "productId", "unitRef");

-- CreateIndex
-- reason: index on populated "PurchaseOrderItem" (all-NULL column): blocks its writes for the build; run off-peak, the PR body carries the prod row count
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "PurchaseOrderItem_familyGroupId_idx" ON "PurchaseOrderItem"("familyGroupId");

-- CreateIndex
-- reason: index on populated "VendorBillItem" (all-NULL column): blocks its writes for the build; run off-peak, the PR body carries the prod row count
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "VendorBillItem_familyGroupId_idx" ON "VendorBillItem"("familyGroupId");

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_familyProductId_fkey" FOREIGN KEY ("familyProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTierUnit" ADD CONSTRAINT "ProductTierUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTierUnit" ADD CONSTRAINT "ProductTierUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBillItem" ADD CONSTRAINT "VendorBillItem_familyProductId_fkey" FOREIGN KEY ("familyProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerUnitPrice" ADD CONSTRAINT "CustomerUnitPrice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerUnitPrice" ADD CONSTRAINT "CustomerUnitPrice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerUnitPrice" ADD CONSTRAINT "CustomerUnitPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw-SQL CHECKs (Prisma does not model CHECK constraints).
-- SA-795 (b): five bits, Retail then tiers 2-5.
ALTER TABLE "Product" ADD CONSTRAINT "Product_packAuto_range_chk" CHECK ("packAuto" BETWEEN 0 AND 31);
-- Tier 1 = Retail customers (a customer's tier is CustomerPrice.pricingTier ?? Customer.pricingTier ?? 1).
ALTER TABLE "ProductTierUnit" ADD CONSTRAINT "ProductTierUnit_tier_range_chk" CHECK ("tier" BETWEEN 1 AND 5);
-- PLAN P6: a set price is above $0.00; clearing a customer's unit price deletes the row (Auto).
ALTER TABLE "CustomerUnitPrice" ADD CONSTRAINT "CustomerUnitPrice_price_positive_chk" CHECK ("price" > 0);

COMMIT;
