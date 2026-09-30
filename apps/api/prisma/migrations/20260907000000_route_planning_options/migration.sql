-- Route planning options: choosable/editable end point, avoid-tolls, optimize-by metric,
-- a record of how the start point was chosen, and a cached planned polyline.
-- Additive only — new enum types + nullable/defaulted columns, no backfill.

CREATE TYPE "RouteOriginKind" AS ENUM ('TENANT', 'DRIVER', 'ADDRESS');
CREATE TYPE "RouteEndKind" AS ENUM ('NONE', 'RETURN_TO_START', 'DRIVER_HOME', 'ADDRESS');
CREATE TYPE "RouteOptimizeMetric" AS ENUM ('TIME', 'DISTANCE');

ALTER TABLE "Route" ADD COLUMN "originKind" "RouteOriginKind";
ALTER TABLE "Route" ADD COLUMN "endKind" "RouteEndKind" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Route" ADD COLUMN "endLat" DOUBLE PRECISION;
ALTER TABLE "Route" ADD COLUMN "endLng" DOUBLE PRECISION;
ALTER TABLE "Route" ADD COLUMN "endAddress" TEXT;
ALTER TABLE "Route" ADD COLUMN "avoidTolls" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Route" ADD COLUMN "optimizeBy" "RouteOptimizeMetric" NOT NULL DEFAULT 'TIME';
ALTER TABLE "Route" ADD COLUMN "plannedPolyline" TEXT;
