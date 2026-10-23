import type { customerPricingGate } from "@routeflow/pricing";
import {
  LAYER_FAILED_MESSAGE,
  LAYER_PENDING_MESSAGE,
  type PriceLayerGate,
} from "./price-layer-gate";

// W-741 (W-725 follow-up, SA-868): a builder's product pick fails CLOSED on the shared `customerPricingGate`. While the
// customer, their customer-product prices or (flag on) the price layer are unread, `customerTierFor(undefined, …)` would
// price the pick at tier 1 (LIST), so the pick is refused with the pending or failed copy, and a failed read offers Retry.

type CustomerPricingGate = ReturnType<typeof customerPricingGate>;

/** The pending notice waits this long, so a normal (fast) read never flashes it or slows a pick. */
export const PICK_PENDING_NOTICE_DELAY_MS = 400;

/** The message a refused pick shows, or null when the pick may go ahead. No customer chosen = nothing to gate. */
export function customerPickRefusal(
  gate: CustomerPricingGate,
  customerId: string | null | undefined,
): string | null {
  if (!customerId || !gate.blockPick) return null;
  return gate.failed ? LAYER_FAILED_MESSAGE : LAYER_PENDING_MESSAGE;
}

/** The notice under the builder: failed = at once with Retry; pending = only once `pendingShown` (after the delay). */
export function customerPickNotice(
  gate: CustomerPricingGate,
  customerId: string | null | undefined,
  pendingShown: boolean,
): PriceLayerGate {
  if (!customerId || !gate.blockPick) return { blocked: false, message: null, canRetry: false };
  if (gate.failed) return { blocked: true, message: LAYER_FAILED_MESSAGE, canRetry: true };
  return { blocked: true, message: pendingShown ? LAYER_PENDING_MESSAGE : null, canRetry: false };
}

/** Retry: a failed customer / customer-price read refetches both; otherwise the failure is the layer's. */
export function retryCustomerPricing(
  gate: CustomerPricingGate,
  deps: {
    refetchCustomer: () => unknown;
    refetchPrices: () => unknown;
    refetchLayer: () => unknown;
  },
): void {
  if (gate.readFailed) {
    void deps.refetchCustomer();
    void deps.refetchPrices();
  } else void deps.refetchLayer();
}

/** SA-883: a catalog line with no operator-typed price carries a suggested (tier-resolved) price. */
export function hasOpenSuggestion(items: Record<string, { unitPrice?: number | null }>): boolean {
  return Object.values(items).some((line) => line.unitPrice == null);
}

/** SA-883: Create/Save waits on the gate's blockSave once a customer is chosen (a walk-in sale has no customer reads). */
export function builderSaveBlocked(
  gate: CustomerPricingGate,
  customerId: string | null | undefined,
): boolean {
  return !!customerId && gate.blockSave;
}

/**
 * #3665: ONE save gate for the footer, the cart sheet and onSave: the layer gate, widened by the customer gate's blockSave
 * (`gate` computed with the line ids and open suggestions). The layer's own block keeps its message; otherwise the pending
 * or failed copy, with Retry on a failure. Nothing blocks: the layer gate unchanged.
 */
export function builderSaveGate(
  gate: CustomerPricingGate,
  customerId: string | null | undefined,
  layerGate: PriceLayerGate,
): PriceLayerGate {
  if (layerGate.blocked || !builderSaveBlocked(gate, customerId)) return layerGate;
  return gate.failed
    ? { blocked: true, message: LAYER_FAILED_MESSAGE, canRetry: true }
    : { blocked: true, message: LAYER_PENDING_MESSAGE, canRetry: false };
}
