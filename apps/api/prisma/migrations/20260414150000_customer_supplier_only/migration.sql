-- Mark customers who are actually vendors/suppliers so they can be hidden
-- from the Customers list without deleting their records.
ALTER TABLE "Customer" ADD COLUMN "supplierOnly" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Customer_supplierOnly_idx" ON "Customer"("supplierOnly");
