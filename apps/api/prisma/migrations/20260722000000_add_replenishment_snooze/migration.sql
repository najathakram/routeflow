-- P5-06: buyer replenishment snooze ("not this cycle"). Additive-only — one new
-- table + indexes; no existing column/row changes, no backfill.
CREATE TABLE "ReplenishmentSnooze" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "snoozedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReplenishmentSnooze_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReplenishmentSnooze_tenantId_customerId_productId_key" ON "ReplenishmentSnooze"("tenantId", "customerId", "productId");
CREATE INDEX "ReplenishmentSnooze_customerId_idx" ON "ReplenishmentSnooze"("customerId");
CREATE INDEX "ReplenishmentSnooze_tenantId_idx" ON "ReplenishmentSnooze"("tenantId");
ALTER TABLE "ReplenishmentSnooze" ADD CONSTRAINT "ReplenishmentSnooze_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReplenishmentSnooze" ADD CONSTRAINT "ReplenishmentSnooze_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplenishmentSnooze" ADD CONSTRAINT "ReplenishmentSnooze_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
