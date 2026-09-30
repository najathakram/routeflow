-- MSRP (suggested retail price) — display-only, never money math.
-- Product.msrp = universal default per PIECE; CustomerPrice.msrp = per-customer override.
-- InvoiceItem.msrp = the value snapshotted when the line was created, so an issued
-- invoice never changes when the product's MSRP is later edited.
-- CustomerPrice.pricingTier becomes nullable: a row may now carry only an MSRP override.
-- Every pricingTier reader already falls back (`?? customer default`), so null is safe.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "msrp" DECIMAL(10,2);
ALTER TABLE "CustomerPrice" ADD COLUMN IF NOT EXISTS "msrp" DECIMAL(10,2);
ALTER TABLE "CustomerPrice" ALTER COLUMN "pricingTier" DROP NOT NULL;
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "msrp" DECIMAL(10,2);
