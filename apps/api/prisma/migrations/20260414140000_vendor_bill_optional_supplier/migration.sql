-- Make supplierId optional on VendorBill so that imported inventory-purchase
-- expenses can be converted to vendor bills even when no supplier is known yet.
ALTER TABLE "VendorBill" ALTER COLUMN "supplierId" DROP NOT NULL;
