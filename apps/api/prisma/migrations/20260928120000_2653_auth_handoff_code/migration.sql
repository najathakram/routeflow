-- #2653 (SA-542a/b): one-time in-app sign-in handoff codes (staff + buyer realms).
-- Additive only: one enum, one new table, three indexes, two FKs. No existing row touched,
-- no backfill. The owner applies it (backup, prod-migrate) and sets HANDOFF_TOKEN_SECRET before deploy.

-- CreateEnum
CREATE TYPE "HandoffRealm" AS ENUM ('STAFF', 'BUYER');

-- CreateTable
CREATE TABLE "AuthHandoffCode" (
    "tokenHash" TEXT NOT NULL,
    "realm" "HandoffRealm" NOT NULL,
    "userId" TEXT,
    "buyerAccountId" TEXT,
    "tenantId" TEXT,
    "deviceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthHandoffCode_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "AuthHandoffCode_userId_idx" ON "AuthHandoffCode"("userId");

-- CreateIndex
CREATE INDEX "AuthHandoffCode_buyerAccountId_idx" ON "AuthHandoffCode"("buyerAccountId");

-- CreateIndex
CREATE INDEX "AuthHandoffCode_expiresAt_idx" ON "AuthHandoffCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "AuthHandoffCode" ADD CONSTRAINT "AuthHandoffCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthHandoffCode" ADD CONSTRAINT "AuthHandoffCode_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

