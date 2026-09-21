-- A0 (fleet lead 2026-09-20): four ADDITIVE, NULLABLE columns so template, recurring-invoice and
-- estimate lines can carry a selling unit (U1). No NOT NULL, no default, no index, no backfill:
-- existing rows read NULL = "the pack", exactly as today. Each ADD COLUMN of a nullable column with
-- no default is metadata-only in Postgres (no table rewrite, no scan), so this is instant.
--
-- ORDERING: apply to prod BEFORE the PR that adds these columns to the Prisma schema merges. The API
-- image runs `prisma generate` at build time and Railway rebuilds on any apps/api/** change, so
-- merging that PR redeploys a client that selects these columns on every read of OrderTemplateItem /
-- RecurringInvoiceItem / EstimateItem: it 500s until the columns exist. The reverse order is safe
-- (old code names its columns explicitly and ignores the new ones). Merge promptly after applying:
-- until master's schema folder has the columns, the prod drift gate reports drift.
--
-- Rollback (instant, columns are empty until U1 writes them):
--   ALTER TABLE "OrderTemplateItem" DROP COLUMN "unitLabel";
--   ALTER TABLE "RecurringInvoiceItem" DROP COLUMN "unitLabel";
--   ALTER TABLE "EstimateItem" DROP COLUMN "unitLabel", DROP COLUMN "unitsPerBox";

-- AlterTable
ALTER TABLE "OrderTemplateItem" ADD COLUMN "unitLabel" TEXT;

-- AlterTable
ALTER TABLE "RecurringInvoiceItem" ADD COLUMN "unitLabel" TEXT;

-- AlterTable
ALTER TABLE "EstimateItem" ADD COLUMN "unitLabel" TEXT,
ADD COLUMN "unitsPerBox" INTEGER;
