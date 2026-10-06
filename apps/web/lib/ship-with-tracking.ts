/**
 * "Mark shipped" with tracking (F4): the shipment (carrier + tracking) is saved FIRST, then the ship
 * (status) call runs, so the one ORDER_SHIPPED email carries the tracking and no separate
 * tracking-added email follows. A failed save rejects before the order is shipped.
 */
export interface ShipWithTrackingValues {
  shippingCarrier: string;
  shippingTrackingNumber: string;
}

export async function shipWithTracking(
  deps: { saveShipment: (values: ShipWithTrackingValues) => Promise<unknown>; ship: () => void },
  values: ShipWithTrackingValues,
): Promise<void> {
  const tracking = values.shippingTrackingNumber.trim();
  if (tracking) {
    await deps.saveShipment({
      shippingCarrier: values.shippingCarrier,
      shippingTrackingNumber: tracking,
    });
  }
  deps.ship();
}
