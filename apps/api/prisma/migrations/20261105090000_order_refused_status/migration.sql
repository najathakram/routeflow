-- SA-1101 (refused order): two enum values, appended at the END (the SA-603c shape, 20260929220000 §6).
-- ADD VALUE inside the migration's transaction is legal (PG >= 12). A value added in a transaction cannot
-- be USED in it, and nothing here uses either one: only app code after the commit does.
-- No seed rows: messaging-config's seedDefaultsFor creates ORDER_REFUSED's rules lazily, copying each
-- tenant's DELIVERED choice (SA-1101 §4.1).
ALTER TYPE "OrderStatus" ADD VALUE 'REFUSED';
ALTER TYPE "NotificationEvent" ADD VALUE 'ORDER_REFUSED';
