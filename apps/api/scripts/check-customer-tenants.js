/**
 * Read-only diagnostic: how are Zoho-imported customers distributed across
 * tenants, and does the target tenant see the expected customer count?
 *
 * Usage:
 *   node apps/api/scripts/check-customer-tenants.js <tenantId>
 *
 * Run via `railway run --service postgres node apps/api/scripts/check-customer-tenants.js <tenantId>`.
 * The connection comes from scripts/lib/report-db-url.mjs (B768): Railway's TCP-proxy variables
 * win, because under `railway run` DATABASE_URL is the unreachable *.railway.internal host.
 */
const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("Usage: node apps/api/scripts/check-customer-tenants.js <tenantId>");
  process.exit(1);
}

let pool;
let p;

async function main() {
  const { resolveReportDbUrl } = await import("./lib/report-db-url.mjs");
  const url = resolveReportDbUrl("check-customer-tenants");
  if (!url) process.exit(2);
  pool = new Pool({ connectionString: url });
  p = new PrismaClient({ adapter: new PrismaPg(pool) });

  // 1. How are zoho-imported customers distributed by tenantId?
  const dist = await p.$queryRawUnsafe(`
    SELECT c."tenantId", COUNT(*)::int as cnt
    FROM "Customer" c
    WHERE c."zohoContactId" IS NOT NULL
    GROUP BY c."tenantId"
    ORDER BY cnt DESC
  `);
  console.log("=== Zoho customer distribution by tenantId ===");
  console.log(JSON.stringify(dist, null, 2));

  // 2. How many customers does the target tenant currently have (total)?
  const targetCount = await p.$queryRaw`
    SELECT COUNT(*)::int as cnt FROM "Customer"
    WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
  `;
  console.log("\n=== Target tenant visible customer count ===");
  console.log(JSON.stringify(targetCount, null, 2));

  // 3. Customers with no tenantId that have a zohoContactId
  const nullTenant = await p.$queryRawUnsafe(`
    SELECT COUNT(*)::int as cnt FROM "Customer"
    WHERE "tenantId" IS NULL AND "zohoContactId" IS NOT NULL
  `);
  console.log("\n=== Customers with zohoContactId but NULL tenantId ===");
  console.log(JSON.stringify(nullTenant, null, 2));

  // 4. Sample the orphaned customers to confirm who they are
  const sample = await p.$queryRaw`
    SELECT c."id", c."businessName", c."zohoContactId", c."tenantId", c."deletedAt"
    FROM "Customer" c
    WHERE (c."zohoContactId" IS NOT NULL AND c."tenantId" != ${tenantId})
       OR (c."zohoContactId" IS NOT NULL AND c."tenantId" IS NULL)
    LIMIT 5
  `;
  console.log("\n=== Sample mismatched customers ===");
  console.log(JSON.stringify(sample, null, 2));
}

main()
  .catch((e) => console.error("ERROR:", e.message))
  .finally(() => pool?.end());
