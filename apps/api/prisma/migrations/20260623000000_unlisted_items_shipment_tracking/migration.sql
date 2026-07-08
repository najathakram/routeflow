-- Unlisted (ad-hoc, non-catalog) line items + carrier shipment tracking.
--
-- 1. OrderItem.productId becomes nullable and a free-text `name` is added so an
--    order can carry one-off items that are not in the product catalog. The
--    existing OrderItem_productId_fkey stays valid — Postgres allows NULL FKs.
-- 2. Order + Invoice gain carrier shipment tracking (carrier label + tracking
--    number + shippedAt) for goods shipped via a carrier instead of our own route.
--    Order values are copied onto the Invoice(s) generated from the order.

ALTER TABLE "OrderItem"
  ALTER COLUMN "productId" DROP NOT NULL,
  ADD COLUMN "name" TEXT;

ALTER TABLE "Order"
  ADD COLUMN "shippingCarrier" TEXT,
  ADD COLUMN "shippingTrackingNumber" TEXT,
  ADD COLUMN "shippedAt" TIMESTAMP(3);

ALTER TABLE "Invoice"
  ADD COLUMN "shippingCarrier" TEXT,
  ADD COLUMN "shippingTrackingNumber" TEXT,
  ADD COLUMN "shippedAt" TIMESTAMP(3);
