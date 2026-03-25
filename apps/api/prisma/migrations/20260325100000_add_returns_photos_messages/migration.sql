-- Add photoUrls to Return
ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Add Message model for driver-dispatcher messaging
CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "text" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- Add indexes on Message
CREATE INDEX IF NOT EXISTS "Message_runId_idx" ON "Message"("runId");
CREATE INDEX IF NOT EXISTS "Message_senderId_idx" ON "Message"("senderId");

-- Add foreign key for Message.senderId -> User.id
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
