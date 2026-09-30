-- Stripe Connect rework: event ledger, SETTLING/SETTLED status, provider-
-- agnostic payment reference, single-use OAuth state, and the race-proof
-- open-request partial unique index. Additive only.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot be referenced by a later statement
-- in the SAME transaction ("unsafe use of new value" — Postgres requires the
-- new value to be committed first), and this migration's partial index DOES
-- reference 'SETTLING' in its WHERE clause. So — unlike the earlier
-- ADD-VALUE-only migrations in this repo — this file explicitly closes the
-- transaction right after the enum additions with a bare COMMIT (Prisma's
-- documented workaround); everything after it runs in a second, auto-closed
-- transaction.

-- AlterEnum
ALTER TYPE "BuyerPaymentRequestStatus" ADD VALUE 'SETTLING' AFTER 'PENDING';
ALTER TYPE "BuyerPaymentRequestStatus" ADD VALUE 'SETTLED' AFTER 'SETTLING';

COMMIT;

-- CreateTable
CREATE TABLE "StripeConnectEvent" (
    "id" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,

    CONSTRAINT "StripeConnectEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StripeConnectEvent_accountRef_type_createdAt_idx" ON "StripeConnectEvent"("accountRef", "type", "createdAt");

-- AlterTable: TenantStripeConnect gains the single-use OAuth pending-jti pair
-- (invariant 12) and stripeAccountId becomes nullable — the row now exists
-- from the moment the authorize URL is built (to stash the pending jti),
-- before the account id is known.
ALTER TABLE "TenantStripeConnect" ALTER COLUMN "stripeAccountId" DROP NOT NULL;
ALTER TABLE "TenantStripeConnect" ADD COLUMN "pendingJti" TEXT;
ALTER TABLE "TenantStripeConnect" ADD COLUMN "pendingJtiIssuedAt" TIMESTAMP(3);

-- AlterTable: BuyerPaymentRequest gains the provider-agnostic settled-payment
-- reference and an anomaly note (invariants 7/9).
ALTER TABLE "BuyerPaymentRequest" ADD COLUMN "providerPaymentId" TEXT;
ALTER TABLE "BuyerPaymentRequest" ADD COLUMN "outcome" TEXT;

-- CreateIndex: race-proof open-request rule (invariant 8). Prisma's schema
-- language has no `WHERE` clause for `@@index`/`@@unique`, so this partial
-- unique index exists ONLY here — see the doc comment on BuyerPaymentRequest
-- in schema.prisma. EXPIRED is deliberately excluded so an abandoned request
-- never blocks the buyer from starting a new one.
CREATE UNIQUE INDEX "BuyerPaymentRequest_open_request_key" ON "BuyerPaymentRequest"("tenantId", "customerId") WHERE "status" IN ('PENDING', 'SETTLING');
