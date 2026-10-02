-- #2309 (SA-418): Sign in with Apple — additive only, same shape as googleId's columns/indexes.
--   "User"."appleId"                : Apple's stable `sub`, scoped per tenant like googleId.
--   "User_tenantId_appleId_key"     : @@unique([tenantId, appleId]) — same tenant, one Apple sub.
--   "BuyerAccount"."appleId"        : Apple's stable `sub`, globally unique (buyers have no tenant).
--   "BuyerAccount_appleId_key"      : @unique — mirrors BuyerAccount.googleId.
--   "BuyerAccount"."appleRefreshTokenEnc" : AES-256-GCM ciphertext (common/encryption.service.ts)
--     of the Apple refresh token obtained by exchanging authorizationCode at first sign-in, used
--     to call Apple's /auth/revoke on account deletion.
-- All three columns are nullable adds: no table rewrite, no backfill in this file.
--
-- Locking: the file is wrapped in an explicit BEGIN/COMMIT so SET LOCAL lock_timeout takes effect
-- (SA-597), so CONCURRENTLY is unavailable. Each ADD COLUMN
-- (nullable, no default) is metadata-only; each CREATE UNIQUE INDEX scans its table once and holds a
-- SHARE lock (writes to that table wait, reads do not) for the build — "User" and "BuyerAccount" are
-- small, so seconds at most. The same form as googleId's indexes (0_init). lock_timeout makes the
-- migration fail fast and roll back whole rather than queue behind a long writer.
--
-- Rollback (instant):
--   DROP INDEX "User_tenantId_appleId_key";
--   ALTER TABLE "User" DROP COLUMN "appleId";
--   DROP INDEX "BuyerAccount_appleId_key";
--   ALTER TABLE "BuyerAccount" DROP COLUMN "appleId", DROP COLUMN "appleRefreshTokenEnc";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "appleId" TEXT;

-- AlterTable
ALTER TABLE "BuyerAccount" ADD COLUMN "appleId" TEXT,
ADD COLUMN "appleRefreshTokenEnc" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_appleId_key" ON "User"("tenantId", "appleId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerAccount_appleId_key" ON "BuyerAccount"("appleId");

COMMIT;
