-- Sitting 3 (SA-741r2), folder 7/10: counter-sale seams.
--   - "Order"."registerKey" (nullable TEXT, no default) and "Order"."soldById" (nullable TEXT, FK to "User" ON DELETE SET NULL).
--   - the new table "CounterParkedCart" (a counter cart set aside, resumable until "expiresAt"): three btree indexes and
--     three foreign keys ("Tenant" ON DELETE CASCADE; "createdById" and "resumedById" to "User" ON DELETE SET NULL).
--   - btree "Order" ("tenantId", "counterSale", "createdAt").
-- LOCKS ON A POPULATED TABLE: each ALTER TABLE "Order" takes ACCESS EXCLUSIVE until COMMIT. The "Order_soldById_fkey"
-- validation scans "Order" while holding SHARE ROW EXCLUSIVE on "Order" and on "User" (the column is all-NULL, but the
-- scan still runs), so it blocks writes to both for the scan. The "Order" index build blocks writes to "Order" for the
-- build. RUN OFF-PEAK. If "Order" is larger than ~500k rows (the PR body carries the prod count), move the index into its
-- own folder `20261010090650_order_counter_sale_index` and apply it separately.
--
-- LOCK PROFILE: `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT inside the one transaction: a statement that
-- waits longer than 5s for its lock fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back <folder>` from apps/api, then re-run; NEVER `--applied`).
-- ADDITIVE ONLY, no data writes. HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge code that reads or writes these columns (none does yet).
--
-- Rollback (nothing reads or writes these yet):
--   DROP INDEX "Order_tenantId_counterSale_createdAt_idx";
--   DROP TABLE "CounterParkedCart";
--   ALTER TABLE "Order" DROP CONSTRAINT "Order_soldById_fkey";
--   ALTER TABLE "Order" DROP COLUMN "soldById", DROP COLUMN "registerKey";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "registerKey" TEXT,
ADD COLUMN     "soldById" TEXT;

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

-- CreateIndex
-- reason: index on populated "Order" (counterSale, createdAt are existing columns): blocks writes to "Order" for the build; the owner runs this sitting off-peak and the PR body carries the prod row count
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "Order_tenantId_counterSale_createdAt_idx" ON "Order"("tenantId", "counterSale", "createdAt");

-- AddForeignKey
-- reason: "soldById" is a new all-NULL column, so validation finds no violating row; it still scans "Order" under SHARE ROW EXCLUSIVE on "Order" and "User", run off-peak
-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "Order" ADD CONSTRAINT "Order_soldById_fkey" FOREIGN KEY ("soldById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
