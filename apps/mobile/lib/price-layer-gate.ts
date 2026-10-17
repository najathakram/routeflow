import type { CustomerLinePrice, PriceLayerStatus } from "@routeflow/pricing";

// S19b slice D (SA-813 M1/M3, red row D-5): what an operator screen does while the customer's price layer is not confirmed.
// Pure, so the rule is pinned by a plain jest test. Flag off (`status.enabled` false) never blocks and never shows a marker.

export const LAYER_PENDING_MESSAGE = "Checking this customer's prices\u2026";
export const LAYER_FAILED_MESSAGE = "Couldn't load this customer's prices. Retry.";
export const LAYER_INCOMPLETE_MESSAGE = "This customer has too many prices to load here.";

export interface PriceLayerGate {
  /** Create/Save/Send stay disabled. */
  blocked: boolean;
  /** The unconfirmed marker to show instead of treating the tier price as final; null = prices are final. */
  message: string | null;
  /** The failed read: show a Retry action. */
  canRetry: boolean;
}

/** Gate a whole screen on its product ids: pending/failed block everything, an incomplete layer blocks the absent products. */
export function priceLayerGate(
  status: Pick<PriceLayerStatus, "enabled" | "ready" | "failed" | "lineReady">,
  productIds: readonly (string | null | undefined)[],
): PriceLayerGate {
  if (!status.enabled) return { blocked: false, message: null, canRetry: false };
  if (status.failed) return { blocked: true, message: LAYER_FAILED_MESSAGE, canRetry: true };
  if (!status.ready) return { blocked: true, message: LAYER_PENDING_MESSAGE, canRetry: false };
  if (productIds.some((id) => !status.lineReady(id)))
    return { blocked: true, message: LAYER_INCOMPLETE_MESSAGE, canRetry: false };
  return { blocked: false, message: null, canRetry: false };
}

/**
 * SA-811a R3: a line that came from the customer layer is the resolver's price, so the remembered last-given price is skipped
 * (the same rule `rememberedPricePrefill` applies to a SPECIAL tier). Otherwise master's pre-fill rule.
 */
export function layerAwareIsSpecial(clp: CustomerLinePrice): boolean {
  return clp.isSpecial || clp.layered;
}

/**
 * SA-813 M3: a price shown to an operator (who may read it to the customer) is final only once its line is confirmed. Returns
 * the price, or null while unconfirmed (the caller renders an ellipsis, never the tier price as if it were final). Flag off:
 * always the price.
 */
export function confirmedPrice(
  status: Pick<PriceLayerStatus, "lineReady">,
  productId: string | null | undefined,
  clp: Pick<CustomerLinePrice, "price">,
): number | null {
  return status.lineReady(productId) ? clp.price : null;
}
