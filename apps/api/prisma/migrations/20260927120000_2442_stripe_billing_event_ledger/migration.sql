-- #2442: the platform billing webhook's event ledger (mirrors StripeConnectEvent). One row per
-- Stripe event id, inserted before the event is handled; a redelivery of a completed event is
-- skipped. Additive only: one new table and its index. No existing row touched, no backfill.

-- CreateTable
CREATE TABLE "StripeBillingEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,

    CONSTRAINT "StripeBillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StripeBillingEvent_type_createdAt_idx" ON "StripeBillingEvent"("type", "createdAt");
