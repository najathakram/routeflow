-- SA-1124 PR-0 (offline staff order create, server half, folder alone; spec SA-1124, SA-817 §6): the review-flag table and the
-- device-time column an offline replay needs. Nothing in the app reads or writes any of it yet (PR-1a and later).
--   "OrderReviewFlagKind"     new enum: PRICE_CHANGED_OFFLINE | RESTRICTED | LICENSE_REQUIRED | CREDIT_BLOCKED |
--                             OPEN_ORDER_EXISTS | BACKORDERED_OFFLINE
--   "OrderReviewFlag"         new table, one row per reason an order needs a person's look. "tenantId" is NOT NULL from day one.
--                             FKs: "Tenant" RESTRICT, "Order" CASCADE, "OrderItem" SET NULL (a line edit replaces items; the
--                             "detail" JSON keeps the line index and product), "User" SET NULL (the resolver). Indexes
--                             ("tenantId","orderId") and ("tenantId","kind","resolvedAt") (the Needs-review list), plus one
--                             on each FK column with no leading index ("orderId", "orderItemId", "resolvedById"): without them
--                             every "OrderItem"/"Order"/"User" delete scans this table for the FK check.
--                             Two inline CHECKs (raw SQL; Prisma does not model them):
--                               "OrderReviewFlag_resolution_pair"  ("resolvedAt" IS NULL) = ("resolution" IS NULL)
--                               "OrderReviewFlag_resolution_len"   "resolution" IS NULL OR char_length("resolution") BETWEEN 3 AND 500
--   "Order"."offlineCreatedAt" TIMESTAMP(3) NULL (device time, display only; no default, no backfill, no FK)
--
-- Additive only: a new enum, a new empty table, one nullable column (metadata-only ADD COLUMN, no rewrite). Nothing dropped,
-- rewritten or backfilled; every existing "Order" row is NULL.
-- LOCK PROFILE: ONE transaction. A brief ACCESS EXCLUSIVE on "Order" for the ADD COLUMN, and SHARE ROW EXCLUSIVE on "Tenant",
-- "Order", "OrderItem" and "User" for the four foreign keys; no scan of an existing row (the new table is empty, so the FKs and
-- CHECKs validate nothing). `SET LOCAL lock_timeout = '5s'` bounds every wait; a timeout rolls the whole file back (recorded
-- FAILED; recover with `prisma migrate resolve --rolled-back 20261110000000_order_review_flags_offline` from apps/api, then
-- re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): merging this PR BEFORE the objects exist in production is NOT safe. The generated Prisma client
-- selects `Order.offlineCreatedAt` on every order read, so every one of those reads fails with P2022 until the migration has
-- run, and nothing auto-migrates on deploy. Order: fresh backup, `prod-migrate.mjs` (owner sitting), `schema-drift.mjs` exit 0,
-- THEN merge (and only then SA-1124 PR-1a, the code that writes them). No application code reads or writes the new objects in
-- this PR; the client select of the new "Order" column is the whole dependence.
--
-- Rollback (nothing references the objects yet):
--   DROP TABLE "OrderReviewFlag"; DROP TYPE "OrderReviewFlagKind"; ALTER TABLE "Order" DROP COLUMN "offlineCreatedAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "OrderReviewFlagKind" AS ENUM ('PRICE_CHANGED_OFFLINE', 'RESTRICTED', 'LICENSE_REQUIRED', 'CREDIT_BLOCKED', 'OPEN_ORDER_EXISTS', 'BACKORDERED_OFFLINE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "offlineCreatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderReviewFlag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "kind" "OrderReviewFlagKind" NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,

    CONSTRAINT "OrderReviewFlag_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderReviewFlag_resolution_pair" CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL)),
    CONSTRAINT "OrderReviewFlag_resolution_len" CHECK ("resolution" IS NULL OR char_length("resolution") BETWEEN 3 AND 500)
);

-- CreateIndex
CREATE INDEX "OrderReviewFlag_tenantId_orderId_idx" ON "OrderReviewFlag"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "OrderReviewFlag_tenantId_kind_resolvedAt_idx" ON "OrderReviewFlag"("tenantId", "kind", "resolvedAt");

-- CreateIndex
CREATE INDEX "OrderReviewFlag_orderId_idx" ON "OrderReviewFlag"("orderId");

-- CreateIndex
CREATE INDEX "OrderReviewFlag_orderItemId_idx" ON "OrderReviewFlag"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderReviewFlag_resolvedById_idx" ON "OrderReviewFlag"("resolvedById");

-- AddForeignKey
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
