-- CreateTable
CREATE TABLE "DriverLocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "driverId" TEXT NOT NULL,
    "runId" TEXT,
    "lat" DECIMAL(10,7) NOT NULL,
    "lng" DECIMAL(10,7) NOT NULL,
    "heading" DECIMAL(6,2),
    "speedKph" DECIMAL(6,2),
    "batteryPct" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverLocation_tenantId_driverId_recordedAt_idx" ON "DriverLocation"("tenantId", "driverId", "recordedAt");

-- CreateIndex
CREATE INDEX "DriverLocation_tenantId_runId_recordedAt_idx" ON "DriverLocation"("tenantId", "runId", "recordedAt");

-- AddForeignKey
ALTER TABLE "DriverLocation" ADD CONSTRAINT "DriverLocation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocation" ADD CONSTRAINT "DriverLocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RouteRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocation" ADD CONSTRAINT "DriverLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
