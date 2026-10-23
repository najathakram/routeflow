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

/**
 * Gate a whole screen on its product ids: pending/failed block everything, an incomplete layer blocks the absent products.
 * With `nameOf`, the incomplete copy says which products could not be loaded.
 */
export function priceLayerGate(
  status: Pick<PriceLayerStatus, "enabled" | "ready" | "failed" | "lineReady">,
  productIds: readonly (string | null | undefined)[],
  nameOf?: (productId: string) => string,
): PriceLayerGate {
  if (!status.enabled) return { blocked: false, message: null, canRetry: false };
  if (status.failed) return { blocked: true, message: LAYER_FAILED_MESSAGE, canRetry: true };
  if (!status.ready) return { blocked: true, message: LAYER_PENDING_MESSAGE, canRetry: false };
  const absent = Array.from(
    new Set(productIds.filter((id): id is string => !!id && !status.lineReady(id))),
  );
  if (productIds.some((id) => !status.lineReady(id))) {
    const names = nameOf && absent.length > 0 ? absent.map(nameOf).join(", ") : null;
    return {
      blocked: true,
      message: names
        ? `${LAYER_INCOMPLETE_MESSAGE} Not loaded: ${names}.`
        : LAYER_INCOMPLETE_MESSAGE,
      canRetry: false,
    };
  }
  return { blocked: false, message: null, canRetry: false };
}

/** D-5 on a save handler: the message to alert when a CHARGE save must not go ahead, else null. A draft is never gated. */
export function guardLayerSave(gate: PriceLayerGate, asDraft: boolean): string | null {
  return !asDraft && gate.blocked ? gate.message : null;
}

/** edit-items' `pricingReady` with the layer folded in: the picker, Substitute, scan and price edits wait for it (flag off: the base). */
export function pricingReadyWithLayer(
  base: boolean,
  status: Pick<PriceLayerStatus, "enabled" | "ready">,
): boolean {
  return base && (!status.enabled || status.ready);
}

/** A unit option's price detail, or an ellipsis while the layer is unconfirmed (never a tier price shown as final). */
export function unitDetailOrUnconfirmed(detail: string, unconfirmed: boolean): string {
  return unconfirmed ? "…" : detail;
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
