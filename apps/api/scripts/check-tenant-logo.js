#!/usr/bin/env node
/**
 * Quick read-only inspection of a tenant's branding state — used to debug why
 * a logo isn't appearing on an invoice PDF. No mutations.
 */
const { Client } = require("pg");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const isRailway = /\.railway\.internal|\.proxy\.rlwy\.net/i.test(url);
const slug = process.argv[2];
if (!slug) {
  console.error("Usage: node apps/api/scripts/check-tenant-logo.js <tenant-slug>");
  process.exit(1);
}

(async () => {
  const c = new Client({
    connectionString: url,
    ssl: isRailway ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  try {
    const t = await c.query('SELECT id, slug, name FROM "Tenant" WHERE slug = $1 LIMIT 1', [slug]);
    if (t.rows.length === 0) {
      console.error(`No tenant with slug ${slug}`);
      process.exit(2);
    }
    const tenantId = t.rows[0].id;
    console.log("Tenant:", t.rows[0]);
    const cfg = await c.query(
      `SELECT "businessName", "logoKey", "primaryColor",
              "addressLine1", "city", "state", "zip", "phone", "website",
              "customerEmail"
       FROM "TenantConfig" WHERE "tenantId" = $1`,
      [tenantId],
    );
    console.log("\nConfig:");
    console.log(cfg.rows[0] ?? "(no row)");

    const inv = await c.query(
      `SELECT id, "invoiceNumber", "pdfUrl", "createdAt"
       FROM "Invoice"
       WHERE "tenantId" = $1
       ORDER BY "createdAt" DESC
       LIMIT 5`,
      [tenantId],
    );
    console.log(`\nLatest 5 invoices (pdfUrl = cached key, NULL = will regenerate):`);
    for (const r of inv.rows) {
      console.log(
        `  ${r.invoiceNumber}  cached=${r.pdfUrl ?? "<NULL>"}  ${r.createdAt.toISOString().slice(0, 19)}`,
      );
    }
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(99);
});
