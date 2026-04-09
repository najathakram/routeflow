/**
 * Migrates legacy (pre-multi-tenant) users with tenantId = NULL to a designated
 * "legacy" tenant, keeping SUPER_ADMIN users platform-level (tenantId = NULL).
 *
 * Safe to run multiple times (idempotent).
 *
 * Usage:
 *   node apps/api/scripts/migrate-legacy-users.js [--dry-run]
 *
 * What it does:
 *   1. Creates (or finds) a tenant with slug "legacy"
 *   2. Creates (or finds) the matching TenantConfig row
 *   3. Updates all null-tenantId OPERATOR/DRIVER/CUSTOMER/TENANT_ADMIN users
 *      to tenantId = legacy.id
 *   4. SUPER_ADMIN users are left with tenantId = NULL (platform-level)
 */

const { Pool } = require("pg");
const { randomUUID } = require("crypto");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const DRY_RUN = process.argv.includes("--dry-run");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Find or create the legacy tenant ───────────────────────────────────
    let tenantRow = (await client.query(
      `SELECT id FROM "Tenant" WHERE slug = 'legacy' LIMIT 1`
    )).rows[0];

    if (!tenantRow) {
      if (DRY_RUN) {
        console.log("[DRY RUN] Would create Tenant { slug: 'legacy', name: 'Legacy' }");
      } else {
        const id = randomUUID();
        const trialEndsAt = new Date();
        trialEndsAt.setFullYear(trialEndsAt.getFullYear() + 10); // 10-year trial
        await client.query(
          `INSERT INTO "Tenant" (id, slug, name, status, plan, "trialEndsAt", "createdAt", "updatedAt")
           VALUES ($1, 'legacy', 'Legacy', 'ACTIVE', 'STARTER', $2, NOW(), NOW())`,
          [id, trialEndsAt]
        );
        await client.query(
          `INSERT INTO "TenantConfig" (id, "tenantId", "businessName", "updatedAt")
           VALUES ($1, $2, 'RouteFlow', NOW())`,
          [randomUUID(), id]
        );
        tenantRow = { id };
        console.log(`✓ Created legacy tenant (id: ${id})`);
      }
    } else {
      console.log(`✓ Using existing legacy tenant (id: ${tenantRow.id})`);
    }

    if (DRY_RUN && !tenantRow) {
      tenantRow = { id: "<would-be-created>" };
    }

    // ── 2. Find legacy users ───────────────────────────────────────────────────
    const { rows: legacyUsers } = await client.query(
      `SELECT id, username, role FROM "User"
       WHERE "tenantId" IS NULL
         AND role IN ('OPERATOR', 'DRIVER', 'CUSTOMER', 'TENANT_ADMIN')
       ORDER BY "createdAt"`
    );

    console.log(`\nFound ${legacyUsers.length} legacy user(s) to migrate:`);
    legacyUsers.forEach((u) =>
      console.log(`  - ${u.username} (${u.role}, id: ${u.id})`)
    );

    // ── 3. Count SUPER_ADMIN (staying platform-level) ────────────────────────
    const { rows: superAdmins } = await client.query(
      `SELECT id, username FROM "User" WHERE role = 'SUPER_ADMIN'`
    );
    console.log(`\n${superAdmins.length} SUPER_ADMIN user(s) will remain platform-level (tenantId = NULL):`);
    superAdmins.forEach((u) => console.log(`  - ${u.username}`));

    // ── 4. Migrate ─────────────────────────────────────────────────────────────
    if (legacyUsers.length === 0) {
      console.log("\nNo legacy users to migrate. Nothing to do.");
    } else if (DRY_RUN) {
      console.log(
        `\n[DRY RUN] Would set tenantId = '${tenantRow.id}' on ${legacyUsers.length} user(s).`
      );
    } else {
      const ids = legacyUsers.map((u) => u.id);
      // Cast id to text for comparison since node-pg infers string[] as text[]
      await client.query(
        `UPDATE "User" SET "tenantId" = $1::uuid, "updatedAt" = NOW()
         WHERE id::text = ANY($2::text[])`,
        [tenantRow.id, ids]
      );
      console.log(`\n✓ Migrated ${ids.length} user(s) to legacy tenant.`);
    }

    if (!DRY_RUN) {
      await client.query("COMMIT");
      console.log("\nMigration complete.");
    } else {
      await client.query("ROLLBACK");
      console.log("\n[DRY RUN] No changes applied. Re-run without --dry-run to apply.");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
