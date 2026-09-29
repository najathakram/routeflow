-- #2113 (SA-528): durable F-10a mailbox admin alert. Additive, nullable, no default, no backfill:
-- existing rows owe no alert (null). Owner applies to prod via prod-migrate.mjs after a backup.
ALTER TABLE "MailboxConnection" ADD COLUMN "alertPendingAt" TIMESTAMP(3);
