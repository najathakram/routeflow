/**
 * Draft/final stage for an invoice PDF. Hand-mirrored from
 * `apps/api/src/invoices/invoice-pdf-variant.ts` and
 * `apps/web/lib/api/invoices.ts#deriveInvoiceVariant` — keep the three in sync
 * (pricing.ts-style triple mirror). No RN import so it stays pure + Jest-testable.
 */

import { isPostDeliveryOrderStatus } from "@routeflow/types/api/enums";

/** DRAFT = pre-delivery proforma; FINAL = issued invoice. */
export type InvoicePdfVariant = "draft" | "final";

/**
 * Default stage when the operator hasn't forced one: FINAL once the invoice is
 * issued (status beyond DRAFT) or its order is delivered, else DRAFT. The operator
 * can override and share/send either version at any time.
 */
export function deriveInvoiceVariant(inv: {
  status: string;
  /** The server's own default stage (invoice detail): wins when present. A shipment invoice is FINAL
   *  before delivery, and only the server knows the tenant's fulfilment mode (F3). */
  pdfVariant?: InvoicePdfVariant | null;
  order?: { status?: string | null } | null;
}): InvoicePdfVariant {
  if (inv.pdfVariant === "draft" || inv.pdfVariant === "final") return inv.pdfVariant;
  if (inv.status !== "DRAFT") return "final";
  // SA-1101: REFUSED is post-delivery too (the $0 draft is final).
  if (isPostDeliveryOrderStatus(inv.order?.status)) return "final";
  return "draft";
}
