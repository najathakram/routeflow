-- Sitting 3 (SA-741r2), folder 6/10: the new table "CounterDayClose" (one closed counter day per tenant, register and
-- window: frozen cash count and totals; `reopenedAt` marks an undone close).
-- Brand-new empty table: a unique index ("tenantId", "registerKey", "windowStart"), a btree ("tenantId", "day") and three
-- foreign keys ("Tenant" ON DELETE RESTRICT; "closedById" and "reopenedById" to "User" ON DELETE SET NULL). Adding an FK
-- takes SHARE ROW EXCLUSIVE on the referenced table ("Tenant", "User") for the instant it checks the empty table.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes it yet):
--   DROP TABLE "CounterDayClose";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "CounterDayClose" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "registerKey" TEXT NOT NULL DEFAULT 'main',
    "day" DATE NOT NULL,
    "zone" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "openingFloat" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "expectedCash" DECIMAL(10,2) NOT NULL,
    "countedCash" DECIMAL(10,2) NOT NULL,
    "variance" DECIMAL(10,2) NOT NULL,
    "denominations" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "notes" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CounterDayClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "CounterDayClose_tenantId_day_idx" ON "CounterDayClose"("tenantId", "day");

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "CounterDayClose_tenantId_registerKey_windowStart_key" ON "CounterDayClose"("tenantId", "registerKey", "windowStart");

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "CounterDayClose" ADD CONSTRAINT "CounterDayClose_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "CounterDayClose" ADD CONSTRAINT "CounterDayClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "CounterDayClose" ADD CONSTRAINT "CounterDayClose_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
