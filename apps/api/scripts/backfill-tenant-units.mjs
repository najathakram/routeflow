// apps/api/scripts/backfill-tenant-units.mjs  (units U-6)
//
// Backfills the tenant unit-name list from the unit words a tenant already uses:
//   (a) distinct words: ProductUnit.label (ladder levels) + Product.unit (legacy pack word);
//   (b) one TenantUnit per distinct nameKey (= lower(trim(name))), named by the most common
//       casing; > 30 chars are reported and skipped; Piece synonyms (piece/pieces/each/unit/pcs)
//       get no TenantUnit;
//   (c) ProductUnit.tenantUnitId linked by nameKey where NULL;
//   (d) Product.packLabel filled where NULL/blank with the tenant's canonical unit name for the
//       legacy `unit` word (never a Piece synonym; Product.unit itself is NEVER written);
//   (e) Product.baseUnitLabel is left NULL (null = "Piece").
// Never touches line snapshots or any order / invoice table.
//
// SAFETY
//   - DRY-RUN by default; writes ONLY with --apply.
//   - --tenant <slug> is required. With --apply the slug must pass assertTestTenant. There is no
//     live-tenant path in this script until the owner approves one.
//   - DATABASE_URL only, and it must be PROVABLY local (localhost / 127.0.0.1 / ::1 / compose
//     `postgres`). There is no override flag; Railway proxy variables are never read.
//   - Writes go in small transactions: one for the TenantUnit upserts, then one per batch of
//     BACKFILL_BATCH_SIZE products (lib/tenant-units-apply.cjs). Idempotent: TenantUnit upserts by
//     (tenantId, nameKey); only NULL fields are filled; a re-run plans zero changes. A crash between
//     batches keeps the finished batches; re-running resumes with what is still missing.
//   - Output is COUNTS ONLY (no unit names, no ids).
//
// Sequencing: run this for a tenant BEFORE the Settings > Units UI / ladder editor is visible to it.
//
// Usage:
//   DATABASE_URL=postgresql://...@localhost:5432/db node apps/api/scripts/backfill-tenant-units.mjs --tenant qa-x
//   ... --tenant qa-x --apply
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { localConnectionConfig } = require("./lib/local-db-target.cjs");
const { planTenantUnits } = require("./lib/tenant-units-plan.cjs");
const { applyTenantUnitsPlan, BACKFILL_BATCH_SIZE } = require("./lib/tenant-units-apply.cjs");

export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const idx = argv.indexOf("--tenant");
  if (idx === -1) throw new Error("--tenant <slug> is required");
  if (argv.indexOf("--tenant", idx + 1) !== -1) throw new Error("--tenant may be given only once");
  const slug = argv[idx + 1];
  if (!slug || slug.startsWith("--")) throw new Error("--tenant requires a slug value");
  return { apply, slug };
}

/** Pre-connection gates: throws on a refused combination. Returns the local pg config. */
export function resolveTarget({ apply, slug }, env = process.env) {
  if (apply) assertTestTenant(slug, "backfill-tenant-units.mjs --apply");
  const cfg = localConnectionConfig(env.DATABASE_URL);
  if (!cfg) {
    throw new Error(
      "Refusing: DATABASE_URL is missing or not provably local (localhost, 127.0.0.1, ::1, postgres). " +
        "This script has no remote-target override.",
    );
  }
  return cfg;
}

const fmt = (c) =>
  `tenantUnits created=${c.tenantUnitsCreated} existing=${c.tenantUnitsExisting}; ` +
  `productUnits linked=${c.productUnitsLinked}; products packLabel filled=${c.productsPackLabelFilled}; ` +
  `skipped tooLong=${c.skippedTooLong} synonyms=${c.skippedSynonyms}`;

async function main() {
  let args;
  let cfg;
  try {
    args = parseArgs(process.argv.slice(2));
    cfg = resolveTarget(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool(cfg);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: args.slug },
      select: { id: true },
    });
    if (!tenant) {
      console.error("Refusing: no tenant with that slug.");
      process.exit(1);
    }
    const tenantId = tenant.id;
    console.log(args.apply ? "MODE: APPLY (writes)" : "MODE: dry-run (no writes)");

    const [productUnitRows, products, existingUnits] = await Promise.all([
      prisma.productUnit.findMany({
        where: { tenantId },
        select: { id: true, productId: true, label: true, tenantUnitId: true },
      }),
      prisma.product.findMany({
        where: { tenantId },
        select: { id: true, unit: true, packLabel: true },
      }),
      prisma.tenantUnit.findMany({
        where: { tenantId },
        select: { id: true, nameKey: true, name: true },
      }),
    ]);
    const plan = planTenantUnits({ productUnits: productUnitRows, products, existingUnits });

    // Dry-run reports the plan; --apply reports what the writes actually changed.
    let counts = plan.counts;
    if (args.apply) {
      const result = await applyTenantUnitsPlan({
        prisma,
        tenantId,
        plan,
        existingUnits,
        productIdByUnit: new Map(productUnitRows.map((u) => [u.id, u.productId])),
        batchSize: BACKFILL_BATCH_SIZE,
      });
      console.log(`Batches: ${result.batches} (up to ${BACKFILL_BATCH_SIZE} products each)`);
      if (result.linksChanged + result.fillsChanged > 0) {
        console.log(
          `Changed since planning (skipped, not overwritten): productUnits=${result.linksChanged} ` +
            `products=${result.fillsChanged}; re-run to pick them up.`,
        );
      }
      counts = {
        ...plan.counts,
        productUnitsLinked: result.linked,
        productsPackLabelFilled: result.filled,
      };
    }
    console.log(`${args.apply ? "Applied" : "Would apply"}: ${fmt(counts)}`);
    if (!args.apply) console.log("Dry run only; pass --apply to write.");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
}
