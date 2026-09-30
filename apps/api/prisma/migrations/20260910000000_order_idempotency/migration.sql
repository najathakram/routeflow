-- F30/R8: additive-only idempotency support for POST /orders. A nullable
-- Order.idempotencyKey plus a per-tenant unique constraint lets a client-generated
-- key (uuid per cart session) make a duplicate submit (queue self-duplication, a
-- timed-out-but-actually-completed request retried) replay the ORIGINAL order
-- instead of creating a second one. NULL values are treated as distinct by
-- PostgreSQL (mirrors the existing tenantId/orderNumber unique), so every
-- existing row and any client that never sends a key is unaffected — no
-- backfill, no writer until this PR's server half deploys.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_idempotencyKey_key" ON "Order"("tenantId", "idempotencyKey");
