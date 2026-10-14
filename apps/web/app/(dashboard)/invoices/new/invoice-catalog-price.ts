import { getTierPrice, isSpecialTier } from "@routeflow/pricing";
import { saleLinePricing } from "@/lib/sale-line-pricing";

/**
 * The price a catalog product lands on the invoice at when it is added fresh: the customer's per-product price row
 * first, then the customer's own tier ladder, else list. ONE function, used by "add a product" and by a draft
 * restore, so a restored line is priced exactly as a fresh add would be.
 */
export function catalogPricing(
  product: any,
  o: {
    /** The customer's pricing tier (1 when there is none). */
    customerTier: number;
    /** The customer's per-product price (CustomerPrice row resolved through its tier), if any. */
    customerPrice?: number;
    /** The tier the server prices this product at for this customer. */
    lineTier: number;
  },
) {
  const listPrice = parseFloat(String(product.pricePerUnit ?? 0));
  const tierLadderPrice = isSpecialTier(o.customerTier)
    ? getTierPrice(product, o.customerTier)
    : undefined;
  const specialPrice: number | undefined = o.customerPrice ?? tierLadderPrice;
  const effectivePrice =
    specialPrice != null && Number.isFinite(specialPrice) && specialPrice !== listPrice
      ? specialPrice
      : listPrice;
  return {
    listPrice,
    effectivePrice,
    isSpecial: effectivePrice !== listPrice,
    pricing: saleLinePricing(product, o.lineTier),
    tierPrices: {
      pricePerUnit: product.pricePerUnit,
      priceTier2: product.priceTier2,
      priceTier3: product.priceTier3,
      priceTier4: product.priceTier4,
      priceTier5: product.priceTier5,
    },
  };
}
