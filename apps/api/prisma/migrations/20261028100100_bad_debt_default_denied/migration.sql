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
-- DEPLOY ORDER (SA-1050 A-3, which supersedes the order first ruled): this folder goes to prod LAST, after folder 1 is applied
-- (20261028100000_invoice_write_off_events_and_bad_debt_group, #3945, from its own gated head), after #3945 and this PR are
-- merged in one train, and only once BOTH deployments have reached SUCCESS. Run it from a tree at the merged master sha
-- (`prod-migrate.mjs`, fresh backup first if the window has slipped); the closing drift check must exit 0. NEVER run it
-- before the code that knows BAD_DEBT is serving: it writes the value into every OPERATOR's deny list, and a client generated
-- without it throws P2023 on every read of that column (login and refresh included). NEVER run `prod-migrate.mjs` from a
-- tree that holds both folders and has not yet seen folder 1 applied.
-- The api must never be rolled back to a deploy that predates BAD_DEBT while this folder stands: that recreates the P2023 fault.
-- Run this folder's rollback SQL (below) BEFORE any Railway rollback behind the deploy that carries BAD_DEBT.
--
-- Rollback. REQUIRED before any Railway rollback behind the deploy that carries BAD_DEBT (not optional cleanup):
--   ALTER TABLE "User" ALTER COLUMN "deniedPermissionGroups" SET DEFAULT '{}';
--   UPDATE "User" SET "deniedPermissionGroups" = array_remove("deniedPermissionGroups", 'BAD_DEBT'::"OperatorPermissionGroup"),
--          "permissionsVersion" = "permissionsVersion" + 1
--    WHERE 'BAD_DEBT'::"OperatorPermissionGroup" = ANY("deniedPermissionGroups");
-- There is NO role filter on purpose: the column default stamps {BAD_DEBT} on a new account of EVERY role (a driver, a customer),
-- not only an operator, and a client generated without BAD_DEBT throws P2023 reading any such row. The version is bumped in the
-- same UPDATE, as every write to the deny list does.
-- The same UPDATE also applies after the deploy, before this folder runs: the new client stamps its own schema default on
-- user.create (it sends {BAD_DEBT} even while the column default is still '{}', proven by invoice-write-off-events.db.spec.ts),
-- so rows created between the deploy and this folder carry the value too. The SET DEFAULT line is harmless then. Run the UPDATE
-- once more when the old deploy reaches SUCCESS, to strip the value from rows created in the meantime.
-- After a roll-forward (this folder run again once the deploy that carries BAD_DEBT is back), run this folder's own SET DEFAULT
-- and UPDATE (the forward statements below) by hand: the folder stays recorded as applied, so `migrate deploy` will not run it
-- again. The UPDATE is safe to repeat (a row that already denies BAD_DEBT is left alone).

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
