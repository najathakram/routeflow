-- Migration: Add google_id to BuyerAccount
-- Allows buyer portal accounts to be linked to a Google identity.
-- Column is nullable (existing accounts without Google sign-in are unaffected).
-- Global unique constraint: one Google account → one buyer portal account.

ALTER TABLE "BuyerAccount"
  ADD COLUMN "googleId" VARCHAR(255);

CREATE UNIQUE INDEX "BuyerAccount_googleId_key"
  ON "BuyerAccount"("googleId");
