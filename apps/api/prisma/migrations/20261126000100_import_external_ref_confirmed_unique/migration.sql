-- SA-1295 A2, Sitting 1, folder 2 of 3: one CONFIRMED binding per entity and source on "ImportExternalRef".
-- A raw partial unique index (Prisma cannot declare one; the model carries a comment naming it). Every existing row has
-- "confirmedAt" NULL (folder 1 added the column with no backfill), so the index starts empty and the build cannot fail
-- on uniqueness. Precedent: 20260929220000_sitting_b_bundle/migration.sql, a partial unique index inside the wrap.
--
-- LOCK PROFILE (lock_timeout below bounds the WAIT, not the hold; released at COMMIT):
--   "ImportExternalRef": SHARE, plus one full scan to build the index (a plain build: CONCURRENTLY cannot run inside the
--   required wrap). Blocks INSERT, UPDATE, DELETE on it (the invoice import's upsert, the migration import, the undo
--   deleteMany, the 3-minute GoHighLevel poll); reads pass. Writers queue behind the hold and then proceed. The hold
--   is the scan to COMMIT, sized by the census rows and size line (sitting-s1295-1-check.mjs --pre).
--   Fails only on lock_timeout (never on uniqueness).
--
-- DEPLOY ORDER (L-184): migrate FIRST, merge SECOND, with folders 1 and 3 of this sitting.
--
-- RECOVERY: prisma migrate resolve --rolled-back 20261126000100_import_external_ref_confirmed_unique (through
--   prod-migrate-resolve.mjs, with its own owner yes), then the sitting's steps again at least 15 minutes later.
--   Folder 1 stays applied and is never re-run; leaving it overnight is safe (nothing sets "confirmedAt" before the
--   merge). NEVER --applied. One retry per folder.
--
-- ROLLBACK (only on an SA ruling): DROP INDEX "ImportExternalRef_confirmed_entity_key".

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX "ImportExternalRef_confirmed_entity_key"
  ON "ImportExternalRef" ("tenantId", "externalSource", "entityType", "entityId")
  WHERE "confirmedAt" IS NOT NULL;

COMMIT;
