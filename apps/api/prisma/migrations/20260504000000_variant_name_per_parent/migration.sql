-- Variant names should be unique per-parent, not globally per tenant.
--
-- BACKGROUND: PR #44 stopped baking the parent name into a variant's `name`
-- column (variants now store just the flavor, e.g. "Strawberry"). The old
-- `(tenantId, name)` UNIQUE blocked creating "Strawberry" as a variant of a
-- second parent because the constraint didn't know about parent scoping.
-- Replaces with two PARTIAL unique indexes — Prisma can't declare partial
-- uniqueness in schema.prisma so this is raw SQL.
--
-- After this migration:
--   - Two STANDALONE products in the same tenant cannot share a name.
--   - Two VARIANTS of the SAME parent in the same tenant cannot share a name.
--   - Variants of DIFFERENT parents (or one standalone + one variant) CAN
--     share a name — that's the whole point.
--
-- MIGRATION REQUIRED — DO NOT AUTO-APPLY; run manually against Railway prod
-- before the corresponding code deploy.

-- Drop the old global uniqueness on (tenantId, name).
ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_tenantId_name_key";
DROP INDEX IF EXISTS "Product_tenantId_name_key";

-- Standalone (root) products: tenant-wide unique name.
CREATE UNIQUE INDEX IF NOT EXISTS "Product_tenantId_name_root_key"
  ON "Product"("tenantId","name")
  WHERE "parentProductId" IS NULL;

-- Variants: unique name within their parent only.
CREATE UNIQUE INDEX IF NOT EXISTS "Product_tenantId_parent_name_key"
  ON "Product"("tenantId","parentProductId","name")
  WHERE "parentProductId" IS NOT NULL;
