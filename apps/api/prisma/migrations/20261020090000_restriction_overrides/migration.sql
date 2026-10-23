-- Row 510 (staff restriction overrides), brief 1/4: the per-line stamp of a staff override of a selling restriction.
--   Sitting 4 (SA-814 §4): ported from PR #3455's `20261014140000_restriction_overrides`, RENAMED to sort after master's
--   `20261016120000_units_prices_v2_schema` (unapplied anywhere but dev DBs; a dev DB that applied the old name runs
--   `npm run local:reset`). Statements identical; #3455 drops its own folder and keeps only its app code.
--   "OrderItem" and "InvoiceItem" each gain four nullable columns, no default, no backfill:
--     "restrictionOverrideReason"  TEXT          the staff member's reason (3..200 chars after trim, checked in the API)
--     "restrictionOverrideBy"      TEXT          the overriding User id (no FK: the stamp outlives a user delete; the audit row keeps it too)
--     "restrictionOverrideAt"      TIMESTAMP(3)  when the override was given
--     "restrictionOverrideRuleIds" TEXT[]        the rule ids acknowledged (Prisma `String[]`; NULL reads as [], like "SellingRestriction"."states")
-- LOCKS ON A POPULATED TABLE: each ALTER TABLE takes ACCESS EXCLUSIVE until COMMIT. A nullable column with no default is
-- a catalog-only change in Postgres (no table rewrite, no scan), so the window is just the catalog update.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that waits
-- longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns.
--
-- Rollback (nothing reads or writes these until brief 2):
--   ALTER TABLE "InvoiceItem" DROP COLUMN "restrictionOverrideRuleIds", DROP COLUMN "restrictionOverrideAt",
--     DROP COLUMN "restrictionOverrideBy", DROP COLUMN "restrictionOverrideReason";
--   ALTER TABLE "OrderItem" DROP COLUMN "restrictionOverrideRuleIds", DROP COLUMN "restrictionOverrideAt",
--     DROP COLUMN "restrictionOverrideBy", DROP COLUMN "restrictionOverrideReason";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "OrderItem"
  ADD COLUMN "restrictionOverrideReason" TEXT,
  ADD COLUMN "restrictionOverrideBy" TEXT,
  ADD COLUMN "restrictionOverrideAt" TIMESTAMP(3),
  ADD COLUMN "restrictionOverrideRuleIds" TEXT[];

-- AlterTable
ALTER TABLE "InvoiceItem"
  ADD COLUMN "restrictionOverrideReason" TEXT,
  ADD COLUMN "restrictionOverrideBy" TEXT,
  ADD COLUMN "restrictionOverrideAt" TIMESTAMP(3),
  ADD COLUMN "restrictionOverrideRuleIds" TEXT[];

COMMIT;
