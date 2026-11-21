-- CORE and ALL_IN plans (SA-1204 PR-1 A1, pricing catalog v14). Additive only: two enum values,
-- no backfill, no column changes. Existing rows are untouched.
-- ADD VALUE inside this file's transaction is legal on PG >= 12. A value added in a transaction
-- cannot be USED in it, and nothing here or anywhere in this PR uses either value (PR-2 does).
-- One transaction: both values land or neither does, so a failed run can simply be run again.
-- `SET LOCAL lock_timeout = '5s'` bounds each lock wait (ADD VALUE locks the enum type only).
-- Shape follows 20261105090000_order_refused_status.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "TenantPlan" ADD VALUE 'CORE';
ALTER TYPE "TenantPlan" ADD VALUE 'ALL_IN';

COMMIT;
