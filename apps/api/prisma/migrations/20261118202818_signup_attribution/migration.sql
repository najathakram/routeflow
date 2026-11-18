-- Phase 1 (source capture): one additive table, "SignupAttribution", one row per tenant (unique "tenantId", FK to "Tenant"
-- ON DELETE CASCADE). Written only by public register; no backfill, nothing reads it until the dashboard card ships with it.
-- `SET LOCAL lock_timeout = '5s'` bounds the wait on "Tenant" for the FK; a timeout rolls the whole file back.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "SignupAttribution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "gclid" TEXT,
    "fbclid" TEXT,
    "msclkid" TEXT,
    "landingPath" TEXT,
    "referrerHost" TEXT,
    "firstSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignupAttribution_tenantId_key" ON "SignupAttribution"("tenantId");

-- AddForeignKey
ALTER TABLE "SignupAttribution" ADD CONSTRAINT "SignupAttribution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
