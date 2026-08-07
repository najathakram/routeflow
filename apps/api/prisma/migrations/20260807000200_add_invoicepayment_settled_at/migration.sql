-- Payments need two dates. `paidAt` is when the payment instrument was
-- received/recorded; `settledAt` is when the money actually LANDED in the bank.
-- A post-dated check is paidAt = today, settledAt = the clearing date months out,
-- so this column may legitimately hold a FUTURE date — nothing may clamp it.
--
-- Cash-basis reporting reads `settledAt ?? paidAt`. Every existing row is NULL,
-- so those keep reporting exactly as before and numbers only shift as operators
-- start recording bank dates. Distinct from the existing `clearedAt`, which is a
-- server-stamped audit mark of the CHECK-lifecycle transition rather than an
-- operator-supplied settlement date (the CLEARED transition now mirrors into
-- settledAt so one field answers "when did the money land" for every method).
--
-- Additive: nullable column + one index (cash-flow and Payments Received filter
-- on it), no data change.
ALTER TABLE "InvoicePayment" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "InvoicePayment_tenantId_settledAt_idx"
  ON "InvoicePayment"("tenantId", "settledAt");
