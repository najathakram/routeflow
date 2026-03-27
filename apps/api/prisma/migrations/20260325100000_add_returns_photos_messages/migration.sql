-- Create ReturnReason enum if not exists
DO $$ BEGIN
  CREATE TYPE "ReturnReason" AS ENUM ('DAMAGED', 'WRONG_ITEM', 'CUSTOMER_REFUSED', 'QUALITY_ISSUE', 'EXCESS_ORDER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create ReturnStatus enum if not exists
DO $$ BEGIN
  CREATE TYPE "ReturnStatus" AS ENUM ('PENDING', 'PROCESSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create Return table
CREATE TABLE IF NOT EXISTS "Return" (
    "id"           TEXT NOT NULL,
    "returnNumber" TEXT,
    "orderId"      TEXT NOT NULL,
    "customerId"   TEXT NOT NULL,
    "reason"       "ReturnReason" NOT NULL,
    "status"       "ReturnStatus" NOT NULL DEFAULT 'PENDING',
    "notes"        TEXT,
    "photoUrls"    TEXT[] DEFAULT ARRAY[]::TEXT[],
    "creditNoteId" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Return_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on returnNumber
CREATE UNIQUE INDEX IF NOT EXISTS "Return_returnNumber_key" ON "Return"("returnNumber");

-- Indexes on Return
CREATE INDEX IF NOT EXISTS "Return_orderId_idx"    ON "Return"("orderId");
CREATE INDEX IF NOT EXISTS "Return_customerId_idx" ON "Return"("customerId");
CREATE INDEX IF NOT EXISTS "Return_status_idx"     ON "Return"("status");

-- Foreign keys for Return
ALTER TABLE "Return" ADD CONSTRAINT "Return_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Return" ADD CONSTRAINT "Return_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create ReturnItem table
CREATE TABLE IF NOT EXISTS "ReturnItem" (
    "id"        TEXT NOT NULL,
    "returnId"  TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty"       DECIMAL(10,3) NOT NULL,
    "reason"    TEXT,
    "restock"   BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReturnItem_pkey" PRIMARY KEY ("id")
);

-- Indexes on ReturnItem
CREATE INDEX IF NOT EXISTS "ReturnItem_returnId_idx"  ON "ReturnItem"("returnId");
CREATE INDEX IF NOT EXISTS "ReturnItem_productId_idx" ON "ReturnItem"("productId");

-- Foreign keys for ReturnItem
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_returnId_fkey"
    FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add Message model for driver-dispatcher messaging
CREATE TABLE IF NOT EXISTS "Message" (
    "id"         TEXT NOT NULL,
    "runId"      TEXT,
    "text"       TEXT NOT NULL,
    "senderId"   TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- Indexes on Message
CREATE INDEX IF NOT EXISTS "Message_runId_idx"    ON "Message"("runId");
CREATE INDEX IF NOT EXISTS "Message_senderId_idx" ON "Message"("senderId");

-- Foreign key for Message.senderId -> User.id
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
