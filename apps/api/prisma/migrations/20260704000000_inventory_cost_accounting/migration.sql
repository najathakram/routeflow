-- AlterEnum: manual cost-basis movement type (quantity always 0)
ALTER TYPE "MovementType" ADD VALUE 'COST_BASIS';

-- AlterTable: running snapshots — product state AFTER each movement.
-- Point-in-time average cost = avgCostAfter of the latest movement <= T.
ALTER TABLE "StockMovement" ADD COLUMN "avgCostAfter" DECIMAL(10,4),
ADD COLUMN "stockAfter" DECIMAL(10,3);
