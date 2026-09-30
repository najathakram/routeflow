-- BUY_N_GET_M snapshot on the invoice line, mirroring OrderItem.promoFreeUnits.
-- The DRAFT invoice edit path delete-and-recreates every line from the submitted
-- payload, so without this column an order-derived BOGO line re-prices to full
-- (12 x $35 = $420 instead of the agreed $350). Additive only: one nullable
-- column, no backfill (null == no free units, same as today).

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN "promoFreeUnits" INTEGER;
