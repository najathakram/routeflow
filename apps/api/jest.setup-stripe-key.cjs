/**
 * SA-1547 F1: every api jest suite starts with a synthetic live-shaped Stripe key, so the live-payments wall's
 * refusal specs never read an ambient developer key (an exported sk_test_ value would flip them). Specs that need
 * test or none mode set STRIPE_SECRET_KEY themselves and restore it. Not a real key.
 */
process.env.STRIPE_SECRET_KEY = "sk_live_jest_synthetic";
