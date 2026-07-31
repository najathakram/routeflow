-- NOTE for the human operator: repo .gitignore excludes *.sql; this file needs
-- `git add -f` (there is a `!apps/api/prisma/migrations/**/*.sql` negation rule,
-- but double-check `git status` picks this file up before committing).

-- Per-product regulatory reporting config; supersedes TrackedCategory.txItemType/txUom.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "regItemType" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "regUomCase"  TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "regUomUnit"  TEXT;

-- Saved custom report column layout per template.
ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "reportColumnPrefs" JSONB;

-- Backfill 1: products currently assigned to a TX section inherit its config.
-- regUomCase stays NULL deliberately — case-level reporting is per-product opt-in,
-- which is what makes the new bucketing reproduce today's report numbers exactly.
UPDATE "Product" p
SET "regItemType" = COALESCE(p."regItemType", tc."txItemType"::text),
    "regUomUnit"  = COALESCE(p."regUomUnit",  tc."txUom")
FROM "TrackedCategory" tc
WHERE p."trackedCategoryId" = tc."id"
  AND tc."reportTemplate" = 'TX_COMPTROLLER'
  AND (tc."txItemType" IS NOT NULL OR tc."txUom" IS NOT NULL);

-- Backfill 2: products since DETACHED from the section but with historic regulated
-- sales — their ledger rows still surface in ranged reports via the invoice-line
-- snapshot. COALESCE leaves Backfill 1 winners untouched.
UPDATE "Product" p
SET "regItemType" = COALESCE(p."regItemType", tc."txItemType"::text),
    "regUomUnit"  = COALESCE(p."regUomUnit",  tc."txUom")
FROM "TrackedCategory" tc
WHERE tc."reportTemplate" = 'TX_COMPTROLLER'
  AND (tc."txItemType" IS NOT NULL OR tc."txUom" IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM "InvoiceItem" ii
    WHERE ii."productId" = p."id" AND ii."trackedCategoryId" = tc."id"
  );
