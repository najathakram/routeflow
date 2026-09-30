-- CreateEnum
CREATE TYPE "MailboxProvider" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "MailboxConnectionStatus" AS ENUM ('CONNECTED', 'REVOKED', 'THROTTLED');

-- CreateTable
CREATE TABLE "MailboxConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "MailboxProvider" NOT NULL DEFAULT 'GOOGLE',
    "accountEmail" TEXT NOT NULL,
    "externalSubject" TEXT NOT NULL,
    "scopesGranted" TEXT[],
    "refreshTokenCipher" TEXT NOT NULL,
    "accessTokenCipher" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "status" "MailboxConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "throttledUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailboxConnection_tenantId_key" ON "MailboxConnection"("tenantId");

-- CreateIndex
CREATE INDEX "MailboxConnection_status_idx" ON "MailboxConnection"("status");

-- AddForeignKey
ALTER TABLE "MailboxConnection" ADD CONSTRAINT "MailboxConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

