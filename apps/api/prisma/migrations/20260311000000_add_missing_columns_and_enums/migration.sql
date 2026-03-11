-- CreateEnum
CREATE TYPE "RouteRunStopStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

-- AlterEnum
BEGIN;
CREATE TYPE "ItemStatus_new" AS ENUM ('PENDING', 'CONFIRMED', 'PARTIAL', 'DELIVERED', 'CANCELLED');
ALTER TABLE "public"."OrderItem" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OrderItem" ALTER COLUMN "status" TYPE "ItemStatus_new" USING ("status"::text::"ItemStatus_new");
ALTER TYPE "ItemStatus" RENAME TO "ItemStatus_old";
ALTER TYPE "ItemStatus_new" RENAME TO "ItemStatus";
DROP TYPE "public"."ItemStatus_old";
ALTER TABLE "OrderItem" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropIndex
DROP INDEX "Transaction_orderId_idx";

-- AlterTable
ALTER TABLE "DeliveryMutation" ADD COLUMN     "driverId" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "quantityDelivered" DECIMAL(10,3),
ADD COLUMN     "routeRunStopId" TEXT;

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "routeRunStopId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ALTER COLUMN "subtotal" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "RouteRunStop" ADD COLUMN     "customerAddressId" TEXT,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "driverNote" TEXT,
ADD COLUMN     "status" "RouteRunStopStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "pdfUrl" TEXT;

-- CreateIndex
CREATE INDEX "DeliveryMutation_routeRunStopId_idx" ON "DeliveryMutation"("routeRunStopId");

-- CreateIndex
CREATE INDEX "DeliveryMutation_driverId_idx" ON "DeliveryMutation"("driverId");

-- CreateIndex
CREATE INDEX "Order_routeRunStopId_idx" ON "Order"("routeRunStopId");

-- CreateIndex
CREATE INDEX "RouteRunStop_customerId_idx" ON "RouteRunStop"("customerId");

-- CreateIndex
CREATE INDEX "RouteRunStop_customerAddressId_idx" ON "RouteRunStop"("customerAddressId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "Transaction_orderId_key" ON "Transaction"("orderId");

-- AddForeignKey
ALTER TABLE "RouteRunStop" ADD CONSTRAINT "RouteRunStop_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteRunStop" ADD CONSTRAINT "RouteRunStop_customerAddressId_fkey" FOREIGN KEY ("customerAddressId") REFERENCES "CustomerAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_routeRunStopId_fkey" FOREIGN KEY ("routeRunStopId") REFERENCES "RouteRunStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryMutation" ADD CONSTRAINT "DeliveryMutation_routeRunStopId_fkey" FOREIGN KEY ("routeRunStopId") REFERENCES "RouteRunStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryMutation" ADD CONSTRAINT "DeliveryMutation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
