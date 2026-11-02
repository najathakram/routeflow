-- SA-1083 PR-1: when a tenant closed, and the columns a later purge job reads. No job in this migration deletes anything.
--   "Tenant"."closedAt"            set only by the trigger below (and once, on an owner-approved list, for a tenant
--                                  already closed when this ran: see scripts/stamp-closed-tenant-sa1083.mjs)
--   "Tenant"."retentionHoldAt", "retentionHoldReason"
--   "Tenant"."purgeApprovedAt", "purgeApprovedCounts"
--   "Tenant"."purgeStartedAt"
--   "Tenant"."purgeNoticeAt", "copyRequestOpenAt"
-- Every column is NULL for every existing tenant. NO backfill: no date is guessed for a tenant already closed.
--
-- The trigger, on every INSERT and UPDATE of "Tenant", whichever of the writers moved the row. Closed means CANCELLED, or
-- READ_ONLY with "readOnlyReason" = 'subscription_cancelled' (isClosedTenantState holds the same test):
--   entering closed           "closedAt" = now, in UTC like every other timestamp column here
--   staying closed            "closedAt" keeps its value; a tenant with no date can be given one
--   leaving closed            "closedAt", "purgeApprovedAt", "purgeApprovedCounts" are cleared
--   leaving, purge started    refused: TENANT_PURGE_STARTED
--   not closed                "closedAt" stays NULL
-- Prisma does not model triggers, so this lives only here; the drift gate does not see it as drift.
--
-- METADATA-ONLY columns: nullable, no default (catalog-only ADD COLUMN, no rewrite, no scan). No index: "Tenant" is small.
-- LOCK PROFILE: ONE transaction; `SET LOCAL lock_timeout = '5s'` applies PER STATEMENT: a lock wait longer than 5s fails
-- and rolls the whole file back (recorded FAILED; recover with
-- `prisma migrate resolve --rolled-back 20261102130000_tenant_closed_clock` from apps/api, then re-run; NEVER `--applied`).
--
-- Rollback:
--   DROP TRIGGER "Tenant_closed_clock" ON "Tenant";
--   DROP FUNCTION "tenant_closed_clock"();
--   ALTER TABLE "Tenant" DROP COLUMN "closedAt", DROP COLUMN "retentionHoldAt", DROP COLUMN "retentionHoldReason",
--     DROP COLUMN "purgeApprovedAt", DROP COLUMN "purgeApprovedCounts", DROP COLUMN "purgeStartedAt",
--     DROP COLUMN "purgeNoticeAt", DROP COLUMN "copyRequestOpenAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "copyRequestOpenAt" TIMESTAMP(3),
ADD COLUMN     "purgeApprovedAt" TIMESTAMP(3),
ADD COLUMN     "purgeApprovedCounts" JSONB,
ADD COLUMN     "purgeNoticeAt" TIMESTAMP(3),
ADD COLUMN     "purgeStartedAt" TIMESTAMP(3),
ADD COLUMN     "retentionHoldAt" TIMESTAMP(3),
ADD COLUMN     "retentionHoldReason" TEXT;

CREATE FUNCTION "tenant_closed_clock"() RETURNS trigger AS $$
DECLARE
  -- IS NOT DISTINCT FROM, because a NULL reason must read as not closed: a NULL here would skip every branch below.
  is_closed boolean := NEW.status = 'CANCELLED'
    OR (NEW.status = 'READ_ONLY' AND NEW."readOnlyReason" IS NOT DISTINCT FROM 'subscription_cancelled');
  was_closed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    was_closed := OLD.status = 'CANCELLED'
      OR (OLD.status = 'READ_ONLY' AND OLD."readOnlyReason" IS NOT DISTINCT FROM 'subscription_cancelled');
  END IF;

  IF is_closed AND NOT was_closed THEN
    NEW."closedAt" := timezone('UTC', clock_timestamp());
  ELSIF is_closed AND OLD."closedAt" IS NOT NULL THEN
    NEW."closedAt" := OLD."closedAt";
  ELSIF NOT is_closed THEN
    IF was_closed AND OLD."purgeStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'TENANT_PURGE_STARTED: tenant % cannot leave closed once a purge has started', OLD.id;
    END IF;
    NEW."closedAt" := NULL;
    IF was_closed THEN
      NEW."purgeApprovedAt" := NULL;
      NEW."purgeApprovedCounts" := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Tenant_closed_clock"
  BEFORE INSERT OR UPDATE ON "Tenant"
  FOR EACH ROW EXECUTE FUNCTION "tenant_closed_clock"();

COMMIT;
