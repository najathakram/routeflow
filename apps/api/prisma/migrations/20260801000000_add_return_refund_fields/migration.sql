-- Return resolution snapshot: credit-note vs external refund, amount, timestamp.
-- Additive + idempotent; no backfill (existing REFUNDED rows keep creditNoteId only).
ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "refundMethod" TEXT;
ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "refundAmount" DECIMAL(10,2);
ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
