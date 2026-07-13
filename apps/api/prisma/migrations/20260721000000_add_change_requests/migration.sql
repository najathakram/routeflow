-- P5-09: post-dispatch change-request engine. Additive-only — two new enums +
-- one new table; no existing column/row changes, no backfill.
CREATE TYPE "ChangeRequestType" AS ENUM ('ADD_ITEM', 'CHANGE_QTY', 'REMOVE_ITEM', 'NOTE');
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "routeRunStopId" TEXT,
    "type" "ChangeRequestType" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "note" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "requestedByRole" TEXT,
    "resolvedById" TEXT,
    "resolvedByName" TEXT,
    "resolvedByRole" TEXT,
    "resolution" TEXT,
    "resolutionReason" TEXT,
    "nextOrderId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChangeRequest_tenantId_idx" ON "ChangeRequest"("tenantId");
CREATE INDEX "ChangeRequest_orderId_idx" ON "ChangeRequest"("orderId");
CREATE INDEX "ChangeRequest_status_idx" ON "ChangeRequest"("status");
CREATE INDEX "ChangeRequest_routeRunStopId_idx" ON "ChangeRequest"("routeRunStopId");
CREATE INDEX "ChangeRequest_createdAt_idx" ON "ChangeRequest"("createdAt");
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_routeRunStopId_fkey" FOREIGN KEY ("routeRunStopId") REFERENCES "RouteRunStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
