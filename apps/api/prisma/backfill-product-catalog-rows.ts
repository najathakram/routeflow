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
import {
  mirrorableImageKeys,
  parseFocalFromKey,
  planBarcodeRows,
} from "../src/products/product-barcode-rules";
import { lockBarcodeCodes, lockProductRow } from "../src/products/product-catalog-sync";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
// paying-tenant.cjs has no .d.cts declaration file (unlike test-tenants.cjs), so it is required
// rather than imported — informational-only use here (see the tenant guard below).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isProtectedTenant } = require("../scripts/lib/paying-tenant.cjs") as {
  isProtectedTenant: (
    tenant: { slug: string; status: string; deletedAt: Date | null | undefined; class: string },
    sub: { planKey?: string | null; stripeSubId?: string | null } | null | undefined,
    protectedSlugs: Set<string>,
  ) => boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadProtectedSlugs } = require("../scripts/lib/protected-slugs.cjs") as {
  loadProtectedSlugs: (
    env: Record<string, string | undefined>,
    dbUrl: string | null | undefined,
  ) => Set<string>;
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
  /** SA-572g(3): a product whose barcode changed between the page read and the row lock — its
   *  barcode rows are skipped THIS run rather than risk inverting the app's lock order. Counted so
   *  the run's output shows it, rather than a silent no-op the next run is left to explain. */
  barcodeSkippedCodeChanged: number;
  imageRowsPlanned: number;
  imageRowsInserted: number;
}

export interface BackfillOpts {
  tenantSlug?: string;
  allTenants?: boolean;
  apply: boolean;
  liveTenantOverride?: string;
  /** Row 195: loadProtectedSlugs() result. Required for any non-test tenant; never read from env here. */
  protectedSlugs?: Set<string>;
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
  const { tenantSlug, allTenants, apply, liveTenantOverride, protectedSlugs } = opts;

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
    barcodeSkippedCodeChanged: 0,
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
      if (!protectedSlugs) {
        throw new BackfillRefused("protected-tenant list not loaded for a non-test tenant");
      }
      const sub = await prisma.tenantSubscription.findUnique({ where: { tenantId: tenant.id } });
      if (
        isProtectedTenant(
          {
            slug: tenant.slug,
            status: tenant.status,
            deletedAt: tenant.deletedAt,
            class: tenant.class,
          },
          sub,
          protectedSlugs,
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

      for (const p of batch) {
        counts.products += 1;

        if (!apply) {
          // Dry-run stays read-only, unlocked, and planned entirely off THIS page read — no tx,
          // no lock, and nothing is ever written, so a concurrent writer changing the product
          // between this read and now can't corrupt a count that is discarded either way.
          if (p._count.barcodes > 0) {
            counts.productsWithBarcodeRowsAlready += 1;
          } else {
            counts.barcodeRowsPlanned += planBarcodeRows({
              barcode: p.barcode,
              unitsPerBox: p.unitsPerBox,
            }).length;
          }
          if (p._count.images > 0) {
            counts.productsWithImageRowsAlready += 1;
          } else {
            // #2728 M1 follow-up (SA-572f): plan against the SAME mirror set the sync/apply/read
            // paths use (own signable keys, deduped) — not the raw legacy array, which can hold a
            // duplicate or a foreign-prefixed key that would never become a row.
            counts.imageRowsPlanned += mirrorableImageKeys(p.id, p.imageKeys).length;
          }
          continue;
        }

        // Apply: F2/F3 (#2728 M1 follow-up, pre-merge BLOCK) — the page read above is a plain,
        // unlocked SELECT, so by the time this product's turn comes up a concurrent app writer
        // (products.service.ts update(), variant-resolution.service.ts completeSetup()) may have
        // already synced its ProductBarcode/ProductImage rows, or changed which barcode it holds.
        // Racing the app's own dual-write with an unlocked raw insert risks either a raw P2002
        // (500) or stale rows planned from data that's already moved on. So: skip products this
        // page already shows as fully done (no tx needed — nothing to insert either way), then for
        // the rest open ONE short interactive transaction per product, taking locks in the EXACT
        // SAME ORDER the app does — the barcode code lock first (lockBarcodeCodes), then the
        // Product row lock (lockProductRow, the same row an app write statement would lock) — so
        // this can never deadlock against a concurrent app writer (image-only paths take just the
        // row lock, a strict subset of this order). Only after BOTH locks are held does it re-read
        // the product fresh: that re-read is what makes a concurrent barcode change (X → Y) safe —
        // this planner reacts to the CURRENT barcode, not the one the page read saw, and a
        // concurrent row insert (already-has-rows) is caught by the fresh `_count` and skipped.
        const needsBarcodeRows = p._count.barcodes === 0;
        const needsImageRows = p._count.images === 0;
        if (!needsBarcodeRows) counts.productsWithBarcodeRowsAlready += 1;
        if (!needsImageRows) counts.productsWithImageRowsAlready += 1;
        if (!needsBarcodeRows && !needsImageRows) continue;

        await prisma.$transaction(async (tx) => {
          await lockBarcodeCodes(tx, tenant.id, [p.barcode]);
          await lockProductRow(tx, tenant.id, p.id);
          const fresh = await tx.product.findUnique({
            where: { id: p.id },
            select: {
              barcode: true,
              unitsPerBox: true,
              imageKeys: true,
              tenantId: true,
              _count: { select: { barcodes: true, images: true } },
            },
          });
          if (!fresh || fresh.tenantId !== tenant.id) return;

          // The barcode lock above is the PAGE-READ code. If the code changed before we got the row
          // lock, we hold the wrong code's lock, and taking the new one now (after the row lock) would
          // invert the app's order (code → row) and could deadlock. Skip its barcode rows this run;
          // the next run mirrors it (it is still row-less only if no app sync ran).
          if (needsBarcodeRows && fresh._count.barcodes === 0 && fresh.barcode !== p.barcode) {
            counts.barcodeSkippedCodeChanged += 1;
          }
          if (needsBarcodeRows && fresh._count.barcodes === 0 && fresh.barcode === p.barcode) {
            const rows = planBarcodeRows({
              barcode: fresh.barcode,
              unitsPerBox: fresh.unitsPerBox,
            });
            counts.barcodeRowsPlanned += rows.length;
            if (rows.length > 0) {
              const barcodeData: Prisma.ProductBarcodeCreateManyInput[] = rows.map((row) => ({
                tenantId: tenant.id,
                productId: p.id,
                code: row.code,
                symbology: row.symbology,
                level: row.level,
                origin: row.origin,
                copiedFromLevel: row.copiedFromLevel,
                primaryFor: row.primaryFor,
              }));
              const res = await tx.productBarcode.createMany({
                data: barcodeData,
                skipDuplicates: true,
              });
              counts.barcodeRowsInserted += res.count;
            }
          }

          if (needsImageRows && fresh._count.images === 0) {
            // #2728 M1 follow-up (SA-572f): plan/insert against mirrorableImageKeys (own, deduped),
            // and — PER KEY, mirroring the app's own dual-write belt — never insert a row for a key
            // another product's row already holds. The backfill is INSERT-ONLY, so a held key is
            // simply omitted here; it is never deleted or reassigned.
            const mirrorKeys = mirrorableImageKeys(p.id, fresh.imageKeys);
            const foreignHeld: Array<{ storageKey: string }> =
              mirrorKeys.length > 0
                ? await tx.productImage.findMany({
                    where: {
                      tenantId: tenant.id,
                      storageKey: { in: mirrorKeys },
                      // A tray row (productId NULL) counts as held too: `<>` is NULL-false in SQL.
                      OR: [{ productId: { not: p.id } }, { productId: null }],
                    },
                    select: { storageKey: true },
                  })
                : [];
            const foreignKeys = new Set(foreignHeld.map((r) => r.storageKey));

            const imageData: Prisma.ProductImageCreateManyInput[] = mirrorKeys
              .map((key, index) => ({ key, index }))
              .filter(({ key }) => !foreignKeys.has(key))
              .map(({ key, index }) => {
                const focal = parseFocalFromKey(key);
                return {
                  tenantId: tenant.id,
                  productId: p.id,
                  storageKey: key,
                  sortOrder: index,
                  isPrimary: index === 0,
                  focalX: focal?.x ?? null,
                  focalY: focal?.y ?? null,
                };
              });
            counts.imageRowsPlanned += imageData.length;
            if (imageData.length > 0) {
              const res = await tx.productImage.createMany({
                data: imageData,
                skipDuplicates: true,
              });
              counts.imageRowsInserted += res.count;
            }
          }
        });
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
    const opts = {
      ...parseArgs(process.argv.slice(2)),
      protectedSlugs: loadProtectedSlugs(process.env, dbUrl),
    };
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

/**
 * (g) #2728 M1 follow-up, pre-merge BLOCK: a raw error object/message can carry a tenant slug,
 * product name, or barcode value (e.g. a Postgres constraint-violation message quoting the row) —
 * this script's own header promises stderr NEVER echoes one. Print only the error's name and (if
 * present) its `code`, never `.message`, `.meta`, or the stack.
 */
export function formatErrorForStderr(e: unknown): string {
  const name = e instanceof Error ? e.name : "Error";
  const rawCode = (e as { code?: unknown } | null)?.code;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "";
  return `${name}${code ? ` ${code}` : ""}`;
}

// Only run main() when this file is executed directly — never on import, so a spec can import
// `backfillProductCatalogRows` without triggering a real DB connection at module load.
if (require.main === module) {
  main().catch((e) => {
    console.error(formatErrorForStderr(e));
    process.exit(1);
  });
}
