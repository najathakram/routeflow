/**
 * Backfill RouteStop.customerAddressId for rows where it is NULL.
 *
 * Uses the customer's default address (isDefault=true), falling back to the
 * oldest address (createdAt asc) if no default is flagged.
 *
 * Run: node apps/api/scripts/backfill-route-stop-addresses.js            (dry run)
 *      node apps/api/scripts/backfill-route-stop-addresses.js --apply    (write changes)
 *
 * Accepts DATABASE_URL from env; falls back to local dev DSN.
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");

const apply = process.argv.includes("--apply");
const DSN =
  process.env.DATABASE_URL ||
  "postgresql://user:pass@localhost:5432/routeflow_dev";

const pool = new Pool({ connectionString: DSN });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(`Mode: ${apply ? "APPLY (writing)" : "DRY RUN"}`);

  const orphans = await prisma.routeStop.findMany({
    where: { customerAddressId: null },
    select: { id: true, customerId: true, routeId: true },
  });
  console.log(`Found ${orphans.length} RouteStop rows with null customerAddressId`);

  if (orphans.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const customerIds = Array.from(new Set(orphans.map((s) => s.customerId)));
  const addresses = await prisma.customerAddress.findMany({
    where: { customerId: { in: customerIds } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  const byCustomer = new Map();
  for (const a of addresses) if (!byCustomer.has(a.customerId)) byCustomer.set(a.customerId, a);

  let fixed = 0;
  let skipped = 0;
  for (const stop of orphans) {
    const addr = byCustomer.get(stop.customerId);
    if (!addr) {
      skipped++;
      continue;
    }
    if (apply) {
      await prisma.routeStop.update({
        where: { id: stop.id },
        data: { customerAddressId: addr.id },
      });
    }
    fixed++;
  }

  console.log(
    `Summary: scanned=${orphans.length} fixed=${fixed} skipped_no_address=${skipped}`,
  );
  if (!apply) console.log("Run with --apply to write changes.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
