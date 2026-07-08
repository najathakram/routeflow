-- Minimize & resume drafts (pos-cost-roles-spec §2).
-- Purely additive: creates one new table + its index + FK. Touches no existing
-- table and no existing rows.

-- CreateTable
CREATE TABLE "SaleDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ORDER',
    "customerId" TEXT,
    "customerName" TEXT,
    "title" TEXT,
    "payload" JSONB NOT NULL,
    "device" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaleDraft_tenantId_userId_updatedAt_idx" ON "SaleDraft"("tenantId", "userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "SaleDraft" ADD CONSTRAINT "SaleDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
