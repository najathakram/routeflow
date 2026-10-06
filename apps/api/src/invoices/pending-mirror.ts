/**
 * The ONE server answer to "is this invoice a pending order mirror" (locked: it follows its order and
 * can be neither sent nor hand-edited). Web and mobile read the `pendingMirror` flag the invoice
 * detail puts on the wire instead of re-deriving it from the order status, because neither client can
 * see the tenant's fulfilment mode.
 *
 * An order-linked DRAFT with no delivery batch is a pending mirror until its order is delivered
 * (assertOrderInvoiceUnlocked) — EXCEPT a carrier (SHIP) order of a shipping business that has been
 * marked shipped: its invoice is raised and reconciled to the shipped quantities at shipment
 * (order-status-invoicing.ts), so it is sendable and editable from that moment. It is not auto-sent;
 * a later DELIVERED creates nothing.
 */
import { InvoiceStatus, OrderStatus, type FulfillPath } from "@prisma/client";
import { invoicesAtShipment } from "../orders/order-status-invoicing";

export async function resolvePendingMirror(
  featureConfig: Parameters<typeof invoicesAtShipment>[0],
  tenantId: string | null | undefined,
  inv: { orderId: string | null; status: InvoiceStatus; deliveryBatchId: string | null },
  order: { status: OrderStatus; fulfillPath: FulfillPath } | null | undefined,
): Promise<boolean> {
  if (!inv.orderId || inv.status !== InvoiceStatus.DRAFT || inv.deliveryBatchId != null) {
    return false;
  }
  if (!order) return false;
  if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.PARTIALLY_DELIVERED) {
    return false;
  }
  // Out with the carrier, on a shipping business: unlocked at shipment.
  return !(await invoicesAtShipment(featureConfig, tenantId, order, order.status));
}
