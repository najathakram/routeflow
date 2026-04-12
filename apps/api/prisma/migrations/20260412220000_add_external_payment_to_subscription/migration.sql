-- Add external payment tracking fields to TenantSubscription
-- Allows super admin to record Zelle, bank transfer, check, etc. payments
-- and activate a tenant subscription without going through Stripe.

ALTER TABLE "TenantSubscription"
  ADD COLUMN IF NOT EXISTS "externalPayment"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "externalPaymentMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "externalPaymentRef"    TEXT,
  ADD COLUMN IF NOT EXISTS "externalPaymentNotes"  TEXT;
