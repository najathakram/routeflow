import type { PriceLayerStatus } from "./customer-line-price";

/** A TanStack query's read state, structurally (v5 `isPending`; older callers pass only `isLoading`). */
export type PricingReadState = {
  isPending?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  data?: unknown;
  /** The read's error (axios shape): SA-884 reads a PLAN_GATE 403 on the customer-price read as an empty read. */
  error?: unknown;
};

/**
 * SA-884: a plan-gated denial (`@RequirePlanFlag`): HTTP 403 whose body code is exactly "PLAN_GATE". A role 403, a
 * PLAN_GATE_UNAVAILABLE (retryable), 5xx, 404 and a network error (no response) are not.
 */
export function isPlanGateError(error: unknown): boolean {
  const res = (error as { response?: { status?: unknown; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 403 && res.data?.code === "PLAN_GATE";
}

/**
 * SA-883/884: GET /customers/:id/prices is plan-gated (`@RequirePlanFlag("flag.pricing_tiers")`). A tenant whose plan lacks the
 * flag (every LITE plan) gets the PLAN_GATE 403: an EMPTY read (no customer-product overrides; the pick prices at the
 * customer's own tier), never a failure. Applied to that one read only; anything else keeps its read state.
 */
function asPlanGatedEmpty(q: PricingReadState): PricingReadState {
  return q.isError && q.data == null && isPlanGateError(q.error)
    ? { ...q, isError: false, isPending: false, isLoading: false, data: [] }
    : q;
}

/**
 * Are the prices on these product ids unconfirmed? Flag off = never (nothing was read). Flag on and the layer pending or
 * failed = yes for the whole document; an incomplete layer = yes for each product it does not list (`lineReady`).
 * Save/Send stay disabled while this is true (SA-813 M3).
 */
export function pricesUnconfirmed(
  layer: Pick<PriceLayerStatus, "enabled" | "ready" | "lineReady">,
  productIds: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!layer.enabled) return false;
  if (!layer.ready) return true;
  return productIds.some((id) => !!id && !layer.lineReady(id));
}

/**
 * W-725 (SA-868 / SA-870 / SA-873): the ONE customer-pricing gate, shared by web and mobile. Money fails CLOSED: a staff
 * form may suggest a customer's price only once the customer, their customer-product prices and (flag on) the price layer
 * are read. A read still in flight = `pending`; a read that FAILED with no data = `failed` (else `customerTierFor(undefined,
 * …)` would price the pick at LIST).
 *  - `blockPick`: no product may be picked (a pick would pre-fill a price) while pending or failed.
 *  - `blockSave`: Save waits while pending, on an unconfirmed layer (`pricesUnconfirmed`), and (SA-870) while a read has
 *    failed AND a line still carries an open suggestion (`openSuggestions`: a product picked here whose price the operator
 *    has not typed). Typed and stored prices never hold Save.
 */
export function customerPricingGate(i: {
  customerQuery: PricingReadState;
  customerPricesQuery: PricingReadState;
  priceLayer: Pick<PriceLayerStatus, "enabled" | "ready" | "failed" | "lineReady">;
  productIds?: ReadonlyArray<string | null | undefined>;
  /** SA-870: some line carries a suggested price (picked on this form, not typed). */
  openSuggestions?: boolean;
}): {
  pending: boolean;
  failed: boolean;
  readFailed: boolean;
  blockPick: boolean;
  blockSave: boolean;
} {
  // Two meanings of "failed": a customer / customer-price read has failed only when it errored AND holds no data (stale
  // data from an earlier success still prices correctly); the price layer has failed on ANY error (SA-813 M3).
  const failedRead = (q: PricingReadState) => !!q.isError && q.data == null;
  // Waiting = no data yet and no error. TanStack v5 `isPending` (a query paused offline is pending but not loading); a
  // caller without it falls back to `isLoading`. Fails closed: a paused read blocks the pick like a loading one.
  const waiting = (q: PricingReadState) =>
    !q.isError && q.data == null && !!(q.isPending ?? q.isLoading);
  const customerPricesQuery = asPlanGatedEmpty(i.customerPricesQuery);
  const readFailed = failedRead(i.customerQuery) || failedRead(customerPricesQuery);
  const pending =
    waiting(i.customerQuery) ||
    waiting(customerPricesQuery) ||
    (i.priceLayer.enabled && !i.priceLayer.ready && !i.priceLayer.failed);
  const failed = readFailed || (i.priceLayer.enabled && i.priceLayer.failed);
  return {
    pending,
    failed,
    readFailed,
    blockPick: pending || failed,
    blockSave:
      pending ||
      pricesUnconfirmed(i.priceLayer, i.productIds ?? []) ||
      (failed && !!i.openSuggestions),
  };
}
