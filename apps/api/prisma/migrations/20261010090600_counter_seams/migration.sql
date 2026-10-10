-- Sitting 3 (SA-741r2), folder 7/10: counter-sale seams.
--   - "Order"."registerKey" (nullable TEXT, no default), "Order"."soldById" (nullable TEXT, FK to "User" ON DELETE SET NULL)
--     and "Order"."counterCashTendered" (nullable DECIMAL(10,2), no default; SA-762 §C2).
--   - the new table "CounterParkedCart" (a counter cart set aside, resumable until "expiresAt"): three btree indexes and
--     three foreign keys ("Tenant" ON DELETE CASCADE; "createdById" and "resumedById" to "User" ON DELETE SET NULL).
--   (the two "Order" indexes for these seams are in the NEXT folder, 20261010090650_order_counter_seams_indexes, so their
--   SHARE-lock builds do not run under this file's ACCESS EXCLUSIVE lock.)
-- LOCKS ON A POPULATED TABLE: the ALTER TABLE "Order" takes ACCESS EXCLUSIVE and holds it until COMMIT. "soldById" is added
-- WITH its foreign key INLINE (`ADD COLUMN ... CONSTRAINT "Order_soldById_fkey" REFERENCES`): Postgres does not scan the
-- table for a new column without a default, so there is no validation scan (the constraint name is the one Prisma
-- generates, so no drift). With no index build in this file, the ACCESS EXCLUSIVE window is just the catalog changes.
-- RUN OFF-PEAK anyway ("Order" is the hottest table).
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes these yet):
--   DROP TABLE "CounterParkedCart";
--   ALTER TABLE "Order" DROP CONSTRAINT "Order_soldById_fkey";
--   ALTER TABLE "Order" DROP COLUMN "counterCashTendered", DROP COLUMN "soldById", DROP COLUMN "registerKey";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
-- reason: inline FK on a new no-default column skips the validation scan
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "Order" ADD COLUMN "registerKey" TEXT, ADD COLUMN "soldById" TEXT CONSTRAINT "Order_soldById_fkey" REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE, ADD COLUMN "counterCashTendered" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "CounterParkedCart" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "registerKey" TEXT NOT NULL DEFAULT 'main',
    "createdById" TEXT,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resumedAt" TIMESTAMP(3),
    "resumedById" TEXT,

    CONSTRAINT "CounterParkedCart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "CounterParkedCart_tenantId_registerKey_createdAt_idx" ON "CounterParkedCart"("tenantId", "registerKey", "createdAt");

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "CounterParkedCart_expiresAt_idx" ON "CounterParkedCart"("expiresAt");

-- CreateIndex
-- reason: brand-new empty table
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "CounterParkedCart_resumedAt_idx" ON "CounterParkedCart"("resumedAt");

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "CounterParkedCart" ADD CONSTRAINT "CounterParkedCart_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "CounterParkedCart" ADD CONSTRAINT "CounterParkedCart_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- reason: brand-new empty table; adding the FK scans nothing
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "CounterParkedCart" ADD CONSTRAINT "CounterParkedCart_resumedById_fkey" FOREIGN KEY ("resumedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
