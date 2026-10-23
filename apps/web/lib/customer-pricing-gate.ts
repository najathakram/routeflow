import { pricesUnconfirmed } from "@/components/PriceLayerNotice";
import type { CustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";

type ReadState = {
  isPending?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  data?: unknown;
  error?: unknown;
};

/** The HTTP status of a failed read: axios (`response.status`) or a fetch-style `status`; else undefined. */
function httpStatus(error: unknown): number | undefined {
  const e = error as { response?: { status?: unknown }; status?: unknown } | null | undefined;
  const status = e?.response?.status ?? e?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * SA-868 (W-693): money fails CLOSED. A staff form that pre-fills a customer's price may suggest one only once the
 * customer, their customer-product prices and (flag on) the price layer are read. A read still in flight = `pending`; a
 * read that FAILED with no data = `failed` (else `customerTierFor(undefined, …)` would price the pick at LIST).
 *  - `blockPick`: no product may be picked (a pick would pre-fill a price) while pending or failed.
 *  - `blockSave`: Save waits while pending, on an unconfirmed layer (SA-813 M3, `pricesUnconfirmed`), and (SA-870) while a
 *    read has failed AND a line still carries an open suggestion (`openSuggestions`: a product picked here whose price the
 *    operator has not typed), so a price suggested for one customer is never saved into another's template. Typing a
 *    price, removing the line or a successful Retry releases it. Typed and stored prices never hold Save.
 */
export function customerPricingGate(i: {
  customerQuery: ReadState;
  customerPricesQuery: ReadState;
  priceLayer: Pick<CustomerPriceLayer, "enabled" | "ready" | "failed" | "lineReady">;
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
  const failedRead = (q: ReadState) => !!q.isError && q.data == null;
  // Waiting = no data yet and no error. TanStack v5 `isPending` (a query paused offline is pending but not loading); a
  // caller without it falls back to `isLoading`. Fails closed: a paused read blocks the pick like a loading one.
  const waiting = (q: ReadState) => !q.isError && q.data == null && !!(q.isPending ?? q.isLoading);
  // SA-883 #3: a plan without flag.pricing_tiers gets 403 (PLAN_GATE) on GET /customers/:id/prices. That tenant has no
  // customer-product price rows to honour, so the read is SETTLED EMPTY (neither failed nor waiting) and the pick is
  // priced by the customer's own tier. ONLY this read and ONLY a 403: a 5xx, 404 or network error still fails closed,
  // and so does any error on the customer read.
  const pricesPlanGated =
    !!i.customerPricesQuery.isError &&
    i.customerPricesQuery.data == null &&
    httpStatus(i.customerPricesQuery.error) === 403;
  const readFailed =
    failedRead(i.customerQuery) || (failedRead(i.customerPricesQuery) && !pricesPlanGated);
  const pending =
    waiting(i.customerQuery) ||
    waiting(i.customerPricesQuery) ||
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
