-- W-1286 / SA-1202 M1 (PR-1 "record and route"): the record a later bounce is matched against.
--   EmailDelivery: route, refToken (UNIQUE, nullable), fallbackReason, bouncedAt, bounceCode   (5 nullable columns)
--   Customer: emailBouncedAt, emailBounceCode                                                  (2 nullable columns)
--   CREATE TABLE "EmailBounceNotice"      (noticeKey UNIQUE; written by the PR-2 reader, pruned at 90 days)
--   CREATE TABLE "EmailBounceSourceState" (one heartbeat row per bounce source; written by the PR-2 reader)
--
-- ADDITIVE ONLY: every new column is nullable with no default, no enum change, no data write, no backfill. Nothing
-- reads or writes bouncedAt, bounceCode or the Customer columns in PR-1 (the reader and the flag are PR-2).
-- LOCK PROFILE: ONE transaction. ADD COLUMN with no default is metadata-only (no rewrite, no scan); the ACCESS
-- EXCLUSIVE lock on "EmailDelivery" and "Customer" is brief. The one index on an existing table, the UNIQUE index on
-- the new all-null "refToken" column, scans the table once (SA-1202 A3: read the EmailDelivery row count first;
-- over 1M rows goes back to the SA). `SET LOCAL lock_timeout = '5s'` bounds each wait; a timeout rolls the whole file
-- back (recorded FAILED; recover with `prisma migrate resolve --rolled-back 20261121000000_email_delivery_route_ref_bounce`
-- from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and ONLY THEN
-- merge the code that writes these columns.
--
-- Rollback (nothing else references them):
--   DROP INDEX "EmailDelivery_refToken_key";
--   ALTER TABLE "EmailDelivery" DROP COLUMN "route", DROP COLUMN "refToken", DROP COLUMN "fallbackReason",
--     DROP COLUMN "bouncedAt", DROP COLUMN "bounceCode";
--   ALTER TABLE "Customer" DROP COLUMN "emailBouncedAt", DROP COLUMN "emailBounceCode";
--   DROP TABLE "EmailBounceNotice"; DROP TABLE "EmailBounceSourceState";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "emailBounceCode" TEXT,
ADD COLUMN     "emailBouncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EmailDelivery" ADD COLUMN     "bounceCode" TEXT,
ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "fallbackReason" TEXT,
ADD COLUMN     "refToken" TEXT,
ADD COLUMN     "route" TEXT;

-- CreateTable
CREATE TABLE "EmailBounceNotice" (
    "id" TEXT NOT NULL,
    "noticeKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "code" TEXT,
    "matchKey" TEXT,
    "deliveryId" TEXT,
    "tenantId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "EmailBounceNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailBounceSourceState" (
    "source" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorClass" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailBounceSourceState_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
-- (a new empty table: no ignore needed)
CREATE UNIQUE INDEX "EmailBounceNotice_noticeKey_key" ON "EmailBounceNotice"("noticeKey");

-- CreateIndex
-- reason: "refToken" is a new all-null column; a plain unique index in Prisma's single transaction (SA-1202 A3, C8)
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "EmailDelivery_refToken_key" ON "EmailDelivery"("refToken");

COMMIT;
