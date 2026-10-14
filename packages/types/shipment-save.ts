// Pure shipment-form rules shared by web `ShipmentCard` and the mobile edit modal (M8). No imports, so the
// mobile Jest stub of the package root can map this subpath to SOURCE.

/** The stored carrier shipment on an order or invoice, as far as a save decision needs it. */
export interface StoredShipment {
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
}

/**
 * What saving the Shipment form does (M8), ONE rule for web `ShipmentCard` and the mobile edit modal so they
 * cannot drift. The tracking number decides whether a shipment exists: a number saves it (with the carrier
 * chosen); no number (a carrier alone included) clears a stored shipment, and changes nothing when none is
 * stored, so the caller makes no request and shows no toast. `payload` is the exact PATCH body, or null.
 */
export function shipmentSaveDecision(
  stored: StoredShipment,
  carrier: string,
  trackingNumber: string,
): {
  outcome: "saved" | "cleared" | "nothing";
  payload: { shippingCarrier: string; shippingTrackingNumber: string } | null;
} {
  const tracking = trackingNumber.trim();
  if (tracking) {
    return {
      outcome: "saved",
      payload: { shippingCarrier: carrier.trim(), shippingTrackingNumber: tracking },
    };
  }
  const hadStored = !!(stored.shippingCarrier?.trim() || stored.shippingTrackingNumber?.trim());
  return hadStored
    ? { outcome: "cleared", payload: { shippingCarrier: "", shippingTrackingNumber: "" } }
    : { outcome: "nothing", payload: null };
}

/**
 * The line under saved tracking on a SHIP order that has not shipped. Saving tracking never ships the order.
 * The "customer is told" clause is only true while the order-shipped notification is on for the account.
 */
export const notShippedNote = (customerNotified?: boolean): string =>
  customerNotified
    ? "Not shipped yet. The customer is told when you mark the order shipped."
    : "Not shipped yet.";
