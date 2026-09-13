// apps/api/scripts/backfill-tenant-class.mjs
//
// Dark backfill of Tenant.class from the slug classification rule. "Dark" means: this
// script only WRITES the column. No KPI query filters on it until a human has reviewed
// the printed classification table against the known real-tenant list and a SEPARATE
// follow-up change (Task 9) flips MrrService/getStats() to filter by it. Idempotent —
// safe to run more than once; re-classifies every tenant every run (cheap, ~30 rows).
//
// Usage:
//   node apps/api/scripts/backfill-tenant-class.mjs           # dry run, prints table only
//   node apps/api/scripts/backfill-tenant-class.mjs --apply   # writes the classification

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const DEMO_SLUG = "routeflow-demo";
const HOUSE_TENANT_SLUG = "routeflow-hq";
const TEST_TENANT_SLUGS = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

function classify(slug) {
  if (slug === DEMO_SLUG) return "DEMO";
  if (slug === HOUSE_TENANT_SLUG) return "INTERNAL";
  if (TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug)) return "TEST";
  return "PRODUCTION";
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) {
    console.error("Missing env: DATABASE_URL");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, slug: true, name: true, class: true },
      orderBy: { slug: "asc" },
    });

    const changes = tenants
      .map((t) => ({ ...t, newClass: classify(t.slug) }))
      .filter((t) => t.newClass !== t.class);

    console.log(`${tenants.length} tenants scanned, ${changes.length} classification change(s):`);
    console.table(
      changes.map((c) => ({ slug: c.slug, name: c.name, from: c.class, to: c.newClass })),
    );

    if (!apply) {
      console.log("\nDry run only — pass --apply to write these changes.");
      return;
    }

    for (const c of changes) {
      await prisma.tenant.update({ where: { id: c.id }, data: { class: c.newClass } });
    }
    console.log(`Applied ${changes.length} classification change(s).`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
