/**
 * One-time fix: update the legacy tenant's businessName from
 * "RouteFlow Legacy" to "RouteFlow".
 *
 * Usage:
 *   node apps/api/scripts/fix-legacy-business-name.js
 *
 * Safe to run multiple times (idempotent).
 */

const { Pool } = require("pg");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const { assertWritableTenant, ProtectedTenantError } = require("./lib/live-target-guard.cjs");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Row 195: the protected list is loaded BEFORE connecting, from the URL this script dials.
  const protectedSlugs = loadProtectedSlugs(process.env, process.env.DATABASE_URL);
  const client = await pool.connect();
  try {
    // Find the legacy tenant
    const { rows } = await client.query(
      `SELECT tc.id, tc."businessName", t.id AS "tenantId", t.slug, t.name, t.status, t.class,
              t."deletedAt"
       FROM "TenantConfig" tc
       JOIN "Tenant" t ON t.id = tc."tenantId"
       WHERE t.slug = 'legacy'
       LIMIT 1`,
    );

    if (rows.length === 0) {
      console.log("No legacy tenant found. Nothing to do.");
      return;
    }

    const row = rows[0];
    console.log(`Current: slug=${row.slug}, name=${row.name}, businessName="${row.businessName}"`);

    if (row.businessName === "RouteFlow") {
      console.log("Already set to 'RouteFlow'. Nothing to do.");
      return;
    }

    // Row 195: refuse a protected tenant (paying, Stripe-linked or env-listed) before any write.
    const subRes = await client.query(
      `SELECT "planKey", "stripeSubId" FROM "TenantSubscription" WHERE "tenantId" = $1`,
      [row.tenantId],
    );
    try {
      assertWritableTenant(
        {
          id: row.tenantId,
          slug: row.slug,
          status: row.status,
          class: row.class,
          deletedAt: row.deletedAt,
        },
        subRes.rows[0] ?? null,
        protectedSlugs,
      );
    } catch (err) {
      if (!(err instanceof ProtectedTenantError)) throw err;
      console.error(err.message);
      process.exitCode = 1;
      return;
    }

    // Update businessName
    await client.query(
      `UPDATE "TenantConfig" SET "businessName" = 'RouteFlow', "updatedAt" = NOW()
       WHERE id = $1`,
      [row.id],
    );

    // Also update tenant name
    await client.query(
      `UPDATE "Tenant" SET name = 'Legacy', "updatedAt" = NOW()
       WHERE slug = 'legacy'`,
    );

    console.log(`Updated businessName to "RouteFlow" and tenant name to "Legacy".`);
  } catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
