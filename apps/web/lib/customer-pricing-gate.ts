import { pricesUnconfirmed } from "@/components/PriceLayerNotice";
import type { CustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";

type ReadState = { isLoading?: boolean; isError?: boolean; data?: unknown };

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
  const failedRead = (q: ReadState) => !!q.isError && q.data == null;
  const readFailed = failedRead(i.customerQuery) || failedRead(i.customerPricesQuery);
  const pending =
    !!i.customerQuery.isLoading ||
    !!i.customerPricesQuery.isLoading ||
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
