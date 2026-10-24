-- Seed the notification rule + message template rows for the three new events (ORDER_SHIPPED,
-- SHIPMENT_TRACKING_ADDED, READY_FOR_PICKUP) for EVERY existing tenant, across the four customer
-- channels (WHATSAPP, SMS, EMAIL, PORTAL), exactly the rows seedDefaultsFor() would lazily create.
--
-- INSERT-ONLY and idempotent: ON CONFLICT ("tenantId","eventKey","channel") DO NOTHING. No UPDATE, no
-- DELETE: it adds rows for all tenants and changes no existing row.
--
-- RESPECTS WHAT EACH BUSINESS CHOSE: a tenant's new rule copies "enabled", and its new template copies
-- "isActive", from that tenant's OUT_FOR_DELIVERY row for the SAME channel (the new emails replace the
-- carrier case of that one). A business that switched "out for delivery" off stays off; one with SMS/WhatsApp
-- on keeps them. Where the tenant has no OUT_FOR_DELIVERY row (never seeded) the defaults apply:
-- EMAIL and PORTAL on, WHATSAPP and SMS off (DEFAULT_ON in messaging-config.service.ts).
--
-- The template bodies below are the DEFAULT_TEMPLATES bodies; shipped-emails-migration-shape.spec.ts pins
-- them byte-equal to the code. This is a SEPARATE migration from the one that adds the enum values: a value
-- added in a transaction cannot be used in the same transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO "NotificationRule" ("id", "tenantId", "eventKey", "channel", "enabled", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       t."id",
       e.ev::"NotificationEvent",
       c.ch::"MessageChannel",
       COALESCE(o."enabled", c.ch IN ('EMAIL', 'PORTAL')),
       now(),
       now()
FROM "Tenant" t
CROSS JOIN (VALUES ('ORDER_SHIPPED'), ('SHIPMENT_TRACKING_ADDED'), ('READY_FOR_PICKUP')) AS e(ev)
CROSS JOIN (VALUES ('WHATSAPP'), ('SMS'), ('EMAIL'), ('PORTAL')) AS c(ch)
LEFT JOIN "NotificationRule" o
  ON o."tenantId" = t."id"
 AND o."eventKey" = 'OUT_FOR_DELIVERY'::"NotificationEvent"
 AND o."channel" = c.ch::"MessageChannel"
ON CONFLICT ("tenantId", "eventKey", "channel") DO NOTHING;

INSERT INTO "MessageTemplate" ("id", "tenantId", "eventKey", "channel", "body", "variables", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       t."id",
       e.ev::"NotificationEvent",
       c.ch::"MessageChannel",
       e.body,
       e.vars,
       COALESCE(o."isActive", true),
       now(),
       now()
FROM "Tenant" t
CROSS JOIN (VALUES
  ('ORDER_SHIPPED',
   'Hi {{customerName}}, your order {{orderNumber}} has shipped with {{carrier}}.{{trackingLine}}',
   ARRAY['customerName', 'orderNumber', 'carrier', 'trackingLine']::TEXT[]),
  ('SHIPMENT_TRACKING_ADDED',
   'Hi {{customerName}}, tracking for order {{orderNumber}}: {{trackingNumber}} — {{trackingUrl}}',
   ARRAY['customerName', 'orderNumber', 'trackingNumber', 'trackingUrl']::TEXT[]),
  ('READY_FOR_PICKUP',
   'Hi {{customerName}}, your order {{orderNumber}} is ready for pickup.{{pickupLine}}',
   ARRAY['customerName', 'orderNumber', 'pickupLine']::TEXT[])
) AS e(ev, body, vars)
CROSS JOIN (VALUES ('WHATSAPP'), ('SMS'), ('EMAIL'), ('PORTAL')) AS c(ch)
LEFT JOIN "MessageTemplate" o
  ON o."tenantId" = t."id"
 AND o."eventKey" = 'OUT_FOR_DELIVERY'::"NotificationEvent"
 AND o."channel" = c.ch::"MessageChannel"
ON CONFLICT ("tenantId", "eventKey", "channel") DO NOTHING;

COMMIT;
