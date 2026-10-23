import { useEffect, useState } from "react";
import { customerPricingGate, type PricingReadState } from "@routeflow/pricing";
import { shownPrice } from "../../lib/price-layer-gate";
import {
  PICK_PENDING_NOTICE_DELAY_MS,
  customerPickNotice,
  customerPickRefusal,
  retryCustomerPricing,
} from "../../lib/customer-pick-gate";

type Read = PricingReadState & { refetch: () => unknown };

/**
 * W-741: the builder screens' pick gate (NewOrderScreen, invoices/new). `refusal` is checked at the screen's add choke point;
 * `notice` renders under the builder with Retry. The pending notice turns on only after PICK_PENDING_NOTICE_DELAY_MS.
 */
export function useCustomerPickGate(
  customerId: string | null | undefined,
  customerQuery: Read,
  customerPricesQuery: Read,
  priceLayer: Parameters<typeof customerPricingGate>[0]["priceLayer"] & { refetch: () => unknown },
) {
  const gate = customerPricingGate({ customerQuery, customerPricesQuery, priceLayer });
  const waiting = !!customerId && gate.pending;
  const [pendingShown, setPendingShown] = useState(false);
  useEffect(() => {
    if (!waiting) return setPendingShown(false);
    const t = setTimeout(() => setPendingShown(true), PICK_PENDING_NOTICE_DELAY_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  return {
    gate,
    /** SA-882: the price to SHOW for a product not yet added: null ("…") while the gate blocks the pick. */
    shown: (productId: string, clp: { price: number }) =>
      shownPrice(gate, customerId, priceLayer, productId, clp),
    refusal: customerPickRefusal(gate, customerId),
    notice: customerPickNotice(gate, customerId, pendingShown),
    retry: () =>
      retryCustomerPricing(gate, {
        refetchCustomer: customerQuery.refetch,
        refetchPrices: customerPricesQuery.refetch,
        refetchLayer: priceLayer.refetch,
      }),
  };
}
