-- B461 (SA-1116): a staff login-email change waits for the NEW address to confirm. One new table, its own, because an
-- unused "UserEmailVerificationToken" row means "a live sign-up link" (B448). Additive only: nothing existing is touched.
-- No tenantId, like the other token tables: the tenant comes from the user row. The CHECK refuses a no-op change.
-- Rollback = drop the table, after the code is rolled back. The table is new and empty, so no lock outlasts the create.
-- CreateTable
CREATE TABLE "UserEmailChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEmailChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserEmailChange_from_to_differ" CHECK ("fromEmail" <> "toEmail")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserEmailChange_tokenHash_key" ON "UserEmailChange"("tokenHash");

-- CreateIndex
CREATE INDEX "UserEmailChange_userId_idx" ON "UserEmailChange"("userId");

-- CreateIndex
CREATE INDEX "UserEmailChange_expiresAt_idx" ON "UserEmailChange"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserEmailChange" ADD CONSTRAINT "UserEmailChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
