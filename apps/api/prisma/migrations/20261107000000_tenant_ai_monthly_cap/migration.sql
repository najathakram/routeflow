-- AI limits PR-1 (owner ruling 2026-11-07: RouteFlow's key runs every AI call; SA-1102): a per-business monthly cap.
--   1. Index "AiUsageEvent"("tenantId","createdAt"): the cap sum filters by business and month on every AI call.
--   2. "Tenant"."aiMonthlyCapUsd": super admin's monthly AI allowance for one business, whole USD. NULL = use the platform
--      "ai.monthlyCapUsd"; 0 = AI off for that business. Nullable, no default: metadata only, no rewrite.
-- Additive only: no row is changed or deleted. Rollback = drop the column, then the index (after the code is rolled back).
--
-- LOCK PROFILE: one transaction, so every lock is held until COMMIT. The index build takes a SHARE lock on "AiUsageEvent"
-- (a small metering table: one row per AI call), which blocks writes to that table for the build only. The "Tenant" ALTER
-- (ACCESS EXCLUSIVE, metadata only) comes LAST, so Tenant, which every request reads, is locked only for the instant
-- between that statement and COMMIT, never through the index build.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- reason: "AiUsageEvent" is a small metering table (one row per AI call); a plain build is a short write block, and CONCURRENTLY cannot run inside the migration transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "AiUsageEvent_tenantId_createdAt_idx" ON "AiUsageEvent"("tenantId", "createdAt");

ALTER TABLE "Tenant" ADD COLUMN "aiMonthlyCapUsd" INTEGER;

COMMIT;
