-- Shipped / tracking-added customer emails for carrier-shipped (fulfillPath SHIP) orders.
--   1. "NotificationEvent" += ORDER_SHIPPED, SHIPMENT_TRACKING_ADDED, READY_FOR_PICKUP (ADD VALUE inside the wrap is
--      legal on PG >= 12; a value added in a transaction cannot be USED in it, and nothing here
--      uses them: the per-tenant rule/template rows are inserted by the NEXT migration,
--      20261003120100_shipped_emails_seed_rules, which runs in its own transaction after this commit).
--   2. "Order"."trackingNotifiedAt": nullable TIMESTAMP(3), no default (metadata-only ADD COLUMN, no
--      table rewrite). Stamped once when the customer is told the order's tracking; guards the
--      one-time SHIPMENT_TRACKING_ADDED follow-up. No backfill: NULL is the correct state for every
--      existing order.
--
-- LOCK PROFILE: "Order" takes ACCESS EXCLUSIVE for the instant of the metadata-only ADD COLUMN (held to
-- COMMIT, which is immediate); "NotificationEvent" locks the type only. lock_timeout bounds the wait.
-- Everything is additive. If a lock wait exceeds 5s the migration rolls back and is recorded FAILED:
-- recover with  prisma migrate resolve --rolled-back 20261003120000_shipped_emails_events_and_marker
-- from apps/api, then re-run. NEVER `--applied`.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationEvent" ADD VALUE 'ORDER_SHIPPED';
ALTER TYPE "NotificationEvent" ADD VALUE 'SHIPMENT_TRACKING_ADDED';
ALTER TYPE "NotificationEvent" ADD VALUE 'READY_FOR_PICKUP';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "trackingNotifiedAt" TIMESTAMP(3);

COMMIT;
