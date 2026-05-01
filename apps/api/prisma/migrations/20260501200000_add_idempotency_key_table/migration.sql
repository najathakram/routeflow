-- RF-019: IdempotencyKey table for complete-stop deduplication
-- MANUAL APPLY REQUIRED on Railway before deploying the corresponding code
-- Run: npx prisma migrate deploy  OR  psql -c '<SQL below>'

CREATE TABLE "IdempotencyKey" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid(),
    "keyHash"   TEXT NOT NULL,
    "response"  TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdempotencyKey_keyHash_key" ON "IdempotencyKey"("keyHash");
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
