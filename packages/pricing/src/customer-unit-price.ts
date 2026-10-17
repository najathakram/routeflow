import {
  buildLadderView,
  DEFAULT_TIER_RULES,
  ladderPrice,
  canonicalUnitRef,
  refForLabel,
  type LadderViewOptions,
  type LadderViewUnit,
  type PriceTier,
  type TierRules,
  type UnitRef,
} from "./price-ladder";
import { customerAnchor, customerPrice, type CustomerPricing } from "./price-anchor";
import { isSpecialTier, roundMoney } from "./pricing";
import { explicitPrice, type LadderProduct } from "./unit-levels";

// Units and prices, pricing core C: the ONE resolver for what a customer pays per unit (P4c, fold A1). It replaces the
// `pricingTier ??` copies in the readers (S19 wires them) and also covers the driver path.

/**
 * The tier a customer pays at for a product: the customer-product tier, else the customer's own tier, else 1. Anything that
 * is not an integer 1 to 5 is skipped.
 */
export function customerTierFor(customerProductTier: unknown, customerTier: unknown): PriceTier {
  for (const raw of [customerProductTier, customerTier]) {
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 5) return n as PriceTier;
  }
  return 1;
}

export interface CustomerUnitPriceInput {
  product: LadderProduct;
  units: readonly LadderViewUnit[];
  viewOptions?: LadderViewOptions;
  customer: {
    /** Already resolved with {@link customerTierFor}. */
    tier: PriceTier;
    /** This customer's own order unit for the product (from resolveUnitDefault's customer scope). */
    orderUnit?: UnitRef | null;
    /** The customer's typed prices by unit ref (the CustomerUnitPrice table). */
    unitPrices?: Readonly<Record<UnitRef, number>>;
  };
  /** A unit ref or a unit label. */
  unit: string;
  rules?: TierRules;
}

export interface ResolvedCustomerUnitPrice {
  unit: UnitRef;
  label: string;
  price: number;
  /** customer: typed for this unit. customer-shape: worked out from their typed price on their order unit. tier / list: no customer price. */
  source: "customer" | "customer-shape" | "tier" | "list";
}

/** The price one customer pays for one unit of a product, in dollars (`roundMoney`, never cents). Throws for a unit the product does not have. */
export function resolveCustomerUnitPrice(input: CustomerUnitPriceInput): ResolvedCustomerUnitPrice {
  const { product, units, customer } = input;
  const rules = input.rules ?? DEFAULT_TIER_RULES;
  const view = buildLadderView(product, units, input.viewOptions);
  const asRef = canonicalUnitRef(units, input.unit);
  const ref = view.rows.some((r) => r.ref === asRef)
    ? asRef
    : refForLabel(product, units, input.unit);
  const pricing: CustomerPricing = {
    tier: customer.tier,
    orderUnit: customer.orderUnit,
    set: customer.unitPrices,
  };
  const price = customerPrice(view, ref, pricing, rules);
  const typed = (r: UnitRef) => explicitPrice(customer.unitPrices?.[r]) != null;
  const source: ResolvedCustomerUnitPrice["source"] = typed(ref)
    ? "customer"
    : typed(customerAnchor(view, pricing))
      ? "customer-shape"
      : customer.tier > 1
        ? "tier"
        : "list";
  return { unit: ref, label: view.rows.find((r) => r.ref === ref)!.label, price, source };
}

/**
 * S19 (SA-811a R1/R2): what billing takes from the CUSTOMER LAYER of the ladder (customer > tier > product). It is the
 * resolver's answer only when the unit is in that layer (source `customer`, or `customer-shape`: worked out from their typed
 * price on their order unit), else null and the caller keeps its tier / list / sticky chain untouched. A customer-layer price
 * ABOVE the unit's Retail ladder price (tier 1, no customer) is priced like the sticky upsell: MANUAL, no promotion.
 */
export interface CustomerLayerPrice {
  unit: UnitRef;
  /** Dollars, rounded once. */
  price: number;
  /** The unit's Retail ladder price: tier 1, no customer. The strikethrough / `originalPrice` base. */
  listPrice: number;
  source: "customer" | "customer-shape";
  /** `price` is above `listPrice`: a deliberate above-market price, never auto-discounted (master's sticky rule). */
  aboveList: boolean;
}

export function customerLayerPrice(input: CustomerUnitPriceInput): CustomerLayerPrice | null {
  const r = resolveCustomerUnitPrice(input);
  if (r.source !== "customer" && r.source !== "customer-shape") return null;
  const view = buildLadderView(input.product, input.units, input.viewOptions);
  const listPrice = ladderPrice(view, r.unit, 1, input.rules ?? DEFAULT_TIER_RULES);
  return {
    unit: r.unit,
    price: r.price,
    listPrice,
    source: r.source,
    aboveList: r.price > listPrice,
  };
}

/**
 * Is a line priced SPECIAL (against list) rather than STANDARD: the customer's tier is not Retail, or their customer-layer
 * price differs from the unit's list price by a cent.
 */
export function isSpecialPrice(
  tier: number,
  listPrice: number,
  layerPrice: number | null | undefined,
): boolean {
  return (
    isSpecialTier(tier) || (layerPrice != null && roundMoney(layerPrice) !== roundMoney(listPrice))
  );
}
