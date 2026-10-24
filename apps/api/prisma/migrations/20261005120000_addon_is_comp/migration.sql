-- SA-693 (owner ruling 2026-10-05 "Mark grants as comps"): "TenantAddon"."isComp" — an add-on row the
-- platform granted free ON PURPOSE. A comp row is never billed and never blocks a checkout; before
-- this column a free grant and an unbilled self-serve row were indistinguishable (both stripeItemId
-- NULL, priceSnapshot 0). Its OWN migration, nothing else rides on it. Nothing reads it from the
-- database side; the app code that ships with it is the only consumer.
--
-- LOCK PROFILE: a constant NOT NULL DEFAULT is metadata-only on PG >= 11 (the default is stored in
-- pg_attribute and applied lazily on read), so no table rewrite and no scan. ACCESS EXCLUSIVE is
-- held only for the catalog change; lock_timeout below bounds the wait behind a long writer.
--
-- Rollback (instant): ALTER TABLE "TenantAddon" DROP COLUMN "isComp";
-- Recovery: if the lock wait exceeds 5s the migration rolls back and is recorded FAILED:
--   prisma migrate resolve --rolled-back 20261005120000_addon_is_comp
-- from apps/api, then re-run. NEVER `--applied`.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "TenantAddon" ADD COLUMN "isComp" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
