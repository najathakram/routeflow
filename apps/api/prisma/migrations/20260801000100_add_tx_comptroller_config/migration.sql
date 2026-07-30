-- TX Comptroller reporting config on TrackedCategory. Additive + idempotent;
-- non-TX categories are untouched (all NULL).
ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "wholesalerLicenseNo" TEXT;
ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "txItemType" INTEGER;
ALTER TABLE "TrackedCategory" ADD COLUMN IF NOT EXISTS "txUom" TEXT;
