/**
 * The date + shipment parts of the orders list `where` (kept out of orders.service.ts, which sits at its
 * size-ratchet cap): the requested-delivery window, plus the carrier-shipment filters the dashboard's
 * shipping cards use for EXACT server counts (`shippedFrom`, `hasTracking`).
 */
export function dateAndShipmentFilters(q: {
  deliveryDateFrom?: string;
  deliveryDateTo?: string;
  shippedFrom?: string;
  hasTracking?: boolean;
}): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (q.deliveryDateFrom || q.deliveryDateTo) {
    where.requestedDeliveryDate = {
      ...(q.deliveryDateFrom ? { gte: new Date(q.deliveryDateFrom) } : {}),
      ...(q.deliveryDateTo ? { lte: new Date(q.deliveryDateTo) } : {}),
    };
  }
  if (q.shippedFrom) where.shippedAt = { gte: new Date(q.shippedFrom) };
  // A tracking number is "set" when non-null and non-empty (updateShipment trims it to null when blank).
  if (q.hasTracking === true) where.shippingTrackingNumber = { not: null };
  if (q.hasTracking === false) where.shippingTrackingNumber = null;
  return where;
}
