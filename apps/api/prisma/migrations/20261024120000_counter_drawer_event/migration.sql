-- W-819 part 1 / SA-930 section 4 (opening float): the till counts the drawer at open and the count is locked.
--   CREATE TYPE "CounterDrawerEventKind" ('OPENING_FLOAT')  -- the seam where cash drops / paid-outs go later (additive ADD VALUE)
--   CREATE TABLE "CounterDrawerEvent" + the unique (tenantId, registerKey, windowStart, kind) the record path conflicts on
--   and a btree (tenantId, windowStart) for tenant lookups.
--   "windowStart" is the same zoneless TIMESTAMP(3) key "CounterDayClose" uses. "byId" is a plain id (no FK), like the model.
--   Two CHECKs at the database, whatever writes it: the amount is non-negative, and it is not NaN (SA-816 (d)1).
--
-- NEW OBJECTS ONLY: one new type, a new empty table and its two indexes. No existing table is altered, scanned or locked.
-- LOCK PROFILE: ONE transaction; the only locks are on the new objects. `SET LOCAL lock_timeout = '5s'` bounds each wait anyway
-- (the house rule). ADDITIVE ONLY, no data writes, no backfill (a window with no event keeps today's typed float).
-- DEPLOY ORDER (L-184): LOCAL ONLY today. The prod apply waits for the owner's sitting (OQ-18): fresh backup, `prod-migrate.mjs`,
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that depends on it in production.
--
-- Rollback (instant; nothing else references it):
--   DROP TABLE "CounterDrawerEvent";
--   DROP TYPE "CounterDrawerEventKind";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "CounterDrawerEventKind" AS ENUM ('OPENING_FLOAT');

-- CreateTable
CREATE TABLE "CounterDrawerEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "registerKey" TEXT NOT NULL DEFAULT 'main',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "kind" "CounterDrawerEventKind" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "denominations" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byId" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "CounterDrawerEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CounterDrawerEvent_amount_chk" CHECK ("amount" >= 0)
);

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "CounterDrawerEvent_tenantId_windowStart_idx" ON "CounterDrawerEvent"("tenantId", "windowStart");

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "CounterDrawerEvent_tenantId_registerKey_windowStart_kind_key" ON "CounterDrawerEvent"("tenantId", "registerKey", "windowStart", "kind");

-- SA-816 (d)1 NaN backstop: NUMERIC accepts 'NaN' and NaN sorts above every number, so `>= 0` does not stop it.
-- Same shape the generator emits (`<table>_<column>_not_nan`, NOT VALID); the table is new and empty, so nothing to scan.
ALTER TABLE "CounterDrawerEvent"
  ADD CONSTRAINT "CounterDrawerEvent_amount_not_nan" CHECK ("amount" <> 'NaN'::numeric) NOT VALID;

COMMIT;
