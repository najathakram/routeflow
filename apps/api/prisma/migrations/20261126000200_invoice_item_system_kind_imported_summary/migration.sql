-- SA-1295 A2, Sitting 1, folder 3 of 3: "InvoiceItemSystemKind" += IMPORTED_SUMMARY.
-- Nothing else is in this folder, and nothing writes the value before the posting writer (A7) ships. A value added in a
-- transaction cannot be used in it, and nothing here uses it. No CHECK names the new value.
--
-- LOCK PROFILE: a lock on the enum type only, no table, no DML blocked. Fails only on lock_timeout.
--
-- DEPLOY ORDER (L-184): migrate FIRST, merge SECOND, with folders 1 and 2 of this sitting.
--
-- RECOVERY: prisma migrate resolve --rolled-back 20261126000200_invoice_item_system_kind_imported_summary (through
--   prod-migrate-resolve.mjs, with its own owner yes), then the sitting's steps again at least 15 minutes later.
--   Folders 1 and 2 stay applied and are never re-run. NEVER --applied. One retry per folder.
--
-- ROLLBACK (only on an SA ruling): none. An enum value cannot be dropped; it stays, harmless.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "InvoiceItemSystemKind" ADD VALUE 'IMPORTED_SUMMARY';

COMMIT;
