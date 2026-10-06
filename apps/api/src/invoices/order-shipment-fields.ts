/**
 * The carrier shipment an invoice created from an order inherits (carrier, tracking number, ship date),
 * so the PDF and the Shipments page show it. ONE helper for both from-order creators
 * (`createInvoiceFromOrder`, `createInvoiceFromOrderWithTenant`); an order with no carrier and no tracking
 * contributes no keys, leaving the create payload exactly as it was.
 */
export function orderShipmentFields(order: {
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: Date | null;
}): {
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: Date | null;
} {
  if (!order.shippingCarrier && !order.shippingTrackingNumber) return {};
  return {
    shippingCarrier: order.shippingCarrier ?? null,
    shippingTrackingNumber: order.shippingTrackingNumber ?? null,
    shippedAt: order.shippedAt ?? null,
  };
}
