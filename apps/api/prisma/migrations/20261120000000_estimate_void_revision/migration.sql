-- Estimates (owner 2026-11-19, W-estimates-flow): a void state of its own and a revision mark, SCHEMA ONLY.
--   "EstimateStatus"      += VOID (appended last). Today a void is stored as DECLINED, so a quote the customer turned
--                            down and one the business cancelled read the same. Nothing writes VOID until this is in prod.
--   "Estimate"."revision" INTEGER NOT NULL DEFAULT 1 + CHECK >= 1 (NOT VALID). Shown as "Rev 2" once a sent quote goes
--                            back to draft and is sent again. Every existing quote reads 1.
-- ADD VALUE inside the migration's transaction is legal (PG >= 12). A value added in a transaction cannot be USED in it,
-- and nothing here uses it: only app code after the commit does.
-- BACKFILL: none. An ADD COLUMN with a constant default is metadata-only since Postgres 11 (no rewrite, no UPDATE).
-- The CHECK is NOT VALID: enforced for every new or updated row from COMMIT, with no scan (every existing value is 1, so a
-- later `VALIDATE CONSTRAINT` cannot fail).
--
-- LOCK PROFILE: ONE transaction. A brief ACCESS EXCLUSIVE on "Estimate" for the ADD COLUMN and the CHECK (no scan, no
-- rewrite), and a lock on the enum type for ADD VALUE. `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT; a lock wait
-- longer than 5s fails and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261120000000_estimate_void_revision` from apps/api, then re-run; NEVER `--applied`).
-- HARD DEPLOY ORDER (L-184): this PR merges only inside a DB sitting. Apply to prod first (fresh backup, `prod-migrate.mjs`),
-- `schema-drift.mjs` exit 0, and ONLY THEN merge it. Code that writes VOID or reads/writes "revision" ships after that.
--
-- Rollback (nothing writes either yet):
--   ALTER TABLE "Estimate" DROP CONSTRAINT "Estimate_revision_positive_chk", DROP COLUMN "revision";
--   (a Postgres enum value cannot be dropped in place; VOID stays, unused, which is harmless. After the first VOID row
--   exists, rolling the CODE back needs a data step first: remap those rows to DECLINED.)

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "EstimateStatus" ADD VALUE 'VOID';

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- Raw-SQL CHECK (Prisma does not model CHECK constraints): a revision starts at 1 and only counts up.
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_revision_positive_chk" CHECK ("revision" >= 1) NOT VALID;

COMMIT;
