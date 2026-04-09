/**
 * Create a SUPER_ADMIN user in the database.
 *
 * Usage:
 *   node apps/api/scripts/create-super-admin.js \
 *     --username superadmin \
 *     --password "SuperAdmin@123" \
 *     --email "admin@routeflow.io"
 *
 * Run from the repo root or the apps/api directory.
 */

// Resolve node_modules from the repo root (monorepo — pg lives at root)
const REPO_ROOT = require("path").resolve(__dirname, "../../..");
const { Pool } = require(require("path").join(REPO_ROOT, "node_modules/pg"));
const bcrypt = require(require("path").join(REPO_ROOT, "node_modules/bcrypt"));
const fs = require("fs");
const path = require("path");

// ─── Parse CLI args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--force") {
      args.force = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
      const key = argv[i].slice(2);
      args[key] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const { username, password, email } = args;
const force = !!args.force;

if (!username || !password || !email) {
  console.error("Usage: node create-super-admin.js --username <u> --password <p> --email <e> [--force]");
  process.exit(1);
}

// ─── Load DATABASE_URL ─────────────────────────────────────────────────────────

function loadDatabaseUrl() {
  // Try .env in the api directory, then repo root
  const candidates = [
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../.env"),
    path.resolve(__dirname, "../../../.env"),
  ];
  for (const envFile of candidates) {
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, "utf8").split("\n");
      for (const line of lines) {
        const m = line.match(/^DATABASE_URL\s*=\s*"?([^"]+)"?\s*$/);
        if (m) {
          console.log(`Using DATABASE_URL from: ${envFile}`);
          return m[1].trim();
        }
      }
    }
  }
  // Fall back to environment variable
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error("DATABASE_URL not found in .env files or environment");
}

async function main() {
  const connectionString = loadDatabaseUrl();
  const pool = new Pool({ connectionString });

  try {
    // Check if username already exists (any role)
    const existing = await pool.query(
      'SELECT id, username, role FROM "User" WHERE username = $1',
      [username]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];

      if (force && user.role === "SUPER_ADMIN") {
        // --force: update the existing SUPER_ADMIN's password
        const hashedPassword = await bcrypt.hash(password, 10);
        const now = new Date().toISOString();
        await pool.query(
          `UPDATE "User" SET password = $1, "updatedAt" = $2 WHERE username = $3 AND role = 'SUPER_ADMIN'`,
          [hashedPassword, now, username]
        );
        console.log("\nSUPER_ADMIN password updated successfully (--force)!");
        console.log("─────────────────────────────────────");
        console.log(`  id:       ${user.id}`);
        console.log(`  username: ${user.username}`);
        console.log(`  role:     ${user.role}`);
        console.log(`  updated:  ${now}`);
        console.log("");
        return;
      }

      console.error(
        `ERROR: User "${username}" already exists (id=${user.id}, role=${user.role}). Use --force to update the password.`
      );
      process.exit(1);
    }

    // Check if email already exists
    const emailCheck = await pool.query(
      'SELECT id FROM "User" WHERE email = $1',
      [email]
    );
    if (emailCheck.rows.length > 0) {
      console.error(`ERROR: Email "${email}" is already in use. Aborting.`);
      process.exit(1);
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    const id = require("crypto").randomUUID();

    // Insert the SUPER_ADMIN user
    const result = await pool.query(
      `INSERT INTO "User" (
        id, username, email, password, role, status,
        "forcePasswordChange", "tenantId", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, 'SUPER_ADMIN', 'ACTIVE',
        false, NULL, $5, $5
      ) RETURNING id, username, email, role, status, "createdAt"`,
      [id, username, email, hashedPassword, now]
    );

    const created = result.rows[0];
    console.log("\nSUPER_ADMIN user created successfully!");
    console.log("─────────────────────────────────────");
    console.log(`  id:       ${created.id}`);
    console.log(`  username: ${created.username}`);
    console.log(`  email:    ${created.email}`);
    console.log(`  role:     ${created.role}`);
    console.log(`  status:   ${created.status}`);
    console.log(`  created:  ${created.createdAt}`);
    console.log("");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
