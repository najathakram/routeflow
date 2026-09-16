-- LITE plan (invite-only, WP1 of the lite-L2 lane). Additive only: one enum value, no
-- backfill, no column changes. Existing rows are untouched.
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in
-- Postgres, so this file is intentionally NOT wrapped in BEGIN/COMMIT.

-- AlterEnum
ALTER TYPE "TenantPlan" ADD VALUE 'LITE';
