/**
 * REPORT (read-only, COUNTS ONLY) — #2717 M2 (SA-574 Q4, R-030a): how many variants price
 * differently from their family today. This is the number the owner reads BEFORE flipping a tenant's
 * `mixed_packs` mode to `on`: the first family edit after a flip overwrites every differing variant
 * (audited), so the counts say how much would move.
 *
 * Counts (all of them numbers; nothing else is ever printed):
 *   - variantsWithTierDiff: variants whose EFFECTIVE ladder (tiers 1-5 through `getTierPrice`,
 *     `roundMoney` before comparing — a raw 0 tier equals an explicit tier at the list price)
 *     differs from their family's;
 *   - familiesWithTierDiff: families that have at least one such variant;
 *   - variantsWithPackSizeDiff: variants whose `unitsPerBox` differs from their family's;
 *   - inactiveVariantsWithTierDiff: the differing variants that are inactive (the flip would still
 *     rewrite them);
 *   - customersWithCustomerPriceTierDiff: customers whose CustomerPrice rows put different pricing
 *     tiers on the variants of ONE family (after write-through the flavors of one box could still
 *     price at different tiers for that customer).
 *
 * `countVariantTierDrift` is PURE (no I/O) so a plain unit spec covers it. `main()` (optional
 * `--tenant=<slug>`) prints ONE JSON counts object — never a tenant slug/name/id, product or
 * customer id/name, SKU or price. Every read runs inside ONE READ ONLY transaction.
 *
 * OWNER-RUN ONLY on prod, from the repo root:
 *   railway run --service postgres -- npm --prefix apps/api run db:report:variant-tier-drift
 *   railway run --service postgres -- npm --prefix apps/api run db:report:variant-tier-drift -- --tenant=<slug>
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { getTierPrice, roundMoney } from "@routeflow/pricing";

type PriceValue = { toString(): string } | string | number | null | undefined;

export interface DriftProduct {
  id: string;
  tenantId: string | null;
  parentProductId: string | null;
  isActive: boolean;
  unitsPerBox: number | null;
  pricePerUnit: PriceValue;
  priceTier2: PriceValue;
  priceTier3: PriceValue;
  priceTier4: PriceValue;
  priceTier5: PriceValue;
}

export interface DriftCustomerPrice {
  tenantId: string | null;
  customerId: string;
  productId: string;
  pricingTier: number | null;
}

export interface VariantTierDriftCounts {
  variantsWithTierDiff: number;
  familiesWithTierDiff: number;
  variantsWithPackSizeDiff: number;
  inactiveVariantsWithTierDiff: number;
  customersWithCustomerPriceTierDiff: number;
}

const effectiveLadder = (p: DriftProduct): number[] =>
  [1, 2, 3, 4, 5].map((tier) => roundMoney(getTierPrice(p, tier)));

const sameLadder = (a: DriftProduct, b: DriftProduct): boolean => {
  const left = effectiveLadder(a);
  const right = effectiveLadder(b);
  return left.every((value, i) => value === right[i]);
};

/** PURE — no I/O. A variant is compared only with a family of its OWN tenant. */
export function countVariantTierDrift(
  products: DriftProduct[],
  customerPrices: DriftCustomerPrice[] = [],
): VariantTierDriftCounts {
  const byId = new Map(products.map((p) => [p.id, p]));
  let variantsWithTierDiff = 0;
  let variantsWithPackSizeDiff = 0;
  let inactiveVariantsWithTierDiff = 0;
  const familiesWithDiff = new Set<string>();
  /** variant id -> family id, for the CustomerPrice count (same-tenant families only). */
  const familyOfVariant = new Map<string, string>();

  for (const variant of products) {
    if (!variant.parentProductId) continue;
    const family = byId.get(variant.parentProductId);
    if (!family || family.parentProductId || family.tenantId !== variant.tenantId) continue;
    familyOfVariant.set(variant.id, family.id);
    if ((variant.unitsPerBox ?? null) !== (family.unitsPerBox ?? null))
      variantsWithPackSizeDiff += 1;
    if (!sameLadder(variant, family)) {
      variantsWithTierDiff += 1;
      familiesWithDiff.add(family.id);
      if (!variant.isActive) inactiveVariantsWithTierDiff += 1;
    }
  }

  // customer -> family -> the distinct non-null tiers its CustomerPrice rows put on that family's variants
  const tiersByCustomerFamily = new Map<string, Set<number>>();
  for (const row of customerPrices) {
    const familyId = familyOfVariant.get(row.productId);
    if (!familyId || row.pricingTier == null) continue;
    const key = `${row.tenantId ?? ""}\u0000${row.customerId}\u0000${familyId}`;
    const set = tiersByCustomerFamily.get(key) ?? new Set<number>();
    set.add(row.pricingTier);
    tiersByCustomerFamily.set(key, set);
  }
  const differing = new Set<string>();
  for (const [key, tiers] of tiersByCustomerFamily) {
    if (tiers.size > 1) differing.add(key.split("\u0000").slice(0, 2).join("\u0000"));
  }

  return {
    variantsWithTierDiff,
    familiesWithTierDiff: familiesWithDiff.size,
    variantsWithPackSizeDiff,
    inactiveVariantsWithTierDiff,
    customersWithCustomerPriceTierDiff: differing.size,
  };
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
    "Missing env: DATABASE_URL. Set it, or run via: railway run --service postgres -- npm --prefix apps/api run db:report:variant-tier-drift",
  );
}

function parseArgs(argv: string[]): { tenantSlug?: string } {
  const hit = argv.find((a) => a.startsWith("--tenant="));
  return { tenantSlug: hit ? hit.slice("--tenant=".length) : undefined };
}

/**
 * Every read runs inside ONE `prisma.$transaction` whose first statement is `SET TRANSACTION READ
 * ONLY` (a Postgres-level guarantee this report can never write). The tenant-not-found refusal is
 * generic: stderr never echoes a tenant slug, name or id (R-030a).
 */
export async function loadCounts(
  prisma: PrismaClient,
  tenantSlug?: string,
): Promise<VariantTierDriftCounts> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;

    let tenantId: string | undefined;
    if (tenantSlug) {
      const tenant = await tx.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true },
      });
      if (!tenant) throw new Error("tenant not found (check --tenant)");
      tenantId = tenant.id;
    }
    const where = tenantId ? { tenantId } : {};

    const products = await tx.product.findMany({
      where,
      select: {
        id: true,
        tenantId: true,
        parentProductId: true,
        isActive: true,
        unitsPerBox: true,
        pricePerUnit: true,
        priceTier2: true,
        priceTier3: true,
        priceTier4: true,
        priceTier5: true,
      },
    });
    const customerPrices = await tx.customerPrice.findMany({
      where,
      select: { tenantId: true, customerId: true, productId: true, pricingTier: true },
    });
    return countVariantTierDrift(products, customerPrices);
  });
}

async function main() {
  const dbUrl = resolveDbUrl();
  console.error(`report-variant-tier-drift target: ${maskDbUrl(dbUrl)}`);

  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const { tenantSlug } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await loadCounts(prisma, tenantSlug)));
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * main()'s catch must never print a raw error object/message (it can carry a tenant slug, product
 * name or price) — only the error's name and, when present, its `code`.
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
