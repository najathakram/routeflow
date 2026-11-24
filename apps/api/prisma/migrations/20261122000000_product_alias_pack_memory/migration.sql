-- SA-1207 S1 (alias pack memory, migration only; plan 5.4, SA-1207 A1 rules 4 and the case table): three nullable columns on
-- "ProductAlias" plus one CHECK, nothing else. Nothing reads or writes them until S2a.
--   "packSize"      INTEGER NULL  pieces in ONE supplier unit as the supplier bills this text (null = never answered)
--   "splitFamilyId" TEXT NULL     the family this text is spread across (plain pointer, no FK, like the model's other pointers)
--   "splitRecipe"   JSONB NULL    remembered mix for ONE supplier unit, [{ productId, pieces }]
--   CHECK "ProductAlias_packSize_positive": "packSize" IS NULL OR "packSize" > 0 (raw SQL, Prisma does not model it).
-- Additive: metadata-only ADD COLUMN (no default, no rewrite, no backfill). The CHECK is added NOT VALID and then validated;
-- every existing row is NULL so validation cannot fail.
-- LOCK PROFILE: ONE transaction; a brief ACCESS EXCLUSIVE on "ProductAlias" for the ADD COLUMNs and the CHECK, then a
-- SHARE UPDATE EXCLUSIVE scan for VALIDATE. `SET LOCAL lock_timeout = '5s'` bounds each wait; a timeout rolls the whole file
-- back (recorded FAILED; recover with `prisma migrate resolve --rolled-back 20261122000000_product_alias_pack_memory`
-- from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): the generated client selects these columns on every "ProductAlias" read, so merge only after the
-- owner sitting: fresh backup, `prod-migrate.mjs`, `schema-drift.mjs` exit 0, THEN merge.
-- Rollback: ALTER TABLE "ProductAlias" DROP CONSTRAINT "ProductAlias_packSize_positive", DROP COLUMN "packSize",
--   DROP COLUMN "splitFamilyId", DROP COLUMN "splitRecipe";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ProductAlias" ADD COLUMN     "packSize" INTEGER,
ADD COLUMN     "splitFamilyId" TEXT,
ADD COLUMN     "splitRecipe" JSONB;

-- Raw-SQL CHECK: a pack answer is a positive number of pieces.
ALTER TABLE "ProductAlias" ADD CONSTRAINT "ProductAlias_packSize_positive" CHECK ("packSize" IS NULL OR "packSize" > 0) NOT VALID;
ALTER TABLE "ProductAlias" VALIDATE CONSTRAINT "ProductAlias_packSize_positive";

COMMIT;
