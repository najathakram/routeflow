-- SA-1208 M1-15 (void date, migration only; panel 2026-11-21-prospect-backlog decision D1): two nullable columns.
--   "InvoicePayment"."voidedAt" TIMESTAMP(3) NULL   the date a payment was voided (reader: voidedAt ?? bouncedAt)
--   "Invoice"."voidedAt"        TIMESTAMP(3) NULL   the date an invoice was voided
-- No default, no backfill: rows voided before this carry no date and are never filled from another column. Nothing reads
-- or writes either column until M1-16 (the void writers stamp it).
-- LOCK PROFILE: ONE transaction; a brief ACCESS EXCLUSIVE on each table for a metadata-only ADD COLUMN (no rewrite, no scan).
-- `SET LOCAL lock_timeout = '5s'` bounds each wait; a timeout rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261122000100_void_date` from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): the generated client selects both columns on every read, so merge only after the owner sitting:
-- fresh backup, `prod-migrate.mjs`, `schema-drift.mjs` exit 0, THEN merge.
-- Rollback: ALTER TABLE "InvoicePayment" DROP COLUMN "voidedAt"; ALTER TABLE "Invoice" DROP COLUMN "voidedAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "voidedAt" TIMESTAMP(3);

COMMIT;
