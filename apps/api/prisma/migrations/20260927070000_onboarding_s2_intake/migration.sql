-- #2159 S2 — wholesaler onboarding intake link (platform-level, super-admin + token-holder only).
-- Purely additive: two new enums and four new tables, each with an FK FROM the new table TO
-- "OnboardingCase" (created by 20260927060000). Nothing existing is altered, backfilled or dropped,
-- so no lock is taken on any pre-existing table and no lock_timeout is needed.
--
-- "OrderAcceptance" is APPEND-ONLY: the trigger at the end refuses every UPDATE except setting
-- "supersededAt" once (NULL -> a timestamp). Prisma does not model triggers, so this lives only
-- here; the drift gate does not see it as drift.
--
-- Rollback (no data outside these tables is touched):
--   DROP TRIGGER "OrderAcceptance_append_only" ON "OrderAcceptance";
--   DROP FUNCTION "order_acceptance_append_only"();
--   DROP TABLE "OrderAcceptance", "IntakeAccessToken", "IntakeFile", "IntakeSection";
--   DROP TYPE "IntakeSectionStatus", "IntakeSectionKey";

-- CreateEnum
CREATE TYPE "IntakeSectionKey" AS ENUM ('ACCOUNT', 'TAX_COMPLIANCE', 'INVOICING', 'TEAM', 'OPERATIONS', 'DATA_FILES', 'GO_LIVE_PREFS');

-- CreateEnum
CREATE TYPE "IntakeSectionStatus" AS ENUM ('EMPTY', 'DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'APPLIED', 'WAIVED');

-- CreateTable
CREATE TABLE "IntakeSection" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "key" "IntakeSectionKey" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "status" "IntakeSectionStatus" NOT NULL DEFAULT 'EMPTY',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedDiff" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeFile" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sectionKey" "IntakeSectionKey" NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "containsPii" BOOLEAN NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeAccessToken" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAcceptance" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "tenantId" TEXT,
    "orderSnapshot" JSONB NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "acceptedName" TEXT NOT NULL,
    "acceptedEmail" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "tokenId" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "OrderAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeSection_caseId_key_key" ON "IntakeSection"("caseId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeFile_storageKey_key" ON "IntakeFile"("storageKey");

-- CreateIndex
CREATE INDEX "IntakeFile_caseId_sectionKey_idx" ON "IntakeFile"("caseId", "sectionKey");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeAccessToken_tokenHash_key" ON "IntakeAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "IntakeAccessToken_caseId_idx" ON "IntakeAccessToken"("caseId");

-- CreateIndex
CREATE INDEX "OrderAcceptance_caseId_acceptedAt_idx" ON "OrderAcceptance"("caseId", "acceptedAt");

-- AddForeignKey
ALTER TABLE "IntakeSection" ADD CONSTRAINT "IntakeSection_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeFile" ADD CONSTRAINT "IntakeFile_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAccessToken" ADD CONSTRAINT "IntakeAccessToken_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAcceptance" ADD CONSTRAINT "OrderAcceptance_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OnboardingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Append-only guard for "OrderAcceptance" (#2159 S2, plan §3): an accepted order is frozen.
CREATE FUNCTION "order_acceptance_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION 'OrderAcceptance % is superseded and immutable', OLD."id" USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - 'supersededAt') IS DISTINCT FROM (to_jsonb(OLD) - 'supersededAt') THEN
    RAISE EXCEPTION 'OrderAcceptance % is append-only: only supersededAt may be set', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderAcceptance_append_only"
  BEFORE UPDATE ON "OrderAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "order_acceptance_append_only"();
