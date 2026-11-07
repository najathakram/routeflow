-- AI limits PR-1 (owner ruling 2026-11-07: RouteFlow's key runs every AI call; SA-1102): a per-business monthly cap.
--   1. "Tenant"."aiMonthlyCapUsd": super admin's monthly AI allowance for one business, whole USD. NULL = use the platform
--      "ai.monthlyCapUsd"; 0 = AI off for that business. Nullable, no default: metadata only, no rewrite.
--   2. Index "AiUsageEvent"("tenantId","createdAt"): the cap sum filters by business and month on every AI call.
-- Additive only: no row is changed or deleted. Rollback = drop the index, then the column.
--
-- LOCK PROFILE: one transaction. A brief ACCESS EXCLUSIVE lock on "Tenant" for the column add (metadata only); the index build
-- takes a SHARE lock on "AiUsageEvent" (a small metering table: one row per AI call), which blocks writes for the build only.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Tenant" ADD COLUMN "aiMonthlyCapUsd" INTEGER;

-- reason: "AiUsageEvent" is a small metering table (one row per AI call); a plain build is a short write block, and CONCURRENTLY cannot run inside the migration transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "AiUsageEvent_tenantId_createdAt_idx" ON "AiUsageEvent"("tenantId", "createdAt");

COMMIT;
