/**
 * REPORT (read-only): reconcile #2717 M1's ProductBarcode rows against the legacy columns they
 * were planned from (SA-572a, R12) — never writes anything.
 *
 * Two counts:
 *   - codesOnMultipleProducts: a (tenantId, code) held by rows of more than one DISTINCT product —
 *     a `ProductBarcode` unique constraint violation waiting to happen, or evidence two products
 *     share a code some other way.
 *   - productsDriftedFromLegacy: a product WITH rows whose (code, level) set does not equal what
 *     `planBarcodeRows` would plan today from its legacy `barcode`/`unitsPerBox` columns — i.e. the
 *     rows and the legacy columns have diverged since the backfill ran.
 *
 * `countBarcodeConflicts` is a PURE function (no I/O) so it is covered by a plain unit spec.
 * `main()` (optional `--tenant=<slug>` scope) is exercised by hand against a real Postgres; it
 * prints ONE JSON counts object and nothing else — never a tenant slug/name/id, product name/id,
 * or barcode value.
 *
 * OWNER-RUN ONLY on prod, from the repo root:
 *   railway run --service postgres -- npm --prefix apps/api run db:report:barcode-conflicts
 *   railway run --service postgres -- npm --prefix apps/api run db:report:barcode-conflicts -- --tenant=<slug>
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { planBarcodeRows } from "../src/products/product-barcode-rules";

export interface BarcodeConflictRow {
  tenantId: string;
  productId: string;
  code: string;
  level: string;
  /** Optional so a caller that only has (code, level) still counts shared codes; when present, the drift check
   *  compares the full mirror tuple (an origin/primary mismatch is drift too). */
  origin?: string | null;
  copiedFromLevel?: string | null;
  primaryFor?: string | null;
}

export interface BarcodeConflictProduct {
  id: string;
  tenantId: string | null;
  barcode: string | null;
  unitsPerBox: number | null;
  hasRows: boolean;
}

export interface BarcodeConflictCounts {
  codesOnMultipleProducts: number;
  productsDriftedFromLegacy: number;
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
    "Missing env: DATABASE_URL. Set it, or run via: railway run --service postgres -- npm --prefix apps/api run db:report:barcode-conflicts",
  );
}

/** Sorted "code|level" pairs, for a simple multiset-equality comparison. */
function rowKeys(
  rows: Array<{
    code: string;
    level: string;
    origin?: string | null;
    copiedFromLevel?: string | null;
    primaryFor?: string | null;
  }>,
): string[] {
  return rows
    .map(
      (r) =>
        `${r.code}|${r.level}|${r.origin ?? ""}|${r.copiedFromLevel ?? ""}|${r.primaryFor ?? ""}`,
    )
    .sort();
}

/**
 * PURE — no I/O. `rows` is every ProductBarcode row (across whatever scope the caller selected);
 * `products` is every product in that same scope, `hasRows` = it has at least one row among `rows`.
 */
export function countBarcodeConflicts(
  rows: BarcodeConflictRow[],
  products: BarcodeConflictProduct[],
): BarcodeConflictCounts {
  const byTenantCode = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.tenantId}::${row.code}`;
    const set = byTenantCode.get(key) ?? new Set<string>();
    set.add(row.productId);
    byTenantCode.set(key, set);
  }
  let codesOnMultipleProducts = 0;
  for (const productIds of byTenantCode.values()) {
    if (productIds.size > 1) codesOnMultipleProducts += 1;
  }

  const rowsByProduct = new Map<string, BarcodeConflictRow[]>();
  for (const row of rows) {
    const list = rowsByProduct.get(row.productId) ?? [];
    list.push(row);
    rowsByProduct.set(row.productId, list);
  }

  let productsDriftedFromLegacy = 0;
  for (const product of products) {
    if (!product.hasRows) continue;
    const actual = rowsByProduct.get(product.id) ?? [];
    const planned = planBarcodeRows({ barcode: product.barcode, unitsPerBox: product.unitsPerBox });
    const actualKeys = rowKeys(actual);
    const plannedKeys = rowKeys(planned);
    const same =
      actualKeys.length === plannedKeys.length && actualKeys.every((k, i) => k === plannedKeys[i]);
    if (!same) productsDriftedFromLegacy += 1;
  }

  return { codesOnMultipleProducts, productsDriftedFromLegacy };
}

function parseArgs(argv: string[]): { tenantSlug?: string } {
  const argVal = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return { tenantSlug: argVal("tenant") };
}

async function loadCounts(
  prisma: PrismaClient,
  tenantSlug?: string,
): Promise<BarcodeConflictCounts> {
  const tenantWhere = tenantSlug ? { where: { slug: tenantSlug }, select: { id: true } } : null;
  let tenantId: string | undefined;
  if (tenantWhere) {
    const tenant = await prisma.tenant.findUnique(tenantWhere);
    if (!tenant) throw new Error(`tenant "${tenantSlug}" not found`);
    tenantId = tenant.id;
  }

  const rows = await prisma.productBarcode.findMany({
    where: tenantId ? { tenantId } : undefined,
    select: {
      tenantId: true,
      productId: true,
      code: true,
      level: true,
      origin: true,
      copiedFromLevel: true,
      primaryFor: true,
    },
  });
  const rowProductIds = new Set(rows.map((r) => r.productId));

  const products = await prisma.product.findMany({
    where: tenantId ? { tenantId } : undefined,
    select: { id: true, tenantId: true, barcode: true, unitsPerBox: true },
  });

  return countBarcodeConflicts(
    rows,
    products.map((p) => ({ ...p, hasRows: rowProductIds.has(p.id) })),
  );
}

async function main() {
  const dbUrl = resolveDbUrl();
  console.error(`report-product-barcode-conflicts target: ${maskDbUrl(dbUrl)}`);

  const pool = new Pool({ connectionString: dbUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const { tenantSlug } = parseArgs(process.argv.slice(2));
    const counts = await loadCounts(prisma, tenantSlug);
    console.log(JSON.stringify(counts));
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * (g) #2728 M1 follow-up, pre-merge BLOCK: this script's own header promises stderr never prints a
 * tenant slug/name/id, product name/id, or barcode value — a raw error object/message can carry
 * one (e.g. a Postgres error quoting the row). Print only the error's name and (if present) its
 * `code`, never `.message`, `.meta`, or the stack.
 */
export function formatErrorForStderr(e: unknown): string {
  const name = e instanceof Error ? e.name : "Error";
  const rawCode = (e as { code?: unknown } | null)?.code;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "";
  return `${name}${code ? ` ${code}` : ""}`;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(formatErrorForStderr(e));
    process.exit(1);
  });
}
