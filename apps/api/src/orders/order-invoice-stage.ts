/**
 * Stamps each invoice on an order read with the server's default PDF stage (`pdfVariant`), the same
 * `resolveInvoiceVariant` the invoice detail and PDF use. The web reads it to confirm "Unmark shipped"
 * when the order's invoice is FINAL; no client derives a stage.
 */
import type { FulfillPath, InvoiceStatus, OrderStatus } from "@prisma/client";
import { resolveInvoiceVariant } from "../invoices/invoice-stage";

type StageInvoice = { status: InvoiceStatus; deliveryBatchId?: string | null; pdfVariant?: string };

export async function attachInvoiceStages(
  featureConfig: Parameters<typeof resolveInvoiceVariant>[0],
  order: {
    id: string;
    tenantId?: string | null;
    status: OrderStatus;
    fulfillPath: FulfillPath;
    shippedAt?: Date | null;
    invoices?: StageInvoice[] | null;
  },
): Promise<void> {
  for (const inv of order.invoices ?? []) {
    inv.pdfVariant = await resolveInvoiceVariant(
      featureConfig,
      order.tenantId,
      { orderId: order.id, status: inv.status, deliveryBatchId: inv.deliveryBatchId ?? null },
      order,
    );
  }
}
