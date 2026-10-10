-- Sitting 3 (SA-741r2), folder 5/10: auth link hardening.
--   - "User"."emailVerifiedAt" (nullable) and the new table "UserEmailVerificationToken" (mirrors
--     "BuyerEmailVerificationToken": only the token HASH is stored, unique; FK to "User" ON DELETE CASCADE).
--   - "CustomerLink"."inviteTokenHash" (nullable) with a UNIQUE index (the hashed replacement for "inviteToken",
--     which stays until a later cut-over drops it; that drop is NOT in this PR).
-- The new table is empty. "CustomerLink" is small (one row per linked customer): the unique index build is instant.
-- LOCKS: the ALTER TABLE "User" takes ACCESS EXCLUSIVE until COMMIT (it also takes part in the new table's FK check), so it
-- is the LAST statement before COMMIT and the lock window is as short as the file allows.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes these yet):
--   DROP INDEX "CustomerLink_inviteTokenHash_key";
--   ALTER TABLE "CustomerLink" DROP COLUMN "inviteTokenHash";
--   DROP TABLE "UserEmailVerificationToken";
--   ALTER TABLE "User" DROP COLUMN "emailVerifiedAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "CustomerLink" ADD COLUMN     "inviteTokenHash" TEXT;

-- CreateTable
CREATE TABLE "UserEmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "UserEmailVerificationToken_tokenHash_key" ON "UserEmailVerificationToken"("tokenHash");

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "UserEmailVerificationToken_userId_idx" ON "UserEmailVerificationToken"("userId");

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "UserEmailVerificationToken_expiresAt_idx" ON "UserEmailVerificationToken"("expiresAt");

-- CreateIndex
-- reason: "inviteTokenHash" is a new all-NULL column on a small table (one row per linked customer); the build is instant
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "CustomerLink_inviteTokenHash_key" ON "CustomerLink"("inviteTokenHash");

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "UserEmailVerificationToken" ADD CONSTRAINT "UserEmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

COMMIT;
