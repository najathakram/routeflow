-- CreateEnum
CREATE TYPE "CrmConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_ATTENTION', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "CrmTriggerMode" AS ENUM ('STAGE', 'WON');

-- CreateEnum
CREATE TYPE "CrmHandoffStatus" AS ENUM ('PENDING', 'CREATED', 'LINKED', 'WRITEBACK_PENDING', 'NEEDS_REVIEW', 'DRY_RUN', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "CrmConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gohighlevel',
    "locationId" TEXT NOT NULL,
    "locationName" TEXT,
    "secretCipher" TEXT,
    "tokenLast4" TEXT,
    "status" "CrmConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "triggerMode" "CrmTriggerMode" NOT NULL DEFAULT 'STAGE',
    "pipelineId" TEXT,
    "stageId" TEXT,
    "stageName" TEXT,
    "startFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "writeBackFields" BOOLEAN NOT NULL DEFAULT true,
    "writeBackTag" BOOLEAN NOT NULL DEFAULT true,
    "writeBackNote" BOOLEAN NOT NULL DEFAULT true,
    "markWon" BOOLEAN NOT NULL DEFAULT false,
    "customFieldIds" JSONB,
    "defaultRegion" TEXT NOT NULL DEFAULT 'US',
    "lastPollAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attentionNotifiedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmHandoff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gohighlevel',
    "opportunityId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "opportunityName" TEXT,
    "contactName" TEXT,
    "status" "CrmHandoffStatus" NOT NULL DEFAULT 'PENDING',
    "customerId" TEXT,
    "matchedBy" TEXT,
    "reason" TEXT,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "noteWritten" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "CrmHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmConnection_tenantId_key" ON "CrmConnection"("tenantId");

-- CreateIndex
CREATE INDEX "CrmConnection_enabled_status_idx" ON "CrmConnection"("enabled", "status");

-- CreateIndex
CREATE INDEX "CrmHandoff_tenantId_status_createdAt_idx" ON "CrmHandoff"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmHandoff_tenantId_provider_opportunityId_key" ON "CrmHandoff"("tenantId", "provider", "opportunityId");

-- AddForeignKey
ALTER TABLE "CrmConnection" ADD CONSTRAINT "CrmConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

