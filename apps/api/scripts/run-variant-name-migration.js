#!/usr/bin/env node
/**
 * Safely apply the "variant names unique per-parent" migration to whichever
 * Postgres `DATABASE_URL` is set in the environment. Designed to be run via:
 *
 *   railway run node apps/api/scripts/run-variant-name-migration.js
 *
 * Safety layers (in order):
 *   1. Pre-flight: confirm no existing rows already violate the NEW partial
 *      uniques (duplicate name among standalone products, or duplicate name
 *      within a single parent). Mathematically these are SUBSETS of the old
 *      tenantId+name unique that's about to be dropped, so violations are
 *      impossible — but we check explicitly so we never blindly trust the
 *      shape of the data.
 *   2. Transaction wrap: every DDL statement runs inside a single BEGIN/COMMIT
 *      so a failure mid-flight rolls back cleanly. (Postgres supports
 *      transactional DDL — drops and creates are all reversible up to COMMIT.)
 *   3. Idempotency: every statement uses IF EXISTS / IF NOT EXISTS, so
 *      re-running the script after a partial run is safe.
 *   4. Post-flight: verify the two new partial unique indexes exist and the
 *      old global one is gone.
 */

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set. Run via:");
  console.error("  railway run node apps/api/scripts/run-variant-name-migration.js");
  process.exit(1);
}

// Safety: refuse to run against obviously-not-prod URLs unless explicitly
// confirmed via --dev. Most prod URLs contain `railway` or a custom host.
const isLocalUrl = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1|::1)/i.test(
  DATABASE_URL,
);
if (isLocalUrl && !process.argv.includes("--dev")) {
  console.error("DATABASE_URL points at localhost. Pass --dev if that's intentional.");
  process.exit(1);
}

const PRE_FLIGHT_STANDALONE = `
  SELECT "tenantId", LOWER("name") AS lname, COUNT(*) AS dup_count
  FROM "Product"
  WHERE "parentProductId" IS NULL
  GROUP BY "tenantId", LOWER("name")
  HAVING COUNT(*) > 1
  LIMIT 5;
`;

const PRE_FLIGHT_VARIANT = `
  SELECT "tenantId", "parentProductId", LOWER("name") AS lname, COUNT(*) AS dup_count
  FROM "Product"
  WHERE "parentProductId" IS NOT NULL
  GROUP BY "tenantId", "parentProductId", LOWER("name")
  HAVING COUNT(*) > 1
  LIMIT 5;
`;

const MIGRATION_STATEMENTS = [
  `ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_tenantId_name_key"`,
  `DROP INDEX IF EXISTS "Product_tenantId_name_key"`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Product_tenantId_name_root_key"
     ON "Product"("tenantId","name")
     WHERE "parentProductId" IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Product_tenantId_parent_name_key"
     ON "Product"("tenantId","parentProductId","name")
     WHERE "parentProductId" IS NOT NULL`,
];

const POST_FLIGHT = `
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'Product'
    AND indexname IN (
      'Product_tenantId_name_key',
      'Product_tenantId_name_root_key',
      'Product_tenantId_parent_name_key'
    )
  ORDER BY indexname;
`;

async function main() {
  // Railway exposes Postgres two ways:
  //   - postgres.railway.internal (private, no SSL — only reachable inside Railway)
  //   - <foo>.proxy.rlwy.net (public TCP proxy, also no SSL)
  // Neither speaks TLS, so don't ask for it. (For other hosted providers add
  // ?sslmode=require to the URL and SSL kicks in via libpq.)
  const isRailwayHost = /\.railway\.internal|\.proxy\.rlwy\.net/i.test(DATABASE_URL);
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: isRailwayHost ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Connected to ${redactUrl(DATABASE_URL)}`);

  try {
    // 1. Pre-flight checks
    console.log("\n[1/4] Pre-flight: checking for duplicate standalone names…");
    const dupRoot = await client.query(PRE_FLIGHT_STANDALONE);
    if (dupRoot.rows.length > 0) {
      console.error("  FAIL: standalone duplicates found (would block migration):");
      console.table(dupRoot.rows);
      process.exit(2);
    }
    console.log("  OK: 0 duplicate standalone names.");

    console.log("\n[2/4] Pre-flight: checking for duplicate variant names within a parent…");
    const dupVar = await client.query(PRE_FLIGHT_VARIANT);
    if (dupVar.rows.length > 0) {
      console.error("  FAIL: variant duplicates within same parent (would block migration):");
      console.table(dupVar.rows);
      process.exit(3);
    }
    console.log("  OK: 0 duplicate variant names within a parent.");

    // 2. Transactional migration
    console.log("\n[3/4] Applying migration inside a transaction…");
    await client.query("BEGIN");
    try {
      for (const sql of MIGRATION_STATEMENTS) {
        const oneLine = sql.replace(/\s+/g, " ").trim();
        console.log(`    > ${oneLine.slice(0, 100)}${oneLine.length > 100 ? "…" : ""}`);
        await client.query(sql);
      }
      await client.query("COMMIT");
      console.log("  OK: migration committed.");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("  FAIL: migration rolled back due to error:");
      console.error("  ", err.message);
      process.exit(4);
    }

    // 3. Post-flight verification
    console.log("\n[4/4] Verifying index state…");
    const post = await client.query(POST_FLIGHT);
    const present = new Set(post.rows.map((r) => r.indexname));
    const checks = [
      ["Product_tenantId_name_key", "should be GONE", !present.has("Product_tenantId_name_key")],
      [
        "Product_tenantId_name_root_key",
        "should EXIST (standalone unique)",
        present.has("Product_tenantId_name_root_key"),
      ],
      [
        "Product_tenantId_parent_name_key",
        "should EXIST (variant-per-parent unique)",
        present.has("Product_tenantId_parent_name_key"),
      ],
    ];
    let allOk = true;
    for (const [name, desc, ok] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${name} — ${desc}`);
      if (!ok) allOk = false;
    }
    if (!allOk) process.exit(5);

    console.log("\nDONE — migration applied successfully.");
  } finally {
    await client.end();
  }
}

function redactUrl(url) {
  return url.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1<redacted>$2");
}

main().catch((err) => {
  console.error("\nUNEXPECTED ERROR:", err);
  process.exit(99);
});
