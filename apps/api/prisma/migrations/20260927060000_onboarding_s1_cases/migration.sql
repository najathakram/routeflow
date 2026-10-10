-- #2159 S1 — wholesaler onboarding cases (platform-level, super-admin only). Purely additive:
-- four new enums, three new tables, one new NULLABLE column on "User". Nothing existing is
-- altered, backfilled or dropped.
--
-- "User"."lastLoginAt": a nullable ADD COLUMN with no default is metadata-only on Postgres 11+
-- (no table rewrite). It takes a brief ACCESS EXCLUSIVE lock; lock_timeout below bounds the wait
-- so a busy "User" table can never queue readers behind it (SET LOCAL: scoped to this migration's
-- transaction, never leaking into the session). If the wait exceeds 5s the migration
-- rolls back and is recorded FAILED — recover with
--   prisma migrate resolve --rolled-back 20260927060000_onboarding_s1_cases
-- from apps/api, then re-run. NEVER `--applied`.
--
-- The two new FKs point FROM the new "OnboardingCase" table (ON DELETE SET NULL), so they take
-- only a SHARE ROW EXCLUSIVE lock on "Tenant"/"DemoBooking" and validate zero rows.
--
-- Rollback (no data outside these tables is touched):
--   DROP TABLE "OnboardingEvent", "OnboardingStep", "OnboardingCase";
--   DROP TYPE "OnboardingActorType", "OnboardingStepStatus", "OnboardingCaseStatus", "OnboardingStage";
--   ALTER TABLE "User" DROP COLUMN "lastLoginAt";
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "OnboardingStage" AS ENUM ('FOLLOW_UP', 'AGREE', 'ACTIVATE', 'COLLECT', 'CONFIGURE', 'VERIFY_TRAIN', 'GO_LIVE', 'HYPERCARE');

-- CreateEnum
CREATE TYPE "OnboardingCaseStatus" AS ENUM ('OPEN', 'ON_HOLD', 'LIVE', 'LOST');

-- CreateEnum
CREATE TYPE "OnboardingStepStatus" AS ENUM ('PENDING', 'DONE', 'WAIVED');

-- CreateEnum
CREATE TYPE "OnboardingActorType" AS ENUM ('ADMIN', 'CUSTOMER', 'SYSTEM');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OnboardingCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "demoBookingId" TEXT,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "stage" "OnboardingStage" NOT NULL DEFAULT 'FOLLOW_UP',
    "status" "OnboardingCaseStatus" NOT NULL DEFAULT 'OPEN',
    "catalogVersion" INTEGER NOT NULL,
    "ownerAdminId" TEXT,
    "targetGoLiveOn" DATE,
    "cutoverAt" TIMESTAMP(3),
    "fitNotes" JSONB,
    "dealTerms" JSONB NOT NULL DEFAULT '{}',
    "lostReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingStep" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "stage" "OnboardingStage" NOT NULL,
    "title" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "autoCheck" TEXT,
    "status" "OnboardingStepStatus" NOT NULL DEFAULT 'PENDING',
    "autoResult" JSONB,
    "evidence" JSONB,
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3),
    "waivedReason" TEXT,
    "waivedById" TEXT,
    "waivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" "OnboardingActorType" NOT NULL,
    "actorId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingCase_tenantId_key" ON "OnboardingCase"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingCase_demoBookingId_key" ON "OnboardingCase"("demoBookingId");

-- CreateIndex
CREATE INDEX "OnboardingCase_stage_status_idx" ON "OnboardingCase"("stage", "status");

-- CreateIndex
CREATE INDEX "OnboardingCase_ownerAdminId_idx" ON "OnboardingCase"("ownerAdminId");

-- CreateIndex
CREATE INDEX "OnboardingStep_caseId_stage_idx" ON "OnboardingStep"("caseId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingStep_caseId_key_key" ON "OnboardingStep"("caseId", "key");

-- CreateIndex
CREATE INDEX "OnboardingEvent_caseId_createdAt_idx" ON "OnboardingEvent"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "OnboardingCase" ADD CONSTRAINT "OnboardingCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingCase" ADD CONSTRAINT "OnboardingCase_demoBookingId_fkey" FOREIGN KEY ("demoBookingId") REFERENCES "DemoBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingEvent" ADD CONSTRAINT "OnboardingEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

