import {
  buildLadderView,
  customerLayerPrice,
  customerTierFor,
  resolveUnitDefault,
  roundMoney,
  type CustomerLayerPrice,
  type LadderProduct,
  type LadderViewOptions,
  type LadderViewUnit,
  type PriceTier,
  type UnitRef,
} from "@routeflow/pricing";
import { asLadderProduct } from "../products/line-units";

/**
 * Units S19 (SA-796 / SA-799 / SA-811 / SA-811a): what billing reads behind `flag.units_prices_v2`, so the price the new
 * screens show is the price an order or invoice charges. Flag off, nothing here runs: every reader keeps master's own chain
 * (`cp.pricingTier ?? customer.pricingTier ?? 1`) byte for byte.
 *
 * ONE resolver: `customerLayerPrice` (@routeflow/pricing, over `resolveCustomerUnitPrice`) fed by `customerTierFor`, the
 * customer's own order unit (`CustomerPrice.orderUnitRef`, the customer scope of `resolveUnitDefault`) and their typed
 * prices (CustomerUnitPrice, keyed by the level ref "pack" | "base" | a ProductUnit id, SA-809). When the line's unit is in
 * the CUSTOMER LAYER (a typed price, or one worked out from the typed price on their order unit) that price beats the
 * sticky history, the tier and the list; otherwise the caller keeps its tier / list / sticky chain. A customer-layer price
 * above the unit's Retail ladder price is a deliberate above-market price: priced like the sticky upsell (MANUAL, no promo).
 */
export const UNITS_PRICES_V2_FLAG = "flag.units_prices_v2";

/** The product columns the ladder view reads (a Prisma row or a narrower select; missing columns read as the pack defaults). */
export type LayerProduct = {
  id: string;
  unit?: string | null;
  packLabel?: string | null;
  baseUnitLabel?: string | null;
  unitsPerBox?: unknown;
  pricePerUnit?: unknown;
  priceTier2?: unknown;
  priceTier3?: unknown;
  priceTier4?: unknown;
  priceTier5?: unknown;
  orderUnitRef?: string | null;
  packAuto?: number | null;
};

export interface UnitsPricesV2 {
  /** The ONE tier resolver (customerTierFor): the customer-product tier, else the customer's own, else 1. */
  tierOf(customerProductTier: unknown, customerTier: unknown): number;
  /** The customer-layer price of one unit of a product (`label` null = the pack), or null when the unit is not in it. */
  layer(
    product: LayerProduct,
    tier: number,
    orderUnitRef: string | null | undefined,
    label: string | null | undefined,
  ): CustomerLayerPrice | null;
}

export interface UnitsPricesV2Deps {
  entitlements:
    { hasFlag?: (tenantId: string, flag: string) => Promise<boolean> } | null | undefined;
  /** A tenant-scoped client or a transaction client. */
  db: {
    customerUnitPrice?: { findMany(args: any): Promise<any[]> };
    productUnit?: { findMany(args: any): Promise<any[]> };
    productTierUnit?: { findMany(args: any): Promise<any[]> };
  };
  tenantId: string | null | undefined;
}

/** A tier master's chain and customerTierFor could disagree on: anything that is not null or an integer 1 to 5 (PF-14). */
const isOddTier = (t: unknown): boolean => {
  if (t == null) return false;
  const n = Number(t);
  return !(Number.isInteger(n) && n >= 1 && n <= 5);
};

// Decimal / number / string columns: all stringify through their own toString.
const str = (v: unknown): string | null => (v == null ? null : String(v as string | number));

// the sanctioned Prisma-row -> ladder-product converter (the pack is never read inline: line-units-callsites ratchet)
const ladderProductOf = (p: LayerProduct): LadderProduct => asLadderProduct(p);

const ladderUnitOf = (u: any): LadderViewUnit => ({
  id: u.id,
  label: u.label,
  factorToBase: Number(u.factorToBase),
  price: str(u.price),
  priceTier2: str(u.priceTier2),
  priceTier3: str(u.priceTier3),
  priceTier4: str(u.priceTier4),
  priceTier5: str(u.priceTier5),
});

const rowsOf = async (model: { findMany(a: any): Promise<any[]> } | undefined, args: any) => {
  // A client without the model (a test double) has no rows; production always has it.
  if (typeof model?.findMany !== "function") return [];
  const out = await model.findMany(args);
  return Array.isArray(out) ? out : [];
};

/** The product-scope ladder view options: the order unit (the anchor), the per-tier anchors and the pack's Auto bits. */
export function ladderOptionsOf(
  product: Pick<LayerProduct, "orderUnitRef" | "packAuto">,
  tierOrderUnits?: LadderViewOptions["tierOrderUnits"],
): LadderViewOptions {
  return {
    orderUnit: product.orderUnitRef,
    tierOrderUnits,
    packAuto: product.packAuto,
  };
}

/** Each product's per-tier order units (ProductTierUnit, tiers 2..5), read once for a set of products. */
export async function loadTierOrderUnits(
  db: Pick<UnitsPricesV2Deps["db"], "productTierUnit">,
  tenantId: string | null | undefined,
  productIds: readonly string[],
): Promise<Map<string, NonNullable<LadderViewOptions["tierOrderUnits"]>>> {
  const out = new Map<string, NonNullable<LadderViewOptions["tierOrderUnits"]>>();
  if (productIds.length === 0) return out;
  const rows = await rowsOf(db.productTierUnit, {
    where: { tenantId: tenantId || undefined, productId: { in: [...productIds] } },
  });
  for (const t of rows) {
    if (!t.orderUnitRef || !(t.tier >= 2 && t.tier <= 5)) continue;
    const own = out.get(t.productId) ?? {};
    own[t.tier as 2 | 3 | 4 | 5] = t.orderUnitRef;
    out.set(t.productId, own);
  }
  return out;
}

/**
 * The flag-on pricing context for one customer and the products an operation touches, or null (flag off, nothing that
 * could differ, no customer, or the entitlement read failed: master's chain then). The flag is asked ONLY when it can
 * matter: the customer has a typed row for these products, or a raw tier value is junk. So a tenant with neither reads one
 * indexed row-set and consults no entitlement, and every flag-off path stays what it was.
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
  const rows =
    ids.length > 0
      ? await rowsOf(db.customerUnitPrice, {
          where: { tenantId, customerId, productId: { in: ids } },
          select: { productId: true, unitRef: true, price: true },
        })
      : [];
  if (rows.length === 0 && !rawTiers.some(isOddTier)) return null;
  if (typeof entitlements?.hasFlag !== "function") return null;
  // A failed entitlement read must not fail the order: it prices as master (the flag is dark by default).
  let on = false;
  try {
    on = !!(await entitlements.hasFlag(tenantId, UNITS_PRICES_V2_FLAG));
  } catch {
    on = false;
  }
  if (!on) return null;
  const typedBy = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const price = Number(r.price);
    if (!(price > 0)) continue; // the DB CHECK refuses it too; $0 is not a price (P6)
    const own = typedBy.get(r.productId) ?? {};
    own[String(r.unitRef)] = roundMoney(price);
    typedBy.set(r.productId, own);
  }
  // The ladder of the products with a typed price (the customer shape needs every unit), read once.
  const typedIds = [...typedBy.keys()];
  const [unitRows, tierUnitsBy] =
    typedIds.length > 0
      ? await Promise.all([
          rowsOf(db.productUnit, {
            where: { tenantId, productId: { in: typedIds } },
            orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
          }),
          loadTierOrderUnits(db, tenantId, typedIds),
        ])
      : [[], new Map<string, NonNullable<LadderViewOptions["tierOrderUnits"]>>()];
  const unitsBy = new Map<string, LadderViewUnit[]>();
  for (const u of unitRows) {
    unitsBy.set(u.productId, [...(unitsBy.get(u.productId) ?? []), ladderUnitOf(u)]);
  }
  return {
    tierOf: (cp, customer) => customerTierFor(cp, customer),
    layer: (product, tier, orderUnitRef, label) => {
      const typed = typedBy.get(product.id);
      if (!typed) return null;
      const lp = ladderProductOf(product);
      const units = unitsBy.get(product.id) ?? [];
      const viewOptions = ladderOptionsOf(product, tierUnitsBy.get(product.id));
      try {
        const own = orderUnitRef
          ? resolveUnitDefault(buildLadderView(lp, units, viewOptions), { customer: orderUnitRef })
          : null;
        return customerLayerPrice({
          product: lp,
          units,
          viewOptions,
          customer: {
            tier: tier as PriceTier,
            orderUnit: own?.scope === "customer" ? (own.orderUnit as UnitRef) : null,
            unitPrices: typed,
          },
          unit: label == null ? "pack" : label,
        });
      } catch {
        return null; // a unit the ladder lost has no customer price either
      }
    },
  };
}

export interface CustomerPricing {
  /** The customer's default tier: master's `customer.pricingTier ?? 1`, or customerTierFor flag-on. */
  defaultTier: number;
  /** Per-product tier overrides: master's raw `cp.pricingTier` (null on an MSRP-only row), or the resolved tier flag-on. */
  cpMap: Map<string, number | null>;
  /** True when the flag is on and the customer has a typed price for these products (the layer can answer). */
  layered: boolean;
  /**
   * The customer-layer price of one unit of a product (`label` null = the pack), or null: flag off, no typed price, or the
   * unit is not in the layer (a typed price on another unit only). Null leaves the caller's tier / sticky chain untouched.
   */
  layer: (
    product: LayerProduct | null | undefined,
    label?: string | null,
  ) => CustomerLayerPrice | null;
}

type PricingSvc = {
  prisma: { forTenant(): any; getTenantId?(): string | null | undefined };
  entitlements: UnitsPricesV2Deps["entitlements"];
};

/**
 * The tier maps every pricing reader builds from a customer and their CustomerPrice rows, plus the S19 customer layer.
 * Flag off (the common case) returns master's exact values: `defaultTier = customer.pricingTier ?? 1` and the raw
 * `cp.pricingTier` map the readers did `cpMap.get(id) ?? defaultTier` against.
 */
export async function customerPricing(
  svc: PricingSvc,
  customerId: string | null | undefined,
  productIds: ReadonlyArray<string | null | undefined>,
  customer: { pricingTier?: number | null } | null | undefined,
  rows: ReadonlyArray<{
    productId: string;
    pricingTier: number | null;
    /** `CustomerPrice.orderUnitRef`: this customer's own order unit for the product (the customer scope). */
    orderUnitRef?: string | null;
  }>,
  /** A transaction client; defaults to the tenant-scoped one. */
  db: UnitsPricesV2Deps["db"] = svc.prisma.forTenant(),
): Promise<CustomerPricing> {
  const v2 = await loadUnitsPricesV2(
    { entitlements: svc.entitlements, db, tenantId: svc.prisma.getTenantId?.() },
    customerId,
    productIds,
    [customer?.pricingTier, ...rows.map((r) => r.pricingTier)],
  );
  const cpMap = new Map<string, number | null>(
    rows.map((r) => [
      r.productId,
      v2 ? v2.tierOf(r.pricingTier, customer?.pricingTier) : r.pricingTier,
    ]),
  );
  const defaultTier = v2 ? v2.tierOf(null, customer?.pricingTier) : (customer?.pricingTier ?? 1);
  const ownUnit = new Map(rows.map((r) => [r.productId, r.orderUnitRef]));
  return {
    defaultTier,
    cpMap,
    layered: v2 != null,
    layer: (product, label) =>
      v2 && product
        ? v2.layer(product, cpMap.get(product.id) ?? defaultTier, ownUnit.get(product.id), label)
        : null,
  };
}

/**
 * S19 R3 (SA-811a): the customer's last-given prices without the products whose PACK is in the customer layer. A pre-fill for
 * those is the resolver's price, never the last-given one (the readers also let the layer beat the sticky price). A typed
 * price on another unit only leaves the pack's last-given in place. Flag off, or no typed price: the map as it is.
 */
export async function omitCustomerLayerHistory<T>(
  svc: PricingSvc,
  customerId: string,
  history: Record<string, T>,
): Promise<Record<string, T>> {
  const ids = Object.keys(history);
  if (ids.length === 0) return history;
  const db = svc.prisma.forTenant();
  const tenantId = svc.prisma.getTenantId?.();
  const [customer, rows] = await Promise.all([
    typeof db.customer?.findFirst === "function"
      ? db.customer.findFirst({
          where: { id: customerId, tenantId },
          select: { pricingTier: true },
        })
      : null,
    rowsOf(db.customerPrice, { where: { customerId, tenantId, productId: { in: ids } } }),
  ]);
  const pc = await customerPricing(svc, customerId, ids, customer, rows, db);
  if (!pc.layered) return history;
  const kept = { ...history };
  for (const p of await rowsOf(db.product, { where: { id: { in: ids }, tenantId } })) {
    if (pc.layer(p, null)) delete kept[p.id];
  }
  return kept;
}
