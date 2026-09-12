-- B215: additive-only per-request idempotency store for the staff create-merge branch
-- (POST /orders mergeChoice:"merge"). One row per Idempotency-Key per tenant, written inside the
-- fold's own transaction so the key and the fold commit together. Replaces nothing: the existing
-- Order."idempotencyKey" column and its unique index are untouched. No backfill; no reader or
-- writer until this PR's server half deploys, so applying it ahead of the deploy is safe.

-- CreateTable
CREATE TABLE "OrderIdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "responseHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderIdempotencyKey_orderId_idx" ON "OrderIdempotencyKey"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIdempotencyKey_tenantId_key_key" ON "OrderIdempotencyKey"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "OrderIdempotencyKey" ADD CONSTRAINT "OrderIdempotencyKey_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
