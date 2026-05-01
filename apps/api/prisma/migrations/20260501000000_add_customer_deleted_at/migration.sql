-- Migration: add Customer.deletedAt soft-delete timestamp
-- RF-197 added soft-delete logic to deleteCustomer() but did not ship a migration.
-- This column is nullable so it is additive and safe to apply without downtime.

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Customer_deletedAt_idx" ON "Customer"("deletedAt");
