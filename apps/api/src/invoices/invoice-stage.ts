/**
 * The ONE server answer to "which stage does this invoice default to" (DRAFT proforma vs FINAL).
 * The PDF service renders with it and the invoice detail puts it on the wire as `pdfVariant`, so web
 * and mobile read it instead of keying on `order.status === "DELIVERED"` (neither client can see the
 * tenant's fulfilment mode).
 *
 * The invoice raised at SHIPMENT of a carrier order is already sendable and editable (it is not a
 * pending mirror, see pending-mirror.ts) and the order was settled at shipment (`shippedAt`), so it is
 * FINAL even though the order is not delivered. Every other invoice keeps `deriveInvoiceVariant`.
 */
import { InvoiceStatus, type FulfillPath, type OrderStatus } from "@prisma/client";
import { settledAtShipment } from "../orders/order-status-invoicing";
import { deriveInvoiceVariant, type InvoicePdfVariant } from "./invoice-pdf-variant";
import { resolvePendingMirror } from "./pending-mirror";

export async function resolveInvoiceVariant(
  featureConfig: Parameters<typeof settledAtShipment>[0],
  tenantId: string | null | undefined,
  inv: {
    orderId: string | null;
    status: InvoiceStatus;
    deliveryBatchId: string | null;
  },
  order:
    { status: OrderStatus; fulfillPath: FulfillPath; shippedAt?: Date | null } | null | undefined,
): Promise<InvoicePdfVariant> {
  if (
    order &&
    inv.orderId &&
    inv.status === InvoiceStatus.DRAFT &&
    inv.deliveryBatchId == null &&
    (await settledAtShipment(featureConfig, tenantId, order)) &&
    !(await resolvePendingMirror(featureConfig, tenantId, inv, order))
  ) {
    return "final";
  }
  return deriveInvoiceVariant({ status: inv.status, order });
}
