-- Variant opt-out pin (2026-09-20, Lane R step 4a). Additive only.
-- ProductCategoryLabel.parentProductIdAtWrite records the variant's CURRENT parent at the moment an
-- EXCLUDE (opt-out) was written, so an opt-out approved against one parent can never ride along to
-- another after a reparent. The selling-restrictions engine treats an EXCLUDE whose pin is null or is
-- not the variant's current parent as INERT (fail closed) — legacy rows are null by design: no backfill.
-- No default, no index, no constraint: nullable text, so this is a metadata-only ALTER (Squawk-clean).

-- AlterTable
ALTER TABLE "ProductCategoryLabel" ADD COLUMN "parentProductIdAtWrite" TEXT;
