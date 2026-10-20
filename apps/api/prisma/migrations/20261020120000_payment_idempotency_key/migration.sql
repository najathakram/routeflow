-- SA-824 (row 661 step 1): the replay store of the customer money-in writers (POST /invoices/payments/record,
--   POST /invoices/:id/payments, POST /customers/:id/advance-payments).
--   CREATE TYPE "PaymentIdempotencyScope" ('STANDALONE_PAYMENT','INVOICE_PAYMENT','ADVANCE_PAYMENT') (the AP seam)
--   CREATE TABLE "PaymentIdempotencyKey" + the unique (tenantId, key) index the in-tx claim conflicts on.
--   One row per Idempotency-Key per tenant, claimed by the FIRST statement of the writer's own transaction and
--   completed with its result in that same transaction. No TTL (as "OrderIdempotencyKey").
--
-- NEW OBJECTS ONLY: a new type, a new empty table and its index. No existing table is altered, scanned or locked.
-- LOCK PROFILE: ONE transaction; the only locks are on the new objects. `SET LOCAL lock_timeout = '5s'` bounds each
-- wait anyway (the house rule); a timeout rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261020120000_payment_idempotency_key` from apps/api, then re-run;
-- NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge the code that reads or writes this table (SA-824 ruling 5).
--
-- Rollback (instant; nothing else references it):
--   DROP TABLE "PaymentIdempotencyKey";
--   DROP TYPE "PaymentIdempotencyScope";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "PaymentIdempotencyScope" AS ENUM ('STANDALONE_PAYMENT', 'INVOICE_PAYMENT', 'ADVANCE_PAYMENT');

-- CreateTable
CREATE TABLE "PaymentIdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" "PaymentIdempotencyScope" NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "paymentGroupId" TEXT,
    "advancePaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIdempotencyKey_tenantId_key_key" ON "PaymentIdempotencyKey"("tenantId", "key");

COMMIT;
