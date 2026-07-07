-- CreateEnum
CREATE TYPE "MigrationSource" AS ENUM ('ZOHO', 'QUICKBOOKS', 'CSV', 'PAPER');

-- CreateEnum
CREATE TYPE "MigrationJobStatus" AS ENUM ('FETCHING', 'STAGED', 'CONFIRMED', 'UNDONE', 'FAILED');

-- CreateEnum
CREATE TYPE "StagingRecordStatus" AS ENUM ('PENDING', 'DUPLICATE', 'COMMITTED', 'SKIPPED', 'REVERSED');

-- CreateTable
CREATE TABLE "MigrationJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" "MigrationSource" NOT NULL,
    "status" "MigrationJobStatus" NOT NULL DEFAULT 'FETCHING',
    "scopeCounts" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "undoDeadline" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationStagingRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "entityType" "ImportEntityType" NOT NULL,
    "externalId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "StagingRecordStatus" NOT NULL DEFAULT 'PENDING',
    "flags" JSONB NOT NULL DEFAULT '[]',
    "matchedEntityId" TEXT,
    "createdEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationStagingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationJob_tenantId_status_idx" ON "MigrationJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MigrationJob_tenantId_createdAt_idx" ON "MigrationJob"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "MigrationStagingRecord_tenantId_jobId_idx" ON "MigrationStagingRecord"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "MigrationStagingRecord_jobId_status_idx" ON "MigrationStagingRecord"("jobId", "status");

-- AddForeignKey
ALTER TABLE "MigrationStagingRecord" ADD CONSTRAINT "MigrationStagingRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "MigrationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

