-- SA-1050 PR-0 (bad-debt write-offs, folder 2 of 2, DATA): BAD_DEBT is denied by default. Folder 1
-- (20261028100000_invoice_write_off_events_and_bad_debt_group) added the enum value; this file is the first USE of it, so it must be
-- a later transaction.
--   1. "User"."deniedPermissionGroups" column default: '{}' becomes '{BAD_DEBT}', so every NEW account starts with write-offs off
--      (only OPERATOR accounts read the column; an admin always may). A constant default: metadata only, no rewrite.
--   2. Every existing OPERATOR gets BAD_DEBT appended to the deny list (owner 2026-10-20, "off by default"), once (a row that already
--      denies it is left alone), and its "permissionsVersion" is bumped, as every write to the deny list does (the compare-and-set
--      token), so a stale permissions editor is refused rather than silently overwriting the new list.
-- No row is deleted; no group an operator already holds or lacks is changed except BAD_DEBT.
--
-- LOCK PROFILE: ONE transaction. A brief ACCESS EXCLUSIVE on "User" for the default change (metadata only); the UPDATE takes row
-- locks on the OPERATOR rows it touches (a tenant's operators: tens, not millions). `SET LOCAL lock_timeout = '5s'` bounds the waits; a
-- timeout rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261028100100_bad_debt_default_denied` from apps/api, then re-run; NEVER `--applied`).
-- DEPLOY ORDER (L-184): apply after folder 1, `schema-drift.mjs` exit 0, and ONLY THEN merge any code that reads or writes the group.
--
-- Rollback (restores the old default; the appended deny entries are removed by hand if wanted):
--   ALTER TABLE "User" ALTER COLUMN "deniedPermissionGroups" SET DEFAULT '{}';
--   UPDATE "User" SET "deniedPermissionGroups" = array_remove("deniedPermissionGroups", 'BAD_DEBT'::"OperatorPermissionGroup")
--    WHERE "role" = 'OPERATOR';

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "deniedPermissionGroups" SET DEFAULT ARRAY['BAD_DEBT']::"OperatorPermissionGroup"[];

-- Data
UPDATE "User"
   SET "deniedPermissionGroups" = array_append("deniedPermissionGroups", 'BAD_DEBT'::"OperatorPermissionGroup"),
       "permissionsVersion" = "permissionsVersion" + 1
 WHERE "role" = 'OPERATOR'
   AND NOT ('BAD_DEBT'::"OperatorPermissionGroup" = ANY("deniedPermissionGroups"));

COMMIT;
