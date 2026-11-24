-- SA-1215 set 3 (P-85): PO receipts. Migration only: two new tables and one nullable column. Nothing reads or writes any of it yet.
--   "PurchaseOrderReceipt"      header of one receiving event. "tenantId" NOT NULL from day one. FKs: "Tenant" RESTRICT, "PurchaseOrder"
--                               CASCADE (the PO aggregate cascades as one), "User" SET NULL (receiver), self "reversesReceiptId" RESTRICT.
--   "PurchaseOrderReceiptLine"  one line per PO item per receipt. FKs: "Tenant" RESTRICT, header CASCADE, "PurchaseOrderItem" CASCADE.
--   "StockMovement"."receiptLineId" TEXT NULL, FK to the receipt line ON DELETE SET NULL (added NOT VALID, then VALIDATE: every value is
--                               NULL, so the validate scan writes nothing). No default, no backfill. NO index on "StockMovement" in this
--                               set: an index there is the one lock risk and no reader needs it yet (LATER, CREATE INDEX CONCURRENTLY, own file).
--   CHECKs (raw SQL; Prisma does not model them):
--     "PurchaseOrderReceipt_key_hash_pair"      ("idempotencyKey" IS NULL) = ("requestHash" IS NULL)
--     "PurchaseOrderReceipt_not_self"           "reversesReceiptId" <> "id"
--     "PurchaseOrderReceipt_reversal_keyless"   a reversal carries no idempotency key
--     "PurchaseOrderReceiptLine_qty_sign"       non-zero, one sign, |damaged| <= |arriving|
--   Unique: ("tenantId","idempotencyKey") (Postgres lets several NULLs through); "reversesReceiptId" (one reversal per receipt).
--
-- Additive only: new empty tables, one nullable column (metadata-only ADD COLUMN, no rewrite). Nothing dropped, rewritten or backfilled.
-- LOCK PROFILE: ONE transaction. A brief ACCESS EXCLUSIVE on "StockMovement" for the ADD COLUMN, then SHARE ROW EXCLUSIVE on "Tenant",
-- "PurchaseOrder", "PurchaseOrderItem", "User" and "StockMovement" for the foreign keys; the new tables are empty, so their FKs and CHECKs
-- validate nothing. `SET LOCAL lock_timeout = '5s'` bounds every wait; a timeout rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261124000100_po_receipts` from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): the generated client selects "StockMovement"."receiptLineId" on every stock movement read, so merge only after the
-- owner sitting: fresh backup, `prod-migrate.mjs`, `schema-drift.mjs` exit 0, THEN merge.
-- Rollback (nothing references the objects yet):
--   ALTER TABLE "StockMovement" DROP COLUMN "receiptLineId"; DROP TABLE "PurchaseOrderReceiptLine"; DROP TABLE "PurchaseOrderReceipt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "receiptLineId" TEXT;

-- CreateTable
CREATE TABLE "PurchaseOrderReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "vendorReference" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "result" JSONB,
    "reversesReceiptId" TEXT,

    CONSTRAINT "PurchaseOrderReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderReceipt_key_hash_pair" CHECK (("idempotencyKey" IS NULL) = ("requestHash" IS NULL)),
    CONSTRAINT "PurchaseOrderReceipt_not_self" CHECK ("reversesReceiptId" <> "id"),
    CONSTRAINT "PurchaseOrderReceipt_reversal_keyless" CHECK ("reversesReceiptId" IS NULL OR "idempotencyKey" IS NULL)
);

-- CreateTable
CREATE TABLE "PurchaseOrderReceiptLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "qtyArriving" DECIMAL(10,3) NOT NULL,
    "qtyDamaged" DECIMAL(10,3) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderReceiptLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderReceiptLine_qty_sign" CHECK ("qtyArriving" <> 0 AND (("qtyArriving" > 0 AND "qtyDamaged" >= 0 AND "qtyDamaged" <= "qtyArriving") OR ("qtyArriving" < 0 AND "qtyDamaged" <= 0 AND "qtyDamaged" >= "qtyArriving")))
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderReceipt_reversesReceiptId_key" ON "PurchaseOrderReceipt"("reversesReceiptId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceipt_tenantId_poId_idx" ON "PurchaseOrderReceipt"("tenantId", "poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceipt_poId_idx" ON "PurchaseOrderReceipt"("poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceipt_receivedById_idx" ON "PurchaseOrderReceipt"("receivedById");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderReceipt_tenantId_idempotencyKey_key" ON "PurchaseOrderReceipt"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceiptLine_purchaseOrderItemId_idx" ON "PurchaseOrderReceiptLine"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceiptLine_tenantId_idx" ON "PurchaseOrderReceiptLine"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderReceiptLine_receiptId_purchaseOrderItemId_key" ON "PurchaseOrderReceiptLine"("receiptId", "purchaseOrderItemId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "PurchaseOrderReceiptLine"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- ValidateForeignKey (every value is NULL, so the scan writes nothing)
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "StockMovement_receiptLineId_fkey";

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceipt" ADD CONSTRAINT "PurchaseOrderReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceipt" ADD CONSTRAINT "PurchaseOrderReceipt_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceipt" ADD CONSTRAINT "PurchaseOrderReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceipt" ADD CONSTRAINT "PurchaseOrderReceipt_reversesReceiptId_fkey" FOREIGN KEY ("reversesReceiptId") REFERENCES "PurchaseOrderReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PurchaseOrderReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
