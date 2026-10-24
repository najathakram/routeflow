-- Row 509 (SA design gate 2026-10-14, option A): a selling restriction rule covers MANY products and/or labels
-- through "SellingRestrictionTarget". Additive: a new table, its CHECK and indexes, and an idempotent backfill of
-- one target per existing rule. The legacy "SellingRestriction"."productId" / "categoryId" columns and
-- "SellingRestriction_scope_xor" stay one release (rollback; SA conditions 1-3).
--
-- LOCK PROFILE: a NEW table, so its CREATE / CHECK / indexes lock nothing anyone waits on. The FKs take a
-- SHARE ROW EXCLUSIVE lock on "Tenant", "SellingRestriction", "Product" and "ProductCategory" for the instant of
-- their validation (an empty table validates at once). The backfill only READS "SellingRestriction".
-- `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that waits longer
-- than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and
-- ONLY THEN merge the code that reads the targets. After that code deploys, re-run the backfill INSERT below once
-- (it is idempotent) to sweep any rule a legacy-only writer created in between (SA condition 1).
--
-- Rollback:
--   DROP TABLE "SellingRestrictionTarget";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "SellingRestrictionTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" TEXT,
    "addedByName" TEXT,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "removedByName" TEXT,
    "removeReason" TEXT,

    CONSTRAINT "SellingRestrictionTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellingRestrictionTarget_ruleId_idx" ON "SellingRestrictionTarget"("ruleId");

-- AddForeignKey
ALTER TABLE "SellingRestrictionTarget" ADD CONSTRAINT "SellingRestrictionTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingRestrictionTarget" ADD CONSTRAINT "SellingRestrictionTarget_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SellingRestriction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingRestrictionTarget" ADD CONSTRAINT "SellingRestrictionTarget_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellingRestrictionTarget" ADD CONSTRAINT "SellingRestrictionTarget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Exactly one of productId / categoryId (Prisma can't express a column XOR).
ALTER TABLE "SellingRestrictionTarget" ADD CONSTRAINT "SellingRestrictionTarget_scope_xor"
  CHECK (("productId" IS NOT NULL) <> ("categoryId" IS NOT NULL));

-- One ACTIVE target per (rule, product) and per (rule, label); removed rows are history and may repeat.
-- Partial indexes are raw SQL (Prisma's DSL has no WHERE; precedent DemoBooking_startsAt_confirmed_key).
-- reason: a new, empty table; a plain CREATE INDEX holds no lock anyone waits on.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "SellingRestrictionTarget_rule_product_active_key"
  ON "SellingRestrictionTarget"("ruleId", "productId") WHERE "removedAt" IS NULL AND "productId" IS NOT NULL;
-- reason: a new, empty table.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "SellingRestrictionTarget_rule_category_active_key"
  ON "SellingRestrictionTarget"("ruleId", "categoryId") WHERE "removedAt" IS NULL AND "categoryId" IS NOT NULL;
-- reason: a new, empty table.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "SellingRestrictionTarget_tenant_product_active_idx"
  ON "SellingRestrictionTarget"("tenantId", "productId") WHERE "removedAt" IS NULL;
-- reason: a new, empty table.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "SellingRestrictionTarget_tenant_category_active_idx"
  ON "SellingRestrictionTarget"("tenantId", "categoryId") WHERE "removedAt" IS NULL;

-- Backfill (SA condition 3): one target per existing rule, from its legacy scope column, attributed like the
-- rule and dated LEAST(createdAt, effectiveFrom): a BACKDATED rule (effectiveFrom before createdAt) must never
-- read as ALLOW between its effectiveFrom and createdAt once the engine judges by target windows. Idempotent:
-- a rule that already has ANY target row is skipped, so the same statement can be re-run after the code deploys
-- to sweep rules old code wrote in between.
INSERT INTO "SellingRestrictionTarget"
  ("id", "tenantId", "ruleId", "productId", "categoryId", "addedAt", "addedById", "addedByName")
SELECT gen_random_uuid()::text, r."tenantId", r."id", r."productId", r."categoryId",
       LEAST(r."createdAt", r."effectiveFrom"), r."createdById", r."createdByName"
FROM "SellingRestriction" r
WHERE (r."productId" IS NOT NULL OR r."categoryId" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "SellingRestrictionTarget" t WHERE t."ruleId" = r."id");

COMMIT;
