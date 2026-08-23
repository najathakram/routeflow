-- Add geocoding columns to Supplier (additive, nullable)
ALTER TABLE "Supplier" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "Supplier" ADD COLUMN "lng" DOUBLE PRECISION;
