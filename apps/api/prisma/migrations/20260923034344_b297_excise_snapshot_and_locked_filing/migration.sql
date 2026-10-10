-- B297 (SA-088, fleet lead 2026-09-24): PR 1 of 6 — schema only, nothing reads or writes these
-- columns yet. Two independent pieces, one migration so the owner applies a single file.
--
-- 1. THE RATE SNAPSHOT (D1). Freezes the TrackedCategory trio a regulated line was actually
--    priced at — "categoryTaxType", "categoryTaxRate", "categoryPriceIncludesTax" — on both
--    "OrderItem" and "InvoiceItem". All three ADDITIVE, NULLABLE, no default: an ADD COLUMN of a
--    nullable column with no default is metadata-only in Postgres (no table rewrite, no scan).
--    Rate alone is not a snapshot — computeCategoryTax needs all three, and a line re-priced with
--    a snapshot rate but a live taxType would be a mixed basis. Reuses the existing
--    "TrackedCategoryTaxType" enum (no ALTER TYPE needed for it) and matches
--    "TrackedCategory"."rate"'s own DECIMAL(12,4) precision. NULL means "no snapshot" (every
--    existing row, plus every non-regulated line going forward) — recompute of a NULL-snapshot
--    line keeps its stored categoryTaxAmount rather than reading the live category (B297-SPEC.md
--    D2); this migration adds no backfill (D3 — a provable, owner-run backfill is a later PR).
--
-- 2. THE LOCKED FILING STATUS (D4). Adds the "LOCKED" value to "RegulatedFilingStatus" (an
--    explicit tenant-admin action that closes a (tenant, category, periodKey) triple; no unlock
--    endpoint in this work) plus three columns on "RegulatedFiling" that a lock stamps together:
--    "lockedAt", "lockedById", "lockReason". Nullable, no default, no backfill — every existing
--    filing stays GENERATED or FAILED and reads NULL for all three. Postgres allows
--    ALTER TYPE ... ADD VALUE inside a transaction (PG >= 12) as long as nothing in the SAME
--    transaction reads the new value — nothing here does; no code references LOCKED until PR 4b.
--
-- Both pieces are schema-only: no index needed (nothing queries by the new columns yet), no
-- table scan (every statement is metadata-only), so a single short lock_timeout covers the whole
-- file safely even against a busy table.
--
-- ORDERING (L-184, matches 20260921180000's own note): apply to prod BEFORE the PR that adds
-- these fields to the Prisma schema merges. The API image runs `prisma generate` at build time,
-- and Railway rebuilds on any apps/api/** push, so merging first would deploy a client that
-- selects columns the live database doesn't have yet — a 500 on every OrderItem/InvoiceItem read.
-- The reverse order (migrate first, merge after) is safe: the old, still-running client names its
-- columns explicitly and ignores the new ones. Apply via
-- `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`, confirm the drift gate
-- reports exit 0, THEN merge — never the other way.
--
-- Rollback (instant — every column and the enum-value addition touch no existing data):
--   ALTER TABLE "RegulatedFiling" DROP COLUMN "lockedAt", DROP COLUMN "lockedById", DROP COLUMN "lockReason";
--   ALTER TABLE "OrderItem" DROP COLUMN "categoryTaxType", DROP COLUMN "categoryTaxRate", DROP COLUMN "categoryPriceIncludesTax";
--   ALTER TABLE "InvoiceItem" DROP COLUMN "categoryTaxType", DROP COLUMN "categoryTaxRate", DROP COLUMN "categoryPriceIncludesTax";
--   -- "LOCKED" cannot be dropped from a Postgres enum type; harmless unused value if ever rolled back.

SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "RegulatedFilingStatus" ADD VALUE 'LOCKED';

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "categoryPriceIncludesTax" BOOLEAN,
ADD COLUMN     "categoryTaxRate" DECIMAL(12,4),
ADD COLUMN     "categoryTaxType" "TrackedCategoryTaxType";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "categoryPriceIncludesTax" BOOLEAN,
ADD COLUMN     "categoryTaxRate" DECIMAL(12,4),
ADD COLUMN     "categoryTaxType" "TrackedCategoryTaxType";

-- AlterTable
ALTER TABLE "RegulatedFiling" ADD COLUMN     "lockReason" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedById" TEXT;
