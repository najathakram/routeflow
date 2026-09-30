-- Marketing demo bookings. Purely additive: one new enum and one new table,
-- no FK to any existing table, nothing altered. The table is deliberately NOT
-- tenant-scoped — a prospect booking a walkthrough has no workspace yet.

-- CreateEnum
CREATE TYPE "DemoBookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "DemoBooking" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timeZone" TEXT NOT NULL,
    "status" "DemoBookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "googleEventId" TEXT,
    "meetUrl" TEXT,
    "manageTokenHash" TEXT NOT NULL,
    "rescheduledFrom" TIMESTAMP(3),
    "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "sourcePage" TEXT,
    "createdIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemoBooking_manageTokenHash_key" ON "DemoBooking"("manageTokenHash");

-- CreateIndex
CREATE INDEX "DemoBooking_startsAt_status_idx" ON "DemoBooking"("startsAt", "status");

-- CreateIndex
CREATE INDEX "DemoBooking_email_createdAt_idx" ON "DemoBooking"("email", "createdAt");
