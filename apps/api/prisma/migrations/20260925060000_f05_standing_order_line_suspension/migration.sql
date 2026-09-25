-- F-05 (#2093, SA-210): standing-order line suspension and template provenance.
--   "OrderTemplateItem"."suspendedAt" / "suspendedReason" : a line the unattended run skipped because a
--     selling restriction bans it (NULL = active, every existing row).
--   "OrderTemplate"."createdByRole" / "createdByUserId" : who created the schedule, snapshotted at creation.
--     NULL = unknown provenance, evaluated as the STRICTER buyer channel (never staff). Every existing row is
--     NULL until the owner-run backfill script sets what the AuditLog can prove.
-- All four are metadata-only nullable adds: no table rewrite, no backfill in this file.
--
-- ORDERING: apply to prod BEFORE the PR merges (L-184) — the API image regenerates the Prisma client at build
-- time and would select these columns on every template read. The reverse order is safe.
--
-- Rollback (instant):
--   ALTER TABLE "OrderTemplateItem" DROP COLUMN "suspendedAt", DROP COLUMN "suspendedReason";
--   ALTER TABLE "OrderTemplate" DROP COLUMN "createdByRole", DROP COLUMN "createdByUserId";

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "OrderTemplate" ADD COLUMN "createdByRole" "UserRole",
ADD COLUMN "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "OrderTemplateItem" ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "suspendedReason" TEXT;
