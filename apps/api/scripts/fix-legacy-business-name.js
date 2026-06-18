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
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    // Find the legacy tenant
    const { rows } = await client.query(
      `SELECT tc.id, tc."businessName", t.slug, t.name
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

run();
