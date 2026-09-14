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

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

// Hoisted to module scope so the top-level `.catch` below can scrub a connection string out
// of an error message.
let databaseUrl;

const DEMO_SLUG = "routeflow-demo";
const HOUSE_TENANT_SLUG = "routeflow-hq";
const TEST_TENANT_SLUGS = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

export function classify(slug) {
  if (slug === DEMO_SLUG) return "DEMO";
  if (slug === HOUSE_TENANT_SLUG) return "INTERNAL";
  if (TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug)) return "TEST";
  return "PRODUCTION";
}

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    databaseUrl = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });
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

    // Dark backfill running against a live, concurrently-written table: a tenant scanned above
    // can be deleted or reclassified by someone else before we get to write it. The write is
    // conditioned on the row still holding the `class` value we scanned (`updateMany` returns a
    // count instead of throwing when nothing matches — 0 = raced, count it as skipped, never
    // crash). P2025 is a defensive fallback for any single-record path; P2034 is Prisma's
    // write-conflict/deadlock code under concurrent writers. Every tenant is its own statement —
    // never wrap this loop in one transaction, or a single race turns into a full-run rollback.
    let applied = 0;
    let skipped = 0;
    for (const c of changes) {
      try {
        const result = await prisma.tenant.updateMany({
          where: { id: c.id, class: c.class },
          data: { class: c.newClass },
        });
        if (result.count === 0) {
          skipped++;
        } else {
          applied++;
        }
      } catch (err) {
        if (err.code === "P2025" || err.code === "P2034") {
          skipped++;
        } else {
          throw err;
        }
      }
    }
    console.log(
      `Applied ${applied} classification change(s), skipped ${skipped} (raced with a concurrent change).`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Only run the CLI when this file is the process entry point — never on import. Without this
// guard, importing `classify` alone (as tenant-class.util.spec.ts's cross-check does) would also
// invoke `main()`, which either crashes on a missing DATABASE_URL outside the CLI or, worse,
// silently opens a real Postgres connection as an unawaited side effect of a pure-function import.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    console.error(databaseUrl ? scrubSecrets(msg, databaseUrl) : msg);
    process.exit(1);
  });
}
