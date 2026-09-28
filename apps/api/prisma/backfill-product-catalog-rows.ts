/**
 * BACKFILL: populate the new #2717 M1 catalog tables (ProductBarcode, ProductImage) from each
 * product's legacy columns (barcode/unitsPerBox, imageKeys) — SA-572a/b.
 *
 * Rulings (SA-572a/b), enforced here, not negotiable by a flag:
 *   - INSERT-ONLY into the new tables. Never modifies or removes anything, including the
 *     legacy columns themselves — those stay the truth until every reader moves off them (M4).
 *   - DRY-RUN by default. `--apply` is required to write anything.
 *   - Idempotent: a product that already has ANY ProductBarcode/ProductImage rows is skipped
 *     entirely for that table (never re-planned, never re-inserted) — `createMany({ skipDuplicates: true })`
 *     is a second line of defence, not the primary one.
 *   - Test tenants (scripts/lib/test-tenants.cjs `isTestTenant`) run freely. Every OTHER
 *     (non-test) tenant is REFUSED unless `--live-tenant-override=<that exact slug>` is passed —
 *     the owner's per-tenant yes. `--all-tenants` is a READ-ONLY, dry-run-only global report
 *     across every tenant (no per-tenant guard needed, since nothing is ever written by it).
 *   - Output is COUNTS ONLY — never a tenant slug/name/id, product name/id, or barcode value.
 *
 * `backfillProductCatalogRows(prisma, opts)` is the exported, connection-agnostic entry point (a
 * db-spec builds its own PrismaClient and calls it directly); `main()` runs ONLY when this file is
 * executed directly (`require.main === module`), never on import.
 *
 * OWNER-RUN ONLY on prod, from the repo root, AFTER the #2728 migration has been applied and
 * drift is 0:
 *   # global dry-run counts, every tenant, read-only:
 *   railway run --service postgres -- npm --prefix apps/api run db:backfill:catalog-rows -- --all-tenants
 *   # a single test tenant, dry-run then apply:
 *   railway run --service postgres -- npm --prefix apps/api run db:backfill:catalog-rows -- --tenant=test
 *   railway run --service postgres -- npm --prefix apps/api run db:backfill:catalog-rows -- --tenant=test --apply
 *   # a LIVE tenant — ONLY with the owner's per-tenant yes:
 *   railway run --service postgres -- npm --prefix apps/api run db:backfill:catalog-rows -- \
 *     --tenant=<slug> --apply --live-tenant-override=<slug>
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseFocalFromKey, planBarcodeRows } from "../src/products/product-barcode-rules";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
// paying-tenant.cjs has no .d.cts declaration file (unlike test-tenants.cjs), so it is required
// rather than imported — informational-only use here (see the tenant guard below).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isProtectedTenant } = require("../scripts/lib/paying-tenant.cjs") as {
  isProtectedTenant: (
    tenant: { status: string; deletedAt: Date | null | undefined; class: string },
    sub: { planKey?: string | null; stripeSubId?: string | null } | null | undefined,
  ) => boolean;
};

const BATCH_SIZE = 500;

export class BackfillRefused extends Error {}

export interface BackfillCounts {
  mode: "dry-run" | "apply";
  tenants: number;
  products: number;
  productsWithBarcodeRowsAlready: number;
  productsWithImageRowsAlready: number;
  barcodeRowsPlanned: number;
  barcodeRowsInserted: number;
  imageRowsPlanned: number;
  imageRowsInserted: number;
}

export interface BackfillOpts {
  tenantSlug?: string;
  allTenants?: boolean;
  apply: boolean;
  liveTenantOverride?: string;
}

/** Strip credentials from a Postgres connection string for safe logging. */
function maskDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function resolveDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error(
    "Missing env: DATABASE_URL. Set it, or run via: railway run --service postgres -- npm --prefix apps/api run db:backfill:catalog-rows",
  );
}

type ProductBatchRow = {
  id: string;
  barcode: string | null;
  unitsPerBox: number | null;
  imageKeys: string[];
  _count: { barcodes: number; images: number };
};

/**
 * Publish plan v13's shape: no Pool/PrismaClient is constructed here — the caller (main(), or a
 * DB-backed spec) owns the connection lifecycle. Validation happens BEFORE any query.
 */
export async function backfillProductCatalogRows(
  prisma: PrismaClient,
  opts: BackfillOpts,
): Promise<BackfillCounts> {
  const { tenantSlug, allTenants, apply, liveTenantOverride } = opts;

  if (!tenantSlug && !allTenants) {
    throw new BackfillRefused("exactly one of --tenant=<slug> or --all-tenants is required");
  }
  if (tenantSlug && allTenants) {
    throw new BackfillRefused("pass either --tenant=<slug> or --all-tenants, not both");
  }
  if (allTenants && apply) {
    throw new BackfillRefused("--all-tenants is dry-run only — drop --apply, or scope --tenant");
  }
  if (liveTenantOverride != null && liveTenantOverride !== tenantSlug) {
    throw new BackfillRefused(
      // R-030a: refusal text never echoes a slug (stderr may be pasted to the board).
      "--live-tenant-override does not match --tenant (it must name the SAME tenant)",
    );
  }

  const counts: BackfillCounts = {
    mode: apply ? "apply" : "dry-run",
    tenants: 0,
    products: 0,
    productsWithBarcodeRowsAlready: 0,
    productsWithImageRowsAlready: 0,
    barcodeRowsPlanned: 0,
    barcodeRowsInserted: 0,
    imageRowsPlanned: 0,
    imageRowsInserted: 0,
  };

  let tenants: Array<{ id: string; slug: string }>;

  if (allTenants) {
    // Read-only global report — no per-tenant guard needed since nothing is ever written here.
    tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  } else {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, slug: true, status: true, deletedAt: true, class: true },
    });
    if (!tenant) {
      throw new BackfillRefused("tenant not found (check --tenant)");
    }
    if (!isTestTenant(tenant.slug)) {
      if (liveTenantOverride !== tenant.slug) {
        throw new BackfillRefused(
          "non-test tenant: refusing without --live-tenant-override=<the same slug> " +
            "(the owner's per-tenant yes)",
        );
      }
      // The override IS the owner's per-tenant yes — still allowed even when protected (paying).
      // This is informational only: a counts-only stderr warning, never a second refusal.
      const sub = await prisma.tenantSubscription.findUnique({ where: { tenantId: tenant.id } });
      if (
        isProtectedTenant(
          {
            status: tenant.status,
            deletedAt: tenant.deletedAt,
            class: tenant.class,
          },
          sub,
        )
      ) {
        process.stderr.write("WARNING: protected (paying) tenant, owner override present\n");
      }
    }
    tenants = [{ id: tenant.id, slug: tenant.slug }];
  }

  counts.tenants = tenants.length;

  for (const tenant of tenants) {
    let cursor: string | undefined;
    for (;;) {
      const batch: ProductBatchRow[] = await prisma.product.findMany({
        where: { tenantId: tenant.id, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: {
          id: true,
          barcode: true,
          unitsPerBox: true,
          imageKeys: true,
          _count: { select: { barcodes: true, images: true } },
        },
      });
      if (batch.length === 0) break;

      const barcodeData: Prisma.ProductBarcodeCreateManyInput[] = [];
      const imageData: Prisma.ProductImageCreateManyInput[] = [];

      for (const p of batch) {
        counts.products += 1;

        if (p._count.barcodes > 0) {
          counts.productsWithBarcodeRowsAlready += 1;
        } else {
          const rows = planBarcodeRows({ barcode: p.barcode, unitsPerBox: p.unitsPerBox });
          for (const row of rows) {
            counts.barcodeRowsPlanned += 1;
            barcodeData.push({
              tenantId: tenant.id,
              productId: p.id,
              code: row.code,
              symbology: row.symbology,
              level: row.level,
              origin: row.origin,
              copiedFromLevel: row.copiedFromLevel,
              primaryFor: row.primaryFor,
            });
          }
        }

        if (p._count.images > 0) {
          counts.productsWithImageRowsAlready += 1;
        } else {
          p.imageKeys.forEach((key, index) => {
            counts.imageRowsPlanned += 1;
            const focal = parseFocalFromKey(key);
            imageData.push({
              tenantId: tenant.id,
              productId: p.id,
              storageKey: key,
              sortOrder: index,
              isPrimary: index === 0,
              focalX: focal?.x ?? null,
              focalY: focal?.y ?? null,
            });
          });
        }
      }

      if (apply) {
        if (barcodeData.length > 0) {
          const res = await prisma.productBarcode.createMany({
            data: barcodeData,
            skipDuplicates: true,
          });
          counts.barcodeRowsInserted += res.count;
        }
        if (imageData.length > 0) {
          const res = await prisma.productImage.createMany({
            data: imageData,
            skipDuplicates: true,
          });
          counts.imageRowsInserted += res.count;
        }
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }
  }

  return counts;
}

function parseArgs(argv: string[]): BackfillOpts {
  const argVal = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    tenantSlug: argVal("tenant"),
    allTenants: argv.includes("--all-tenants"),
    apply: argv.includes("--apply"),
    liveTenantOverride: argVal("live-tenant-override"),
  };
}

async function main() {
  const dbUrl = resolveDbUrl();
  console.error(`backfill-product-catalog-rows target: ${maskDbUrl(dbUrl)}`);

  const pool = new Pool({ connectionString: dbUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const opts = parseArgs(process.argv.slice(2));
    const counts = await backfillProductCatalogRows(prisma, opts);
    console.log(JSON.stringify(counts));
  } catch (err) {
    if (err instanceof BackfillRefused) {
      console.error(`REFUSED: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

// Only run main() when this file is executed directly — never on import, so a spec can import
// `backfillProductCatalogRows` without triggering a real DB connection at module load.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
