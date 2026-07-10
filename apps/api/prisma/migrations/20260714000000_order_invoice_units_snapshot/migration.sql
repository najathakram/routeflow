-- Order/Invoice box-size snapshot + invoice→order-line provenance.
--
-- Purely additive. Adds three nullable columns and one FK; touches no existing
-- value except a best-effort backfill of unitsPerBox onto lines that already
-- carry a box/piece split (boxes IS NOT NULL). Existing rows without a split keep
-- unitsPerBox NULL, and all reads fall back to the live product for legacy rows.
--
--  * OrderItem.unitsPerBox   — sale-time box size; boxed math must use this, not
--                              the live product (a later packaging change must
--                              not re-interpret past lines).
--  * InvoiceItem.unitsPerBox — same snapshot carried onto the invoice line.
--  * InvoiceItem.orderItemId — the order line this invoice line was billed from;
--                              SetNull so an order-line hard-delete never blocks.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "unitsPerBox" INTEGER;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN "unitsPerBox" INTEGER;
ALTER TABLE "InvoiceItem" ADD COLUMN "orderItemId" TEXT;

-- CreateIndex
CREATE INDEX "InvoiceItem_orderItemId_idx" ON "InvoiceItem"("orderItemId");

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill unitsPerBox from the live product, ONLY for lines that already carry a
-- box/piece split. Selling-unit lines (boxes IS NULL) are intentionally left NULL
-- so no consumer misreads their qty as pieces.
UPDATE "OrderItem" oi
SET "unitsPerBox" = p."unitsPerBox"
FROM "Product" p
WHERE oi."productId" = p."id"
  AND oi."boxes" IS NOT NULL
  AND p."unitsPerBox" IS NOT NULL;

UPDATE "InvoiceItem" ii
SET "unitsPerBox" = p."unitsPerBox"
FROM "Product" p
WHERE ii."productId" = p."id"
  AND ii."boxes" IS NOT NULL
  AND p."unitsPerBox" IS NOT NULL;
