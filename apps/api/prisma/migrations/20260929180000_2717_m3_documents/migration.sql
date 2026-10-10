-- #2717 M3 (SA-572, SA-579) - mixed-pack documents: one new enum, two new tables, three new columns on
-- each of "OrderItem" and "InvoiceItem". Purely additive.
--
-- The six ADD COLUMNs are nullable with no default (metadata-only on Postgres, no table rewrite); each
-- ALTER still takes a brief ACCESS EXCLUSIVE lock, bounded by lock_timeout below (SET LOCAL: scoped to
-- this migration's transaction). If the wait exceeds 5s the migration rolls back and is recorded FAILED -
-- recover with
--   prisma migrate resolve --rolled-back 20260929180000_2717_m3_documents
-- from apps/api, then re-run. NEVER `--applied`.
--
-- The new FKs point FROM the two new tables (which start empty) to "OrderItem", "InvoiceItem"
-- and "Product", so they take only a SHARE ROW EXCLUSIVE lock on the parents and
-- validate zero rows. "OrderItem"."recipeId" / "InvoiceItem"."recipeId" carry NO foreign key (I11:
-- documents never JOIN Recipe). Sum(component qty) = line pieces (I12) is enforced in the writing
-- transaction, never by a CHECK.
--
-- Rollback (no data outside these tables/columns is touched):
--   DROP TABLE "InvoiceItemComponent";
--   DROP TABLE "OrderItemComponent";
--   ALTER TABLE "InvoiceItem" DROP COLUMN "recipeVersion", DROP COLUMN "recipeId", DROP COLUMN "compositionMode";
--   ALTER TABLE "OrderItem" DROP COLUMN "recipeVersion", DROP COLUMN "recipeId", DROP COLUMN "compositionMode";
--   DROP TYPE "CompositionMode";
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "CompositionMode" AS ENUM ('SINGLE', 'FIXED', 'FLEX');

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "compositionMode" "CompositionMode",
ADD COLUMN     "recipeId" TEXT,
ADD COLUMN     "recipeVersion" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "compositionMode" "CompositionMode",
ADD COLUMN     "recipeId" TEXT,
ADD COLUMN     "recipeVersion" INTEGER;

-- CreateTable
CREATE TABLE "InvoiceItemComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceItemId" TEXT NOT NULL,
    "componentProductId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unitSku" TEXT,
    "unitBarcode" TEXT,
    "barcodeSymbology" "BarcodeSymbology",
    "displayUnitPrice4" DECIMAL(12,4),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceItemComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "componentProductId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "unitSku" TEXT,
    "unitBarcode" TEXT,
    "barcodeSymbology" "BarcodeSymbology",
    "displayUnitPrice4" DECIMAL(12,4),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItemComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceItemComponent_componentProductId_idx" ON "InvoiceItemComponent"("componentProductId");

-- CreateIndex
CREATE INDEX "InvoiceItemComponent_tenantId_idx" ON "InvoiceItemComponent"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceItemComponent_invoiceItemId_componentProductId_key" ON "InvoiceItemComponent"("invoiceItemId", "componentProductId");

-- CreateIndex
CREATE INDEX "OrderItemComponent_componentProductId_idx" ON "OrderItemComponent"("componentProductId");

-- CreateIndex
CREATE INDEX "OrderItemComponent_tenantId_idx" ON "OrderItemComponent"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemComponent_orderItemId_componentProductId_key" ON "OrderItemComponent"("orderItemId", "componentProductId");

-- AddForeignKey
ALTER TABLE "InvoiceItemComponent" ADD CONSTRAINT "InvoiceItemComponent_invoiceItemId_fkey" FOREIGN KEY ("invoiceItemId") REFERENCES "InvoiceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItemComponent" ADD CONSTRAINT "InvoiceItemComponent_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemComponent" ADD CONSTRAINT "OrderItemComponent_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemComponent" ADD CONSTRAINT "OrderItemComponent_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
