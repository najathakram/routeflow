-- Zelle as a recordable payment method. Additive only: one enum value, no
-- backfill, no column changes. Existing rows are untouched.
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in
-- Postgres, so this file is intentionally NOT wrapped in BEGIN/COMMIT.
-- IF NOT EXISTS keeps a re-run idempotent (Postgres 12+).

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'ZELLE';
