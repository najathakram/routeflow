-- Unify the settled-payment reference into ONE column (2026-08-22).
--
-- Pre-#399 settles wrote stripePaymentIntentId; post-#399 settles write
-- providerPaymentId. Same fact, two columns, split by deploy date — every
-- reader of either column silently gets NULL for half of history. Backfill
-- the legacy era into the canonical column; stripePaymentIntentId is now
-- deprecated (see schema.prisma) and will be dropped in a later cleanup.
-- Data-only, additive, idempotent.
UPDATE "BuyerPaymentRequest"
   SET "providerPaymentId" = "stripePaymentIntentId"
 WHERE "providerPaymentId" IS NULL
   AND "stripePaymentIntentId" IS NOT NULL;
