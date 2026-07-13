-- P5-08: append-only order revision history. Additive-only — new table, no
-- existing column/row changes, no backfill.
CREATE TABLE "OrderRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "orderId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "editedById" TEXT,
    "editedByName" TEXT,
    "editedByRole" TEXT,
    "source" TEXT NOT NULL DEFAULT 'EDIT',
    "reason" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderRevision_orderId_revisionNumber_key" ON "OrderRevision"("orderId","revisionNumber");
CREATE INDEX "OrderRevision_tenantId_idx" ON "OrderRevision"("tenantId");
CREATE INDEX "OrderRevision_orderId_idx" ON "OrderRevision"("orderId");
CREATE INDEX "OrderRevision_createdAt_idx" ON "OrderRevision"("createdAt");
ALTER TABLE "OrderRevision" ADD CONSTRAINT "OrderRevision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderRevision" ADD CONSTRAINT "OrderRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
