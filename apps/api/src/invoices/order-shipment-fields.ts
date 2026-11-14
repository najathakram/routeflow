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

/**
 * `updateInvoiceShipment`'s write (W-904, SA-1142 R4). SET stamps `shippedAt` fill-only: the update leaves the key out
 * and a conditional `updateMany` (only while still unstamped) lets the database judge "still unstamped", so a mirror that filled
 * it between the caller's read and this write survives. CLEAR (no tracking) clears the date, by design.
 */
export async function writeInvoiceTracking(
  db: {
    invoice: {
      update(args: any): Promise<any>;
      updateMany(args: any): Promise<any>;
      findFirst(args: any): Promise<any>;
    };
  },
  id: string,
  carrier: string | null,
  tracking: string | null,
) {
  const clear = tracking ? {} : { shippedAt: null }; // the only unconditional write of the date
  const updated = await db.invoice.update({
    where: { id },
    data: { shippingCarrier: carrier, shippingTrackingNumber: tracking, ...clear },
  });
  if (!tracking) return updated;
  // Fill only while this save's tracking is still the stored one: a clear that raced in keeps its null date.
  await db.invoice.updateMany({
    where: { id, shippedAt: null, shippingTrackingNumber: tracking },
    data: { shippedAt: new Date() },
  });
  return (await db.invoice.findFirst({ where: { id } })) ?? updated;
}
