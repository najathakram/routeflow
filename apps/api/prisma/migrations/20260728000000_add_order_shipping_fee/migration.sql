-- Optional per-order shipping fee. Additive-only: default 0 keeps every existing
-- order's total unchanged (total math starts reading the column only after the
-- app deploy that follows this migration). Never taxed — added after tax, same
-- convention as Invoice.shippingFee. Idempotent.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shippingFee" DECIMAL(10,2) NOT NULL DEFAULT 0;
