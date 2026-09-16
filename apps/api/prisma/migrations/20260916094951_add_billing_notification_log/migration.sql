-- CreateTable
CREATE TABLE "BillingNotificationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "milestone" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingNotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingNotificationLog_tenantId_idx" ON "BillingNotificationLog"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingNotificationLog_tenantId_milestone_key_key" ON "BillingNotificationLog"("tenantId", "milestone", "key");

-- AddForeignKey
ALTER TABLE "BillingNotificationLog" ADD CONSTRAINT "BillingNotificationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
