-- AlterTable
ALTER TABLE "CustomerAuthorization" ADD COLUMN     "expiringSoonNotifiedBucket" INTEGER,
ADD COLUMN     "expiryNotifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CustomerAuthorization_status_expiresAt_idx" ON "CustomerAuthorization"("status", "expiresAt");
