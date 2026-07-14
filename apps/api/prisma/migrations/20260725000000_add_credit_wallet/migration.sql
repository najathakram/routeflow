-- P5-13: credits wallet — expiry + application audit on CreditNote. Additive only:
-- three nullable/defaulted columns, no data rewrite. "Expired" is a computed filter
-- in application code (never a status flip), so no backfill is needed.
ALTER TABLE "CreditNote" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "CreditNote" ADD COLUMN "appliedAt" TIMESTAMP(3);
ALTER TABLE "CreditNote" ADD COLUMN "autoApplied" BOOLEAN NOT NULL DEFAULT false;
