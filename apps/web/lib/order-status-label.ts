/**
 * Display label for an order status on the STAFF surfaces. An account in SHIP fulfilment mode
 * (`fulfilment_model` = "ship", see `useShipMode`) ships by carrier, so "Out for Delivery" reads
 * "Shipped" there. DISPLAY ONLY: the status enum, the API and the buyer portal are untouched.
 *
 * Returns `undefined` when the status keeps its normal label, so it can be passed straight to
 * `<Badge status label={...} />` (an absent label falls back to the Badge's own map) and every other
 * status, and every non-ship account, renders exactly as before.
 */
export const SHIPPED_LABEL = "Shipped";

export function orderStatusLabelOverride(status: string, ship: boolean): string | undefined {
  return ship && status === "OUT_FOR_DELIVERY" ? SHIPPED_LABEL : undefined;
}

/** Same rule for a plain-text label: the override, else the label the caller already has. */
export function orderStatusText(status: string, ship: boolean, normalLabel: string): string {
  return orderStatusLabelOverride(status, ship) ?? normalLabel;
}
