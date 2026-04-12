-- AlterTable: add isAdmin and canActAsDriver to User
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "isAdmin"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canActAsDriver" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: add customerEmail and ownerName to TenantConfig
ALTER TABLE "TenantConfig"
  ADD COLUMN IF NOT EXISTS "customerEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerName"     TEXT;

-- Set existing TENANT_ADMIN users as isAdmin = true
UPDATE "User" SET "isAdmin" = true WHERE "role" = 'TENANT_ADMIN';
