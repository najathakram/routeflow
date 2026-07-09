-- Phase 4 (W7b): regulated-delivery POD age/identity checks.
-- Additive only — new columns with safe defaults, no drops, no data backfill.

-- AlterTable: per-category POD policy flags (analogous to requiresLicense).
ALTER TABLE "TrackedCategory" ADD COLUMN     "requiresAgeCheck" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requiresIdCheck" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: what the driver captured at a regulated delivery stop.
ALTER TABLE "RouteRunStop" ADD COLUMN     "ageVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identityVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identityType" TEXT,
ADD COLUMN     "identityVerifiedAt" TIMESTAMP(3);
