/**
 * Effective `fulfilment_model` modes under which the business ships (and so bills at shipment).
 * A leaf (no imports) so the invoicing code (`order-status-invoicing.ts`) and the Settings →
 * Fulfillment service share ONE definition without pulling the order service graph.
 */
export const SHIPPING_FULFILMENT_MODES: ReadonlySet<string> = new Set([
  "ship",
  "both",
  "pickup_ship",
]);
