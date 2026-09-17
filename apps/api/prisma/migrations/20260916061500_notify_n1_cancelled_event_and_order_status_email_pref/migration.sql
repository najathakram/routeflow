-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "orderStatusEmails" BOOLEAN NOT NULL DEFAULT true;
