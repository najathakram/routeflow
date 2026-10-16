import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { effectiveBuyerPrice, getTierPrice } from "@routeflow/pricing";

/**
 * RF-198 price-race check, lifted VERBATIM out of `OrdersService.create()` (units_v1 step 4b-2b
 * prefactor: `orders.service.ts` sits at its size ratchet and create() must grow to sell by a unit;
 * behaviour identical). Throws the same 409 `Prices have been updated` with `changedItems`.
 */
export function assertBuyerCartPricesCurrent(args: {
  role: string;
  items: ReadonlyArray<{ productId?: string | null; unitPrice?: number | null }>;
  productMap: ReadonlyMap<string, any>;
  cpMap: ReadonlyMap<string, number | null>;
  defaultTier: number;
  priceHistory: Record<string, { lastPrice?: number | null } | undefined>;
  /** S19, flag.units_prices_v2 only: the pack's customer-layer price; it is their current price, above sticky history. */
  layerOf?: (productId: string) => { price: number } | null;
}): void {
  const { role, items, productMap, cpMap, defaultTier, priceHistory } = args;
  // RF-198: price-race check — buyer cart may have been built with a stale price.
  // Re-fetch (already done above) and compare against the cart unitPrice for each item.
  // Only applies when the CUSTOMER role sends unitPrice values (buyer portal checkout).
  if (role === UserRole.CUSTOMER && items.some((i) => i.unitPrice != null)) {
    const changedItems: Array<{
      productId: string;
      name: string;
      cartPrice: number;
      currentPrice: number;
    }> = [];
    for (const item of items) {
      if (item.unitPrice == null || !item.productId) continue;
      const product = productMap.get(item.productId);
      if (!product) continue; // missing product caught in lineItemsData.map below
      const tierForProduct = cpMap.get(item.productId) ?? defaultTier;
      // Compare against the customer's EFFECTIVE price (tier or sticky upsell) so
      // a legitimately-upsold cart doesn't 409 at checkout.
      const currentPrice =
        args.layerOf?.(item.productId)?.price ??
        effectiveBuyerPrice(
          Number(getTierPrice(product, tierForProduct)),
          Number(product.pricePerUnit),
          priceHistory[item.productId]?.lastPrice ?? null,
        );
      if (Math.abs(currentPrice - item.unitPrice) > 0.01) {
        changedItems.push({
          productId: item.productId,
          name: product.name,
          cartPrice: item.unitPrice,
          currentPrice,
        });
      }
    }
    if (changedItems.length > 0) {
      throw new ConflictException({
        message: "Prices have been updated. Please review your cart.",
        changedItems,
      });
    }
  }
}
