-- N4 low-stock digest, schema only (additive, no behavior change): the
-- idempotency mark the daily digest cron writes/reads, same convention as
-- checksDigestSentForDay.

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "lowStockDigestSentForDay" DATE;
