-- SA-1101 (refused order): two enum values, appended at the END (the SA-603c shape, 20260929220000 §6).
-- ADD VALUE inside the migration's transaction is legal (PG >= 12). A value added in a transaction cannot
-- be USED in it, and nothing here uses either one: only app code after the commit does.
-- No seed rows: messaging-config's seedDefaultsFor creates ORDER_REFUSED's rules lazily, copying each
-- tenant's DELIVERED choice (SA-1101 §4.1).
-- LOCK PROFILE: ONE transaction; `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT. ADD VALUE takes a brief lock
-- on the enum type only, never on a table, and rewrites no rows. A lock wait longer than 5s fails and rolls the whole
-- file back (recover with `prisma migrate resolve --rolled-back 20261105090000_order_refused_status` from apps/api,
-- then re-run; NEVER `--applied`).
-- HARD DEPLOY ORDER (L-184): apply to prod (fresh backup, `prod-migrate.mjs`), `schema-drift.mjs` exit 0, and ONLY
-- THEN merge the code that writes REFUSED or ORDER_REFUSED.
-- No down-migration: an enum value cannot be dropped in place. Rolling the CODE back after the first REFUSED order or
-- ORDER_REFUSED rule row exists needs a data step first (remap those rows); until then it is harmless.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "OrderStatus" ADD VALUE 'REFUSED';
ALTER TYPE "NotificationEvent" ADD VALUE 'ORDER_REFUSED';

COMMIT;
