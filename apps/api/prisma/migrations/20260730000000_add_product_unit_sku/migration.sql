-- Optional retail-unit (inner piece) code; NULL means the unit shares the
-- case sku. Additive + nullable => safe on existing data.
ALTER TABLE "Product" ADD COLUMN "unitSku" TEXT;
CREATE UNIQUE INDEX "Product_tenantId_unitSku_key" ON "Product"("tenantId", "unitSku");
CREATE INDEX "Product_unitSku_idx" ON "Product"("unitSku");
