import {
  canonicalUnitRef,
  customerTierFor,
  isSpecialTier,
  refForLabel,
  roundMoney,
  type LadderProduct,
  type LadderViewUnit,
} from "@routeflow/pricing";

/**
 * Units S19 (SA-796 / SA-799): what billing reads behind `flag.units_prices_v2`, so the price the new screens show is
 * the price an order or invoice charges. Flag off, nothing here runs: every reader keeps master's own chain
 * (`cp.pricingTier ?? customer.pricingTier ?? 1`) byte for byte.
 *
 * Precedence for a line's unit price, flag on: the customer's TYPED price for that unit (CustomerUnitPrice, keyed by the
 * level ref: "pack", "base" or a ProductUnit id; SA-809) > the sticky history price > the tier price > list. The rulings are
 * silent on history; a typed price is a set price, and set prices change only when asked (P7).
 */
export const UNITS_PRICES_V2_FLAG = "flag.units_prices_v2";

/** One customer's typed prices for one product, by level ref. */
export type TypedUnitPrices = Readonly<Record<string, number>>;

export interface UnitsPricesV2 {
  /** The ONE tier resolver (customerTierFor): the customer-product tier, else the customer's own, else 1. */
  tierOf(customerProductTier: unknown, customerTier: unknown): number;
  /** The customer's typed prices for a product; undefined when they have none. */
  typedFor(productId: string | null | undefined): TypedUnitPrices | undefined;
}

export interface UnitsPricesV2Deps {
  entitlements:
    { hasFlag?: (tenantId: string, flag: string) => Promise<boolean> } | null | undefined;
  /** A tenant-scoped client or a transaction client. */
  db: { customerUnitPrice?: { findMany(args: any): Promise<any[]> } };
  tenantId: string | null | undefined;
}

/** A tier master's chain and customerTierFor could disagree on: anything that is not null or an integer 1 to 5 (PF-14). */
const isOddTier = (t: unknown): boolean => {
  if (t == null) return false;
  const n = Number(t);
  return !(Number.isInteger(n) && n >= 1 && n <= 5);
};

/**
 * The flag-on pricing context for one customer and the products an operation touches, or null (flag off, nothing that
 * could differ, or no customer). The flag is asked ONLY when it can matter: the customer has a typed row for these
 * products, or a raw tier value is junk. So a tenant with neither reads one indexed row-set and consults no entitlement,
 * and every flag-off path stays what it was.
 */
export async function loadUnitsPricesV2(
  deps: UnitsPricesV2Deps,
  customerId: string | null | undefined,
  productIds: ReadonlyArray<string | null | undefined>,
  rawTiers: ReadonlyArray<unknown> = [],
): Promise<UnitsPricesV2 | null> {
  const { tenantId, db, entitlements } = deps;
  if (!tenantId || !customerId) return null;
  const ids = [...new Set(productIds.filter((p): p is string => !!p))];
  // A client without the model (a test double) has no typed prices; production always has it.
  const model = db.customerUnitPrice;
  const found =
    ids.length > 0 && typeof model?.findMany === "function"
      ? await model.findMany({
          where: { tenantId, customerId, productId: { in: ids } },
          select: { productId: true, unitRef: true, price: true },
        })
      : [];
  const rows = Array.isArray(found) ? found : [];
  if (rows.length === 0 && !rawTiers.some(isOddTier)) return null;
  if (typeof entitlements?.hasFlag !== "function") return null;
  if (!(await entitlements.hasFlag(tenantId, UNITS_PRICES_V2_FLAG))) return null;
  const byProduct = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const price = Number(r.price);
    if (!(price > 0)) continue; // the DB CHECK refuses it too; $0 is not a price (P6)
    const own = byProduct.get(r.productId) ?? {};
    own[String(r.unitRef)] = roundMoney(price);
    byProduct.set(r.productId, own);
  }
  return {
    tierOf: (cp, customer) => customerTierFor(cp, customer),
    typedFor: (productId) => (productId ? byProduct.get(productId) : undefined),
  };
}

/** The typed price for the line's unit: no label = the pack; a label = its level ref, 1-piece row canonicalized (SA-809). */
export function typedPriceFor(
  typed: TypedUnitPrices | undefined,
  product: LadderProduct,
  units: readonly LadderViewUnit[],
  label: string | null | undefined,
): number | null {
  if (!typed) return null;
  let ref: string;
  try {
    ref = label == null ? "pack" : canonicalUnitRef(units, refForLabel(product, units, label));
  } catch {
    return null; // a unit the ladder lost has no customer price either
  }
  const price = typed[ref];
  return price != null && price > 0 ? roundMoney(price) : null;
}

/** A typed pack price is a negotiated one: SPECIAL against list, unless the customer sits at list on the retail tier. */
export const isSpecialPrice = (tier: number, listPrice: number, typed: number | null | undefined) =>
  isSpecialTier(tier) || (typed != null && roundMoney(typed) !== roundMoney(listPrice));

export interface CustomerPricing {
  /** The customer's default tier: master's `customer.pricingTier ?? 1`, or customerTierFor flag-on. */
  defaultTier: number;
  /** Per-product tier overrides: master's raw `cp.pricingTier` (null on an MSRP-only row), or the resolved tier flag-on. */
  cpMap: Map<string, number | null>;
  /** The customer's typed prices for a product by level ref; undefined flag-off or with none. */
  typedFor(productId: string | null | undefined): TypedUnitPrices | undefined;
  /** The typed PACK price (what a pack-path line bills); null flag-off or with none. */
  typedPack(productId: string | null | undefined): number | null;
}

/**
 * The tier maps every pricing reader builds from a customer and their CustomerPrice rows, plus the S19 typed prices.
 * Flag off (the common case) returns master's exact values: `defaultTier = customer.pricingTier ?? 1` and the raw
 * `cp.pricingTier` map the readers did `cpMap.get(id) ?? defaultTier` against.
 */
export async function customerPricing(
  svc: {
    prisma: { forTenant(): any; getTenantId?(): string | null | undefined };
    entitlements: UnitsPricesV2Deps["entitlements"];
  },
  customerId: string | null | undefined,
  productIds: ReadonlyArray<string | null | undefined>,
  customer: { pricingTier?: number | null } | null | undefined,
  rows: ReadonlyArray<{ productId: string; pricingTier: number | null }>,
  /** A transaction client; defaults to the tenant-scoped one. */
  db: UnitsPricesV2Deps["db"] = svc.prisma.forTenant(),
): Promise<CustomerPricing> {
  const v2 = await loadUnitsPricesV2(
    { entitlements: svc.entitlements, db, tenantId: svc.prisma.getTenantId?.() },
    customerId,
    productIds,
    [customer?.pricingTier, ...rows.map((r) => r.pricingTier)],
  );
  const typedFor = (p: string | null | undefined) => v2?.typedFor(p);
  return {
    defaultTier: v2 ? v2.tierOf(null, customer?.pricingTier) : (customer?.pricingTier ?? 1),
    cpMap: new Map(
      rows.map((r) => [
        r.productId,
        v2 ? v2.tierOf(r.pricingTier, customer?.pricingTier) : r.pricingTier,
      ]),
    ),
    typedFor,
    typedPack: (p) => typedFor(p)?.pack ?? null,
  };
}
