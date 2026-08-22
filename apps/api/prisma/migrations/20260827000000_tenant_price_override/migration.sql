-- Platform billing — catalog-driven Stripe prices, custom tenant fees, annual prepay.
-- Per-tenant price overrides + the interval a checkout completed with. Additive only:
-- all three columns are nullable with no default, so existing TenantSubscription rows
-- are untouched (null = fall back to the plan catalog).

-- AlterTable
ALTER TABLE "TenantSubscription" ADD COLUMN IF NOT EXISTS "priceOverrideMonthly" DECIMAL(10,2);
ALTER TABLE "TenantSubscription" ADD COLUMN IF NOT EXISTS "priceOverrideAnnual" DECIMAL(10,2);
ALTER TABLE "TenantSubscription" ADD COLUMN IF NOT EXISTS "billingInterval" TEXT;
