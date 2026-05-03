-- Adds split-invoice tracking on OrderItem + explicit skip flag on Order so
-- "Create as separate order" decisions are not undone by the auto-merge cron.

ALTER TABLE "OrderItem"
  ADD COLUMN "invoicedQty" DECIMAL(10, 3) NOT NULL DEFAULT 0;

ALTER TABLE "Order"
  ADD COLUMN "skipAutoMerge" BOOLEAN NOT NULL DEFAULT false;
