import { pricesUnconfirmed } from "@/components/PriceLayerNotice";
import type { CustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";

type ReadState = { isLoading?: boolean; isError?: boolean; data?: unknown };

/**
 * SA-868 (W-693): money fails CLOSED. A staff form that pre-fills a customer's price may suggest one only once the
 * customer, their customer-product prices and (flag on) the price layer are read. A read still in flight = `pending`; a
 * read that FAILED with no data = `failed` (else `customerTierFor(undefined, …)` would price the pick at LIST).
 *  - `blockPick`: no product may be picked (a pick would pre-fill a price) while pending or failed.
 *  - `blockSave`: Save waits while pending, and on an unconfirmed layer (SA-813 M3, `pricesUnconfirmed`). A failed
 *    customer / customer-price read does NOT block Save: with picking closed no suggestion can get in, and every price
 *    on the form is the operator's own or the stored template's.
 */
export function customerPricingGate(i: {
  customerQuery: ReadState;
  customerPricesQuery: ReadState;
  priceLayer: Pick<CustomerPriceLayer, "enabled" | "ready" | "failed" | "lineReady">;
  productIds?: ReadonlyArray<string | null | undefined>;
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
    blockSave: pending || pricesUnconfirmed(i.priceLayer, i.productIds ?? []),
  };
}
