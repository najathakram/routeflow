-- AlterTable
ALTER TABLE "BuyerAccount" ADD COLUMN     "passwordSet" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BuyerPasswordResetToken" (
    "id" TEXT NOT NULL,
    "buyerAccountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerPasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerPasswordResetToken_tokenHash_key" ON "BuyerPasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "BuyerPasswordResetToken_buyerAccountId_idx" ON "BuyerPasswordResetToken"("buyerAccountId");

-- CreateIndex
CREATE INDEX "BuyerPasswordResetToken_expiresAt_idx" ON "BuyerPasswordResetToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "BuyerPasswordResetToken" ADD CONSTRAINT "BuyerPasswordResetToken_buyerAccountId_fkey" FOREIGN KEY ("buyerAccountId") REFERENCES "BuyerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
