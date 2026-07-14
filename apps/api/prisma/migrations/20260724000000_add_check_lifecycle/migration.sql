-- P5-12: check lifecycle (Recorded → Deposited → Cleared → Bounced) on the LIVE
-- AR payment table (InvoicePayment — the Payment/Transaction tables are dead code).
-- Additive-only: one new enum + five nullable columns + a safe backfill that
-- stamps existing non-void CHECK payments as RECORDED. No amounts are touched.
CREATE TYPE "CheckStatus" AS ENUM ('RECORDED', 'DEPOSITED', 'CLEARED', 'BOUNCED');

ALTER TABLE "InvoicePayment" ADD COLUMN "checkStatus" "CheckStatus";
ALTER TABLE "InvoicePayment" ADD COLUMN "depositedAt" TIMESTAMP(3);
ALTER TABLE "InvoicePayment" ADD COLUMN "clearedAt" TIMESTAMP(3);
ALTER TABLE "InvoicePayment" ADD COLUMN "bouncedAt" TIMESTAMP(3);
ALTER TABLE "InvoicePayment" ADD COLUMN "nsfFeeAmount" DECIMAL(10,2);

-- Backfill: existing check payments enter the lifecycle at RECORDED. VOID checks
-- are left null — they were manually voided before the lifecycle existed and we
-- cannot know whether they bounced.
UPDATE "InvoicePayment"
SET "checkStatus" = 'RECORDED'
WHERE "method" = 'CHECK' AND "status" <> 'VOID';
