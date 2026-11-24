-- SA-1215 set 4 (P-85): PO charges. Migration only: two enums and two new tables. Nothing reads or writes any of it yet.
--   "PurchaseOrderChargeKind"        ESTIMATE | ACTUAL
--   "PurchaseOrderChargeBasis"       VALUE | QUANTITY
--   "PurchaseOrderCharge"            a document row on the PO (freight, duty); writes no stock movement. "tenantId" NOT NULL. FKs: "Tenant"
--                                    RESTRICT, "PurchaseOrder" CASCADE, "VendorBill" RESTRICT (never VendorBill.purchaseOrderId), "User" SET NULL
--                                    (voided by, created by), self "reversesChargeId" RESTRICT. No receiptLineId and no postedMovementId (SA-1215).
--   "PurchaseOrderChargeAllocation"  one share of a charge per PO item. FKs: "Tenant" RESTRICT, charge CASCADE, "PurchaseOrderItem" CASCADE.
--   CHECKs (raw SQL; Prisma does not model them):
--     "PurchaseOrderCharge_actual_has_bill"   ("kind" = 'ACTUAL') = ("vendorBillId" IS NOT NULL)
--     "PurchaseOrderCharge_amount_pos"        "amount" > 0
--     "PurchaseOrderCharge_tax_nonneg"        "taxAmount" >= 0
--     "PurchaseOrderCharge_not_self"          "reversesChargeId" <> "id"
--     "PurchaseOrderChargeAllocation_amount_nonneg"  "amount" >= 0
--     SA-816 (d)1 NaN guards, one per NUMERIC column (Postgres sorts NaN above every number, so the sign CHECKs above let it through):
--     "PurchaseOrderCharge_amount_not_nan", "PurchaseOrderCharge_taxAmount_not_nan", "PurchaseOrderChargeAllocation_amount_not_nan"
--     each CHECK ("<col>" <> 'NaN'::numeric), as ALTER TABLE ... ADD CONSTRAINT right after CREATE TABLE (the tables are new and empty, so nothing is scanned).
--   Unique: "reversesChargeId"; ("chargeId","purchaseOrderItemId").
--
-- Additive only: new enums and new empty tables; no existing table is touched. No default that changes behaviour, no backfill.
-- LOCK PROFILE: ONE transaction. SHARE ROW EXCLUSIVE on "Tenant", "PurchaseOrder", "PurchaseOrderItem", "VendorBill" and "User" for the foreign
-- keys of the empty new tables; no scan of an existing row. `SET LOCAL lock_timeout = '5s'` bounds every wait; a timeout rolls the whole
-- file back (recorded FAILED; recover with `prisma migrate resolve --rolled-back 20261124000200_po_charges` from apps/api, then re-run; NEVER
-- `--applied`). No existing table gains a column; the sitting still runs it before any code that uses it.
-- Rollback (nothing references the objects yet):
--   DROP TABLE "PurchaseOrderChargeAllocation"; DROP TABLE "PurchaseOrderCharge"; DROP TYPE "PurchaseOrderChargeBasis"; DROP TYPE "PurchaseOrderChargeKind";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "PurchaseOrderChargeKind" AS ENUM ('ESTIMATE', 'ACTUAL');

-- CreateEnum
CREATE TYPE "PurchaseOrderChargeBasis" AS ENUM ('VALUE', 'QUANTITY');

-- CreateTable
CREATE TABLE "PurchaseOrderCharge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "vendorBillId" TEXT,
    "kind" "PurchaseOrderChargeKind" NOT NULL,
    "basis" "PurchaseOrderChargeBasis" NOT NULL DEFAULT 'VALUE',
    "label" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversesChargeId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderCharge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderCharge_actual_has_bill" CHECK (("kind" = 'ACTUAL') = ("vendorBillId" IS NOT NULL)),
    CONSTRAINT "PurchaseOrderCharge_amount_pos" CHECK ("amount" > 0),
    CONSTRAINT "PurchaseOrderCharge_tax_nonneg" CHECK ("taxAmount" >= 0),
    CONSTRAINT "PurchaseOrderCharge_not_self" CHECK ("reversesChargeId" <> "id")
);

-- SA-816 (d)1: NaN guards (the sign CHECKs let NaN through); the table is new and empty, so nothing is scanned
ALTER TABLE "PurchaseOrderCharge"
  ADD CONSTRAINT "PurchaseOrderCharge_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric),
  ADD CONSTRAINT "PurchaseOrderCharge_taxAmount_not_nan" CHECK ("taxAmount" <> 'NaN'::numeric);

-- CreateTable
CREATE TABLE "PurchaseOrderChargeAllocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "PurchaseOrderChargeAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderChargeAllocation_amount_nonneg" CHECK ("amount" >= 0)
);

-- SA-816 (d)1: NaN guards (the sign CHECKs let NaN through); the table is new and empty, so nothing is scanned
ALTER TABLE "PurchaseOrderChargeAllocation"
  ADD CONSTRAINT "PurchaseOrderChargeAllocation_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderCharge_reversesChargeId_key" ON "PurchaseOrderCharge"("reversesChargeId");

-- CreateIndex
CREATE INDEX "PurchaseOrderCharge_tenantId_poId_idx" ON "PurchaseOrderCharge"("tenantId", "poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderCharge_poId_idx" ON "PurchaseOrderCharge"("poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderCharge_vendorBillId_idx" ON "PurchaseOrderCharge"("vendorBillId");

-- CreateIndex
CREATE INDEX "PurchaseOrderCharge_voidedById_idx" ON "PurchaseOrderCharge"("voidedById");

-- CreateIndex
CREATE INDEX "PurchaseOrderCharge_createdById_idx" ON "PurchaseOrderCharge"("createdById");

-- CreateIndex
CREATE INDEX "PurchaseOrderChargeAllocation_purchaseOrderItemId_idx" ON "PurchaseOrderChargeAllocation"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "PurchaseOrderChargeAllocation_tenantId_idx" ON "PurchaseOrderChargeAllocation"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderChargeAllocation_chargeId_purchaseOrderItemId_key" ON "PurchaseOrderChargeAllocation"("chargeId", "purchaseOrderItemId");

-- AddForeignKey
ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_vendorBillId_fkey" FOREIGN KEY ("vendorBillId") REFERENCES "VendorBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_reversesChargeId_fkey" FOREIGN KEY ("reversesChargeId") REFERENCES "PurchaseOrderCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderCharge" ADD CONSTRAINT "PurchaseOrderCharge_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderChargeAllocation" ADD CONSTRAINT "PurchaseOrderChargeAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderChargeAllocation" ADD CONSTRAINT "PurchaseOrderChargeAllocation_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "PurchaseOrderCharge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderChargeAllocation" ADD CONSTRAINT "PurchaseOrderChargeAllocation_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
