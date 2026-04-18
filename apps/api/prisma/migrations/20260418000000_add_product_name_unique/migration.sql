-- merge-duplicate-products.js must be run BEFORE this migration is applied
-- to eliminate any existing duplicates. The unique constraint will fail if
-- duplicate (tenantId, name) rows still exist.

CREATE UNIQUE INDEX "Product_tenantId_name_key" ON "Product"("tenantId", "name");
