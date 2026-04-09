/**
 * Reset the SUPER_ADMIN password for najathakram.
 * Run from repo root: node apps/api/scripts/reset-super-admin.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const NEW_PASSWORD = "Najath123!";
const USERNAME = "najathakram";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const hash = await bcrypt.hash(NEW_PASSWORD, 10);

  const result = await pool.query(
    `UPDATE "User" SET password = $1, "forcePasswordChange" = false WHERE username = $2 RETURNING id, username, role`,
    [hash, USERNAME]
  );

  if (result.rowCount === 0) {
    console.log(`User '${USERNAME}' not found. Creating...`);
    const created = await pool.query(
      `INSERT INTO "User" (id, username, email, password, role, status, "forcePasswordChange", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'SUPER_ADMIN', 'ACTIVE', false, NOW(), NOW())
       RETURNING id, username, role`,
      [USERNAME, "najathakram@routeflow.io", hash]
    );
    console.log("Created:", created.rows[0]);
  } else {
    console.log("Updated:", result.rows[0]);
  }

  await pool.end();
  console.log(`Password set to: ${NEW_PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
