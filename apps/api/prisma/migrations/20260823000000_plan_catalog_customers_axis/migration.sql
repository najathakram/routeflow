-- Plan catalog v8: customer-count axis.
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in
-- Postgres, so this file is intentionally NOT wrapped in BEGIN/COMMIT and the
-- enum addition is its own statement, run first.

-- AlterEnum
ALTER TYPE "MeterKey" ADD VALUE 'CUSTOMERS';

-- AlterTable
ALTER TABLE "PlanDefinition" ADD COLUMN "customersIncluded" INTEGER;
