-- #2717 M2 (SA-572 A4) — recipes: one new enum, two new tables, one new Product column.
-- Purely additive. "Product"."familyPriceOverride" is a constant-defaulted NOT NULL ADD COLUMN
-- (metadata-only on Postgres 11+, no table rewrite); it still takes a brief ACCESS EXCLUSIVE lock,
-- bounded by lock_timeout below (SET LOCAL: scoped to this migration's transaction). If the wait
-- exceeds 5s the migration rolls back and is recorded FAILED — recover with
--   prisma migrate resolve --rolled-back 20260929120000_2717_m2_recipes
-- from apps/api, then re-run. NEVER `--applied`.
--
-- The four new FKs point FROM the new "Recipe"/"RecipeComponent" tables (two tables that start
-- empty), so they take only a SHARE ROW EXCLUSIVE lock on "Product" and validate zero rows.
-- "Recipe_activeFor_key" is a plain nullable UNIQUE (NULLs never collide): one ACTIVE recipe per
-- recipe product without a partial index.
--
-- Rollback (no data outside these tables/columns is touched):
--   DROP TABLE "RecipeComponent";
--   DROP TABLE "Recipe";
--   ALTER TABLE "Product" DROP COLUMN "familyPriceOverride";
--   DROP TYPE "RecipeStatus";
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "RecipeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "familyPriceOverride" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "familyProductId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "unitsPerPack" INTEGER NOT NULL,
    "status" "RecipeStatus" NOT NULL DEFAULT 'DRAFT',
    "activeFor" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "componentProductId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recipe_tenantId_idx" ON "Recipe"("tenantId");

-- CreateIndex
CREATE INDEX "Recipe_familyProductId_idx" ON "Recipe"("familyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_productId_version_key" ON "Recipe"("productId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_activeFor_key" ON "Recipe"("activeFor");

-- CreateIndex
CREATE INDEX "RecipeComponent_componentProductId_idx" ON "RecipeComponent"("componentProductId");

-- CreateIndex
CREATE INDEX "RecipeComponent_tenantId_idx" ON "RecipeComponent"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeComponent_recipeId_componentProductId_key" ON "RecipeComponent"("recipeId", "componentProductId");

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_familyProductId_fkey" FOREIGN KEY ("familyProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeComponent" ADD CONSTRAINT "RecipeComponent_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeComponent" ADD CONSTRAINT "RecipeComponent_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
