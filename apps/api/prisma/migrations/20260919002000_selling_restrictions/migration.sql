-- Jurisdiction-based selling restrictions (2026-09-19) — additive only, zero
-- backfill. See local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md
-- §1.4 + owner rulings R1/R2. CustomerAddress.state / CustomerAuthorization
-- carry no default state value — NULL preserves today's meaning exactly
-- (unresolved ⇒ the restrictions resolver treats it as INDETERMINATE, never a
-- silently-assumed state). Lane 2's normalize-address-states.mjs script
-- (--dry-run|--apply) does the actual state-code backfill, run against prod
-- by the owner as its own gate — not part of this migration.

-- CreateEnum
CREATE TYPE "RestrictionJurisdiction" AS ENUM ('FEDERAL', 'STATE');

-- CreateEnum
CREATE TYPE "RestrictionSurface" AS ENUM ('ALL', 'BUYER_PORTAL');

-- AlterTable
ALTER TABLE "CustomerAddress" ADD COLUMN     "stateCode" CHAR(2),
ADD COLUMN     "stateNeedsReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CustomerAuthorization" ADD COLUMN     "premisesAddress" TEXT,
ADD COLUMN     "premisesState" CHAR(2);

-- CreateTable
CREATE TABLE "SellingRestriction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "productId" TEXT,
    "jurisdiction" "RestrictionJurisdiction" NOT NULL,
    "states" TEXT[],
    "surface" "RestrictionSurface" NOT NULL DEFAULT 'ALL',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedById" TEXT,
    "liftedByName" TEXT,
    "liftedAt" TIMESTAMP(3),
    "liftReason" TEXT,

    CONSTRAINT "SellingRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellingRestriction_tenantId_effectiveTo_idx" ON "SellingRestriction"("tenantId", "effectiveTo");

-- CreateIndex
CREATE INDEX "SellingRestriction_categoryId_idx" ON "SellingRestriction"("categoryId");

-- CreateIndex
CREATE INDEX "SellingRestriction_productId_idx" ON "SellingRestriction"("productId");

-- Prisma cannot express a column-level XOR check constraint, so this is raw
-- SQL. The table is new and empty, so this is a zero-risk validation add.
-- reason: exactly one of categoryId/productId must be set; enforced at the DB
-- reason: layer because every write path (app + any future script) must obey it
-- squawk-ignore require-concurrent-index-creation
ALTER TABLE "SellingRestriction" ADD CONSTRAINT "SellingRestriction_scope_xor"
  CHECK ((("categoryId" IS NULL) <> ("productId" IS NULL)));

-- AddForeignKey
ALTER TABLE "SellingRestriction" ADD CONSTRAINT "SellingRestriction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingRestriction" ADD CONSTRAINT "SellingRestriction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingRestriction" ADD CONSTRAINT "SellingRestriction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
