-- Account lockout (additive): failed-attempt tracking + timed lock on both
-- staff users and buyer accounts. Defaults backfill existing rows; no locks
-- are created by this migration.
ALTER TABLE "User" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);

ALTER TABLE "BuyerAccount" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BuyerAccount" ADD COLUMN "lockedUntil" TIMESTAMP(3);
