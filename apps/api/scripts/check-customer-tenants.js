const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const p = new PrismaClient({ adapter });

const AFFA_TENANT_ID = "0e74ddf9-a864-49c3-aa8f-20aead79b0cf";

async function main() {
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

  // 2. How many customers does affa tenant currently have (total)?
  const affaCount = await p.$queryRawUnsafe(`
    SELECT COUNT(*)::int as cnt FROM "Customer" WHERE "tenantId" = '${AFFA_TENANT_ID}' AND "deletedAt" IS NULL
  `);
  console.log("\n=== Affa tenant visible customer count ===");
  console.log(JSON.stringify(affaCount, null, 2));

  // 3. Customers with no tenantId that have a zohoContactId
  const nullTenant = await p.$queryRawUnsafe(`
    SELECT COUNT(*)::int as cnt FROM "Customer"
    WHERE "tenantId" IS NULL AND "zohoContactId" IS NOT NULL
  `);
  console.log("\n=== Customers with zohoContactId but NULL tenantId ===");
  console.log(JSON.stringify(nullTenant, null, 2));

  // 4. Sample the orphaned customers to confirm who they are
  const sample = await p.$queryRawUnsafe(`
    SELECT c."id", c."businessName", c."zohoContactId", c."tenantId", c."deletedAt"
    FROM "Customer" c
    WHERE c."zohoContactId" IS NOT NULL
      AND c."tenantId" != '${AFFA_TENANT_ID}'
      OR (c."zohoContactId" IS NOT NULL AND c."tenantId" IS NULL)
    LIMIT 5
  `);
  console.log("\n=== Sample mismatched customers ===");
  console.log(JSON.stringify(sample, null, 2));
}

main()
  .catch((e) => console.error("ERROR:", e.message))
  .finally(() => pool.end());
