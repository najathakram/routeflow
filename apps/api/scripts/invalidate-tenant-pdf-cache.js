#!/usr/bin/env node
/**
 * One-shot: clear the cached `pdfUrl` on every Invoice for a tenant so the
 * next download regenerates the PDF against the current tenantConfig (logo,
 * address, business name, etc.). Used after a settings change that the
 * server didn't auto-invalidate.
 *
 * Usage:
 *   railway run node apps/api/scripts/invalidate-tenant-pdf-cache.js <slug>
 */
const { Client } = require("pg");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const { assertWritableTenant, ProtectedTenantError } = require("./lib/live-target-guard.cjs");
const url = process.env.DATABASE_URL;
const slug = process.argv[2];
if (!url || !slug) {
  console.error("Usage: DATABASE_URL=... node ... <slug>");
  process.exit(1);
}
const isRailway = /\.railway\.internal|\.proxy\.rlwy\.net/i.test(url);

(async () => {
  // Row 195: load the protected list BEFORE connecting, from the URL this script dials.
  const protectedSlugs = loadProtectedSlugs(process.env, url);
  const c = new Client({
    connectionString: url,
    ssl: isRailway ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  try {
    const t = await c.query(
      'SELECT id, slug, name, status, class, "deletedAt" FROM "Tenant" WHERE slug = $1',
      [slug],
    );
    if (t.rows.length === 0) {
      console.error(`No tenant with slug ${slug}`);
      process.exit(2);
    }
    const tenantId = t.rows[0].id;
    console.log(`Tenant: ${t.rows[0].name} (${tenantId})`);

    // Row 195: refuse a protected tenant (paying, Stripe-linked or env-listed) before any write.
    const sub = await c.query(
      'SELECT "planKey", "stripeSubId" FROM "TenantSubscription" WHERE "tenantId" = $1',
      [tenantId],
    );
    try {
      assertWritableTenant(t.rows[0], sub.rows[0] ?? null, protectedSlugs);
    } catch (err) {
      if (!(err instanceof ProtectedTenantError)) throw err;
      console.error(err.message);
      process.exit(3);
    }

    const before = await c.query(
      'SELECT COUNT(*)::int AS n FROM "Invoice" WHERE "tenantId" = $1 AND "pdfUrl" IS NOT NULL',
      [tenantId],
    );
    console.log(`Invoices with cached pdfUrl: ${before.rows[0].n}`);

    const result = await c.query(
      'UPDATE "Invoice" SET "pdfUrl" = NULL WHERE "tenantId" = $1 AND "pdfUrl" IS NOT NULL',
      [tenantId],
    );
    console.log(`Cleared pdfUrl on ${result.rowCount} invoice(s).`);
    console.log(
      "Next download for any invoice will regenerate the PDF against the current branding.",
    );
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(99);
});
