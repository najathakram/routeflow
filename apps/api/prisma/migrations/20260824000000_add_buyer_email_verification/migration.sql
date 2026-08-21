-- Registration email verification for buyer accounts (closes the buyer-connect
-- residual exposure from PR #378: an attacker could register under a victim
-- customer's email and auto-connect to their invoices/pricing, because nothing
-- ever read BuyerAccount.emailVerified).

-- CreateTable
CREATE TABLE "BuyerEmailVerificationToken" (
    "id" TEXT NOT NULL,
    "buyerAccountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerEmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerEmailVerificationToken_tokenHash_key" ON "BuyerEmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "BuyerEmailVerificationToken_buyerAccountId_idx" ON "BuyerEmailVerificationToken"("buyerAccountId");

-- CreateIndex
CREATE INDEX "BuyerEmailVerificationToken_expiresAt_idx" ON "BuyerEmailVerificationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "BuyerEmailVerificationToken" ADD CONSTRAINT "BuyerEmailVerificationToken_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grandfather every buyer account that exists BEFORE the emailVerified gate goes
-- live. No password-registered account was ever marked verified (the flag was
-- write-only until now), so gating requestSeller on it without this backfill
-- would push every existing buyer into the seller-review path. Accepted
-- trade-off: an attacker-registered account already sitting on a victim's email
-- is grandfathered too — the exposure only shipped with #378's auto-connect and
-- the flip to verified-only happens in the same deploy as this backfill.
UPDATE "BuyerAccount" SET "emailVerified" = true WHERE "emailVerified" = false;
