import { isSpecialTier, decideStaffOverride, getTierPrice } from "@routeflow/pricing";

/**
 * #2696(c) SA-558e — a New-sale line (POST /orders/sell → the server's create(), rule A) carries the
 * inputs of the ONE staff-override rule, resolved the way the server resolves them: the tier is the
 * customer's per-product CustomerPrice tier, else their default tier; special = tier ≠ 1; the
 * baseline is that tier's price.
 */
export interface SaleLinePricing {
  tierPrice: number;
  listPrice: number;
  isSpecialTier: boolean;
}

export function saleLinePricing(
  product: { pricePerUnit?: unknown } & Record<string, unknown>,
  tier: number,
): SaleLinePricing {
  return {
    tierPrice: Number(getTierPrice(product, tier)),
    listPrice: Number(product.pricePerUnit) || 0,
    isSpecialTier: isSpecialTier(tier),
  };
}

interface SaleLine {
  productId?: string;
  unitPrice: number;
  pricing?: SaleLinePricing;
  overrideReason?: string;
}

const decide = (li: SaleLine, hasReason: boolean) =>
  li.productId && li.pricing
    ? decideStaffOverride({
        overridePrice: li.unitPrice,
        baselinePrice: li.pricing.tierPrice,
        listPrice: li.pricing.listPrice,
        isSpecialTier: li.pricing.isSpecialTier,
        hasReason,
      })
    : null;

/** The line's price has moved off its special (tier) price — a Reason field is shown. */
export function saleLineMovedOffSpecial(li: SaleLine): boolean {
  const d = decide(li, true);
  return !!li.pricing?.isSpecialTier && d != null && "priceType" in d && d.priceType !== "SPECIAL";
}

/** True while the server would refuse this line: off the special price with no reason. */
export function saleLineNeedsReason(li: SaleLine): boolean {
  const d = decide(li, !!li.overrideReason?.trim());
  return d != null && "refused" in d;
}
