import * as React from "react";
import type { CustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";

/** SA-813 M3 copy: shown while a flag-on customer price layer is unconfirmed. */
export const PRICE_LAYER_PENDING_COPY = "Checking this customer's prices\u2026";
export const PRICE_LAYER_FAILED_COPY = "Couldn't load this customer's prices.";
export const PRICE_LAYER_TOO_MANY_COPY = "This customer has too many prices to load here.";

// W-725: the rule lives in @routeflow/pricing (shared with mobile); re-exported for the web call sites.
export { pricesUnconfirmed } from "@routeflow/pricing";

export function PriceLayerNotice({
  layer,
  unconfirmed,
  className,
}: {
  layer: Pick<CustomerPriceLayer, "enabled" | "ready" | "pending" | "failed" | "refetch">;
  unconfirmed: boolean;
  className?: string;
}) {
  if (!layer.enabled || !unconfirmed) return null;
  if (layer.failed) {
    return (
      <span role="alert" className={className}>
        {PRICE_LAYER_FAILED_COPY}{" "}
        <button type="button" className="font-medium underline" onClick={() => layer.refetch()}>
          Retry
        </button>
      </span>
    );
  }
  return (
    <span role="status" className={className}>
      {layer.ready ? PRICE_LAYER_TOO_MANY_COPY : PRICE_LAYER_PENDING_COPY}
    </span>
  );
}
