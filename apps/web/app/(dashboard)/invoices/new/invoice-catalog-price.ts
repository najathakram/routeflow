import { getTierPrice, isSpecialTier, type CustomerLinePrice } from "@routeflow/pricing";
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
    /**
     * S19b (SA-811a): `customerLinePrice` for this product's PACK, when the flag-on customer layer has a row for it.
     * Only a `layered` result changes anything; omitted or unlayered = master's numbers exactly.
     */
    layerLine?: CustomerLinePrice;
  },
) {
  const layered = o.layerLine?.layered ? o.layerLine : undefined;
  if (layered) {
    // The layer's price IS the line's price (R3); above-list is MANUAL with no promo (R2).
    const listPrice = layered.listPrice;
    return {
      listPrice,
      effectivePrice: layered.price,
      isSpecial: layered.price !== listPrice,
      priceType: layered.priceType,
      pricing: {
        tierPrice: layered.price,
        listPrice,
        isSpecialTier: layered.isSpecial,
      },
      tierPrices: {
        pricePerUnit: product.pricePerUnit,
        priceTier2: product.priceTier2,
        priceTier3: product.priceTier3,
        priceTier4: product.priceTier4,
        priceTier5: product.priceTier5,
      },
    };
  }
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
    priceType: (effectivePrice !== listPrice
      ? "SPECIAL"
      : "STANDARD") as CustomerLinePrice["priceType"],
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
