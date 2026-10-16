-- Units program S6 (PLAN specs/product-units-pricing §1.2; SA-795 (b), (g), (h)): the ONE additive schema folder of
-- the units/prices v2 program. Nothing reads or writes any of it yet; every value it adds equals today.
--   Product            packAuto INTEGER NOT NULL DEFAULT 0 + CHECK 0..31 (bit 0 = Retail/pricePerUnit, bits 1-4 =
--                      priceTier2-5; @routeflow/pricing PACK_AUTO_BITS); orderUnitRef TEXT NOT NULL DEFAULT 'pack';
--                      invoiceUnitRef TEXT
--   CustomerPrice      orderUnitRef, invoiceUnitRef (TEXT, nullable)
--   ProductTierUnit    NEW (tenantId, productId, tier 1..5, orderUnitRef, invoiceUnitRef), UNIQUE(productId, tier)
--   CustomerUnitPrice  NEW (tenantId, customerId, productId, unitRef, price DECIMAL(10,2) > 0),
--                      UNIQUE(customerId, productId, unitRef)
--   InvoiceItem, CreditNoteItem      invoiceUnitLabel TEXT, invoiceUnitFactor INTEGER > 0 (display-only snapshot, G1)
--   PurchaseOrderItem, VendorBillItem unitLabel, familyProductId (FK Product, ON DELETE SET NULL; indexed),
--                                    familyGroupId (indexed)
-- Unit refs are "pack" | "base" | a ProductUnit.id (TEXT, no FK by design: a ref to a deleted unit is skipped).
--
-- BACKFILL: `orderUnitRef = 'pack'` on every existing product IS the constant column default. Since Postgres 11 an
-- ADD COLUMN with a non-volatile default is metadata-only: every existing row reads the default with no rewrite and
-- no UPDATE. packAuto likewise reads 0 on every row (every pack cell is "set", today). Fold A2 / M2 (tier copies ->
-- Auto bits) is a separate, owner-approved per-tenant DATA step, never this folder.
--
-- CHECKs are raw SQL (Prisma does not model them), so the schema and the drift gate are unaffected by them.
--
-- LOCK PROFILE: RUN THE WHOLE FILE OFF-PEAK. It is ONE transaction, and every lock it takes is held until COMMIT:
--   * ACCESS EXCLUSIVE (blocks READS and writes) on "Product", "CustomerPrice", "InvoiceItem", "CreditNoteItem",
--     "PurchaseOrderItem" and "VendorBillItem" from their ADD COLUMN to COMMIT. The ADD COLUMNs themselves are
--     metadata-only (constant defaults / nullable), but the validated packAuto CHECK scans "Product"
--     (the two invoiceUnitFactor CHECKs are NOT VALID: no scan of "InvoiceItem" / "CreditNoteItem"), the four new
--     indexes scan "PurchaseOrderItem" and "VendorBillItem", and the two familyProductId FKs scan those two
--     tables (all new values are 0 / 'pack' / NULL, so nothing can fail); the whole file waits on those scans.
--   * SHARE ROW EXCLUSIVE on "Tenant" and "Customer" for the new tables' FKs (the new tables are empty).
--   * `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT: with six tables to lock, the worst case is about 6 x 5s
--     of lock waits (~25-30s) during which queued readers of the tables already locked are blocked too, and a
--     deadlock with a live transaction is possible. Either way Postgres rolls the WHOLE file back (nothing is half
--     applied) and it is recorded FAILED: recover with
--     `prisma migrate resolve --rolled-back 20261016120000_units_prices_v2_schema` from apps/api, then re-run it
--     off-peak. NEVER `--applied`.
--
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
CREATE INDEX "PurchaseOrderItem_familyGroupId_idx" ON "PurchaseOrderItem"("familyGroupId");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_familyProductId_idx" ON "PurchaseOrderItem"("familyProductId");

-- CreateIndex
CREATE INDEX "VendorBillItem_familyGroupId_idx" ON "VendorBillItem"("familyGroupId");

-- CreateIndex
CREATE INDEX "VendorBillItem_familyProductId_idx" ON "VendorBillItem"("familyProductId");

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
-- Pieces per invoice unit: NULL = no snapshot (legacy line), otherwise at least one piece. NOT VALID: enforced for every
-- new or updated row from COMMIT, with no scan of the two largest tables (every existing value is NULL, so a later
-- `VALIDATE CONSTRAINT` in a following sitting's folder cannot fail).
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceUnitFactor_positive_chk" CHECK ("invoiceUnitFactor" IS NULL OR "invoiceUnitFactor" > 0) NOT VALID;
ALTER TABLE "CreditNoteItem" ADD CONSTRAINT "CreditNoteItem_invoiceUnitFactor_positive_chk" CHECK ("invoiceUnitFactor" IS NULL OR "invoiceUnitFactor" > 0) NOT VALID;

COMMIT;
