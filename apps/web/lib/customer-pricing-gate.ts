// W-725: the gate lives in @routeflow/pricing, shared with mobile; this path stays for the web call sites.
import type { customerPricingGate } from "@routeflow/pricing";
import type { CustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";

export { customerPricingGate } from "@routeflow/pricing";

type NoticeLayer = Pick<CustomerPriceLayer, "enabled" | "ready" | "pending" | "failed" | "refetch">;

/**
 * W-745: what `PriceLayerNotice` shows for the whole customer-pricing gate, not just the layer. A customer / customer-price
 * read that failed with no data = the failed copy, whose Retry refetches those reads; one still in flight = the pending copy;
 * otherwise the layer itself (flag off: nothing).
 */
export function gateNoticeLayer(
  gate: ReturnType<typeof customerPricingGate>,
  priceLayer: NoticeLayer,
  refetchReads: () => void,
): NoticeLayer {
  if (gate.readFailed)
    return { enabled: true, ready: false, pending: false, failed: true, refetch: refetchReads };
  // SA-890 LOW: the layer itself is only the answer while IT is the thing being read (flag on, not ready).
  if (gate.pending && !(priceLayer.enabled && !priceLayer.ready))
    return { enabled: true, ready: false, pending: true, failed: false, refetch: refetchReads };
  return priceLayer;
}
