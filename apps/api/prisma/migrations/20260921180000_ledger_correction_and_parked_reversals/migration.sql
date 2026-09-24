-- B660 / B662 (fleet lead 2026-09-21, Senior Architect ruling): ONE migration for the ledger's correction
-- columns and the parked-reversal table, so the owner applies a single file.
--
-- 1. Two ADDITIVE, NULLABLE columns on "RegulatedSalesLedger" so a correction can be an append-only row that
--    points at the SALE it corrects:
--      "originalSoldAt"  the sale date the corrected row was booked under
--      "correctsEntryId" the id of the SALE row being corrected (a scalar pointer + index, no FK: the same
--                        denormalized, self-contained shape as invoiceId / orderItemId / returnId on this table)
--    No NOT NULL, no default, no backfill: every existing row reads NULL, exactly as today. Each ADD COLUMN
--    of a nullable column with no default is metadata-only in Postgres (no table rewrite, no scan).
--    "originalSoldAt" is TIMESTAMP(3) on purpose, the same type as "soldAt" (Prisma `DateTime`), so copying
--    one into the other never depends on the session time zone.
--
-- 2. A NEW, EMPTY table "RegulatedLedgerParkedReversal": a return reversal the ledger could not book because
--    the sold line's pack is unknown. It stores the TRUE returned pieces and the SALE row it will reverse, so
--    the reversal can book itself once an operator supplies the split. PARKED means "resolvedAt IS NULL"
--    (no status column). Tenant FK ON DELETE CASCADE like the ledger; UNIQUE ("returnId", "saleEntryId")
--    makes a retried capture unable to park the same reversal twice; "saleEntryId" and "resolvedEntryId"
--    are scalar pointers with no FK. "tenantId" is NOT NULL from birth, so the T6 NULL-tenant CHECK family
--    has nothing to backfill here. Nothing writes to it until the B660 code ships.
--
-- 3. A second NEW, EMPTY table "ReturnParkedRestock" (B665, same rule): a STANDARD return's restock the API
--    could not convert to pieces because the sold line's pack is unknown. It stores the qty as typed (in the
--    line's own unit) so the stock movement can book itself once an operator supplies the split. Same shape:
--    parked = "resolvedAt IS NULL", tenant FK ON DELETE CASCADE, UNIQUE ("returnItemId") for idempotent
--    retries, scalar pointers with no FK ("returnId", "returnItemId", "productId", "resolvedMovementId").
--
-- The indexes are plain CREATE INDEX (Prisma runs this file in ONE transaction, so CONCURRENTLY is not
-- available): the ledger index takes a SHARE lock while it builds and blocks ledger writes for the build (the
-- column is all NULL and the ledger is small; run it in a quiet minute); the new table's indexes are on an
-- empty table. lock_timeout bounds the WAIT for the brief ACCESS EXCLUSIVE lock ADD COLUMN needs and for the
-- lock the tenant FK takes on "Tenant" (SET LOCAL: scoped to this transaction).
--
-- ORDERING: apply to prod BEFORE the PR that adds these fields and this model to the Prisma schema merges. The
-- API image runs `prisma generate` at build time and Railway rebuilds on any apps/api/** change, so merging
-- that PR redeploys a client that selects these columns on every read of RegulatedSalesLedger: it 500s
-- until the columns exist. The reverse order is safe (old code names its columns explicitly and ignores
-- the new ones). Merge promptly after applying: until master's schema folder has them, the prod drift gate
-- reports drift.
--
-- Rollback (instant while the columns and the table are empty; the index goes with the column):
--   DROP TABLE "ReturnParkedRestock";
--   DROP TABLE "RegulatedLedgerParkedReversal";
--   DROP INDEX "RegulatedSalesLedger_correctsEntryId_idx";
--   ALTER TABLE "RegulatedSalesLedger" DROP COLUMN "originalSoldAt", DROP COLUMN "correctsEntryId";

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "RegulatedSalesLedger" ADD COLUMN "originalSoldAt" TIMESTAMP(3),
ADD COLUMN "correctsEntryId" TEXT;

-- CreateTable
CREATE TABLE "RegulatedLedgerParkedReversal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "saleEntryId" TEXT NOT NULL,
    "returnedPieces" DECIMAL(10,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "periodBucket" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "unitsPerBoxSupplied" INTEGER,
    "resolvedEntryId" TEXT,

    CONSTRAINT "RegulatedLedgerParkedReversal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnParkedRestock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "returnItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "returnedQty" DECIMAL(10,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "unitsPerBoxSupplied" INTEGER,
    "resolvedMovementId" TEXT,

    CONSTRAINT "ReturnParkedRestock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegulatedSalesLedger_correctsEntryId_idx" ON "RegulatedSalesLedger"("correctsEntryId");

-- CreateIndex
CREATE INDEX "RegulatedLedgerParkedReversal_tenantId_resolvedAt_idx" ON "RegulatedLedgerParkedReversal"("tenantId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatedLedgerParkedReversal_returnId_saleEntryId_key" ON "RegulatedLedgerParkedReversal"("returnId", "saleEntryId");

-- CreateIndex
CREATE INDEX "ReturnParkedRestock_tenantId_resolvedAt_idx" ON "ReturnParkedRestock"("tenantId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnParkedRestock_returnItemId_key" ON "ReturnParkedRestock"("returnItemId");

-- AddForeignKey
ALTER TABLE "RegulatedLedgerParkedReversal" ADD CONSTRAINT "RegulatedLedgerParkedReversal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnParkedRestock" ADD CONSTRAINT "ReturnParkedRestock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
