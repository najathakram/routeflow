-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('INTERNAL', 'WHATSAPP', 'SMS', 'EMAIL', 'PORTAL');

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('OPEN', 'SNOOZED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WaApprovalStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TriageStatus" AS ENUM ('PENDING', 'LINKED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('ORDER_CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'ORDER_CHANGED_AT_DOOR', 'INVOICE_SENT', 'PAYMENT_REMINDER', 'LICENSE_EXPIRING', 'URGENT_ORDER_PLACED', 'LOW_STOCK', 'FAILED_DELIVERY', 'PAYMENT_FAILED_NSF');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "consentUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "smsConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "waConsent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "channel" "MessageChannel" NOT NULL DEFAULT 'INTERNAL',
ADD COLUMN     "threadId" TEXT;

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "lastChannel" "MessageChannel",
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ThreadStatus" NOT NULL DEFAULT 'OPEN',
    "snoozedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "eventKey" "NotificationEvent" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "waTemplateName" TEXT,
    "waApprovalStatus" "WaApprovalStatus" NOT NULL DEFAULT 'NONE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "eventKey" "NotificationEvent" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageOptOut" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "phone" TEXT,
    "channel" "MessageChannel" NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "source" TEXT,

    CONSTRAINT "MessageOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursStart" TEXT NOT NULL DEFAULT '21:00',
    "quietHoursEnd" TEXT NOT NULL DEFAULT '07:00',
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundTriage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "channel" "MessageChannel" NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "providerMsgId" TEXT,
    "status" "TriageStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedCustomerId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundTriage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageThread_tenantId_idx" ON "MessageThread"("tenantId");

-- CreateIndex
CREATE INDEX "MessageThread_tenantId_customerId_idx" ON "MessageThread"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "MessageThread_tenantId_lastMessageAt_idx" ON "MessageThread"("tenantId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThread_tenantId_status_idx" ON "MessageThread"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MessageTemplate_tenantId_idx" ON "MessageTemplate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_tenantId_eventKey_channel_key" ON "MessageTemplate"("tenantId", "eventKey", "channel");

-- CreateIndex
CREATE INDEX "NotificationRule_tenantId_idx" ON "NotificationRule"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRule_tenantId_eventKey_channel_key" ON "NotificationRule"("tenantId", "eventKey", "channel");

-- CreateIndex
CREATE INDEX "MessageOptOut_tenantId_idx" ON "MessageOptOut"("tenantId");

-- CreateIndex
CREATE INDEX "MessageOptOut_tenantId_phone_idx" ON "MessageOptOut"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "MessageOptOut_tenantId_customerId_channel_key" ON "MessageOptOut"("tenantId", "customerId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingSettings_tenantId_key" ON "MessagingSettings"("tenantId");

-- CreateIndex
CREATE INDEX "MessagingSettings_tenantId_idx" ON "MessagingSettings"("tenantId");

-- CreateIndex
CREATE INDEX "InboundTriage_tenantId_idx" ON "InboundTriage"("tenantId");

-- CreateIndex
CREATE INDEX "InboundTriage_tenantId_status_idx" ON "InboundTriage"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Message_threadId_idx" ON "Message"("threadId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOptOut" ADD CONSTRAINT "MessageOptOut_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageOptOut" ADD CONSTRAINT "MessageOptOut_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingSettings" ADD CONSTRAINT "MessagingSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundTriage" ADD CONSTRAINT "InboundTriage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

