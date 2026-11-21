-- CORE and ALL_IN plans (SA-1204 PR-1, pricing catalog v14). Additive only: two enum values,
-- no backfill, no column changes. Existing rows are untouched, and nothing writes the new
-- values until PR-2 maps them.
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in
-- Postgres, so this file is intentionally NOT wrapped in a transaction (same as the LITE
-- migration; the test pins that no transaction keywords appear).

-- AlterEnum
ALTER TYPE "TenantPlan" ADD VALUE 'CORE';
ALTER TYPE "TenantPlan" ADD VALUE 'ALL_IN';
