-- #2717 M1 (#2728, SA-572/572a/572b/572c) — catalog barcodes by level, product images, packaging
-- levels. Purely additive: four new enums, two new tables, three new Product columns with
-- constant defaults / nullable, two nullable ProductUnit columns + a self FK. Nothing existing is
-- altered, backfilled or dropped; the backfill is a separate owner-run script.
--
-- "Product".kind/flexEnabled/flexStep and "ProductUnit".level/parentUnitId: nullable or
-- constant-defaulted ADD COLUMNs are metadata-only on Postgres 11+ (no table rewrite). They still
-- take a brief ACCESS EXCLUSIVE lock; lock_timeout below bounds the wait so a busy "Product" /
-- "ProductUnit" table can never queue readers behind it (SET LOCAL: scoped to this migration's
-- transaction, never leaking into the session). If the wait exceeds 5s the migration rolls back
-- and is recorded FAILED — recover with
--   prisma migrate resolve --rolled-back 20260928230000_2717_m1_catalog_barcodes_images
-- from apps/api, then re-run. NEVER `--applied`.
--
-- The three new FKs point FROM the new "ProductBarcode"/"ProductImage" tables and FROM
-- "ProductUnit" to itself (ON DELETE CASCADE / SET NULL), so they take only a SHARE ROW EXCLUSIVE
-- lock on "Product" / "ProductUnit" and validate zero rows.
--
-- Rollback (no data outside these tables/columns is touched):
--   DROP TABLE "ProductImage";
--   DROP TABLE "ProductBarcode";
--   ALTER TABLE "ProductUnit" DROP CONSTRAINT "ProductUnit_parentUnitId_fkey";
--   ALTER TABLE "ProductUnit" DROP COLUMN "parentUnitId";
--   ALTER TABLE "ProductUnit" DROP COLUMN "level";
--   ALTER TABLE "Product" DROP COLUMN "kind";
--   ALTER TABLE "Product" DROP COLUMN "flexStep";
--   ALTER TABLE "Product" DROP COLUMN "flexEnabled";
--   DROP TYPE "BarcodeOrigin";
--   DROP TYPE "BarcodeSymbology";
--   DROP TYPE "PackagingLevel";
--   DROP TYPE "ProductKind";
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('STANDARD', 'FAMILY', 'VARIANT', 'RECIPE');

-- CreateEnum
CREATE TYPE "PackagingLevel" AS ENUM ('UNIT', 'INNER', 'BOX', 'CASE', 'DISPLAY', 'PALLET');

-- CreateEnum
CREATE TYPE "BarcodeSymbology" AS ENUM ('UPC_A', 'UPC_E', 'EAN_8', 'EAN_13', 'GTIN_14', 'CODE128', 'OTHER');

-- CreateEnum
CREATE TYPE "BarcodeOrigin" AS ENUM ('ENTERED', 'COPIED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "flexEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flexStep" INTEGER,
ADD COLUMN     "kind" "ProductKind" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "ProductUnit" ADD COLUMN     "level" "PackagingLevel",
ADD COLUMN     "parentUnitId" TEXT;

-- CreateTable
CREATE TABLE "ProductBarcode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "symbology" "BarcodeSymbology" NOT NULL,
    "level" "PackagingLevel" NOT NULL,
    "origin" "BarcodeOrigin" NOT NULL DEFAULT 'ENTERED',
    "copiedFromLevel" "PackagingLevel",
    "primaryFor" "PackagingLevel",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT,
    "focalX" INTEGER,
    "focalY" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "altText" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductBarcode_productId_level_idx" ON "ProductBarcode"("productId", "level");

-- CreateIndex
CREATE INDEX "ProductBarcode_tenantId_code_idx" ON "ProductBarcode"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBarcode_tenantId_code_level_key" ON "ProductBarcode"("tenantId", "code", "level");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBarcode_productId_primaryFor_key" ON "ProductBarcode"("productId", "primaryFor");

-- CreateIndex
CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_tenantId_storageKey_key" ON "ProductImage"("tenantId", "storageKey");

-- AddForeignKey
ALTER TABLE "ProductUnit" ADD CONSTRAINT "ProductUnit_parentUnitId_fkey" FOREIGN KEY ("parentUnitId") REFERENCES "ProductUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
