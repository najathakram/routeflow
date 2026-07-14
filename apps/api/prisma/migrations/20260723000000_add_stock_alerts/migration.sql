-- P5-03: buyer stock alerts ("Notify me" waitlist). Additive-only — one new
-- enum + table + indexes; no existing column/row changes, no backfill.
CREATE TYPE "StockAlertStatus" AS ENUM ('PENDING', 'NOTIFIED');

CREATE TABLE "StockAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "StockAlertStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockAlert_tenantId_customerId_productId_key" ON "StockAlert"("tenantId", "customerId", "productId");
CREATE INDEX "StockAlert_productId_idx" ON "StockAlert"("productId");
CREATE INDEX "StockAlert_tenantId_idx" ON "StockAlert"("tenantId");

ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
