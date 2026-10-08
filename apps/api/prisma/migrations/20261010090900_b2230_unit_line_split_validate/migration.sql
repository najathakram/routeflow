-- Sitting 3 (SA-741r2), folder 10/10 (OPTIONAL): validate the B2230 unit-line split CHECKs that
-- 20260926180000_b2230_unit_line_split_check_not_valid added as NOT VALID.
-- VALIDATE CONSTRAINT scans the table under SHARE UPDATE EXCLUSIVE (reads and writes continue; schema changes and
-- another VACUUM wait) and FAILS the whole file if any existing row violates the CHECK. Apply only if the owner census of
-- violating "OrderItem" and "InvoiceItem" rows reads 0 (the PR body carries the placeholder); otherwise REMOVE this folder.
-- No Prisma schema change: a CHECK is not modelled in the schema, so `schema-drift.mjs` is unaffected.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback: none needed. A validated constraint stays enforced; it cannot be made NOT VALID again without dropping
-- and re-adding it.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ValidateConstraint
ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_unitLine_split_chk";

-- ValidateConstraint
ALTER TABLE "InvoiceItem" VALIDATE CONSTRAINT "InvoiceItem_unitLine_split_chk";

COMMIT;
