-- N1 (Opus review, BLOCKER): existing tenants seeded INVOICE_SENT:EMAIL as an
-- enabled NotificationRule (+ active MessageTemplate) back when EMAIL was part of
-- INVOICE_SENT's channels. This PR removes EMAIL from that event's channels (the
-- messaging engine's own copy of "invoice sent" was a second, previously-no-op
-- attempt at the same email invoices.service.ts already sends for real via
-- sendInvoice()) — now that EmailChannelProvider makes EMAIL a real transport,
-- a stale enabled row would fire a duplicate, PDF-less email on every invoice
-- send. Code also filters notify()'s rules through EVENT_CHANNELS as defense in
-- depth, but a persisted enabled=true row that no longer shows in the settings
-- matrix would otherwise be an invisible, unswitchable-off dead man's switch.
UPDATE "NotificationRule" SET enabled = false, "updatedAt" = now()
WHERE "eventKey" = 'INVOICE_SENT' AND channel = 'EMAIL' AND enabled = true;

UPDATE "MessageTemplate" SET "isActive" = false, "updatedAt" = now()
WHERE "eventKey" = 'INVOICE_SENT' AND channel = 'EMAIL' AND "isActive" = true;

-- N1 (Opus review, MAJOR — rollout consistency): existing tenants already have
-- ORDER_CONFIRMED/OUT_FOR_DELIVERY/DELIVERED:EMAIL rows seeded OFF (from before
-- this PR, when EMAIL wasn't in DEFAULT_ON for these events) — seedDefaultsFor's
-- skipDuplicates means those pre-existing rows are never touched going forward,
-- while the brand-new CANCELLED event gets seeded ON on first use. Left alone,
-- existing tenants would email buyers ONLY on cancellation and never on
-- confirm/out-for-delivery/delivered — the opposite of the intended default.
-- Backfill enables the three pre-existing cells to match the new default for
-- every tenant that already has a row for them. Per the owner's ruling (buyers
-- default ON), pilot tenants must be told their buyers now receive
-- order-status email — see the PR description.
UPDATE "NotificationRule" SET enabled = true, "updatedAt" = now()
WHERE "eventKey" IN ('ORDER_CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED')
  AND channel = 'EMAIL'
  AND enabled = false;
