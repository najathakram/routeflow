/**
 * Reset the SUPER_ADMIN password.
 * Run from repo root:
 *   SUPER_ADMIN_USERNAME=<user> SUPER_ADMIN_PASSWORD=<new-password> node apps/api/scripts/reset-super-admin.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const { protectedTenantIds } = require("./lib/live-target-guard.cjs");

const NEW_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const USERNAME = process.env.SUPER_ADMIN_USERNAME;
if (!NEW_PASSWORD || !USERNAME) {
  console.error("SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD must be set in the environment.");
  process.exit(1);
}

async function main() {
  // Row 195: the protected list is loaded BEFORE connecting, from the URL this script dials.
  const protectedSlugs = loadProtectedSlugs(process.env, process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const protectedIds = await protectedTenantIds(pool, protectedSlugs);
  const hash = await bcrypt.hash(NEW_PASSWORD, 10);

  // A user that belongs to a protected tenant (paying, Stripe-linked or env-listed) is never reset.
  const result = await pool.query(
    `UPDATE "User" SET password = $1, "forcePasswordChange" = false
      WHERE username = $2 AND ("tenantId" IS NULL OR "tenantId" <> ALL($3::text[]))
      RETURNING id, username, role`,
    [hash, USERNAME, protectedIds],
  );

  if (result.rowCount === 0) {
    const held = await pool.query(
      `SELECT 1 FROM "User" WHERE username = $1 AND "tenantId" = ANY($2::text[]) LIMIT 1`,
      [USERNAME, protectedIds],
    );
    if (held.rowCount > 0) {
      console.error("Refusing: that username belongs to a user of a protected tenant.");
      await pool.end();
      process.exit(1);
    }
    console.log(`User '${USERNAME}' not found. Creating...`);
    const created = await pool.query(
      `INSERT INTO "User" (id, username, email, password, role, status, "forcePasswordChange", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'SUPER_ADMIN', 'ACTIVE', false, NOW(), NOW())
       RETURNING id, username, role`,
      [USERNAME, "najathakram@routeflow.io", hash],
    );
    console.log("Created:", created.rows[0]);
  } else {
    console.log("Updated:", result.rows[0]);
  }

  await pool.end();
  console.log(`Password set to: ${NEW_PASSWORD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
