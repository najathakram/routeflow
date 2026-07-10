/**
 * Draft/final stage for an invoice PDF. Kept in its own file (no `@react-pdf`
 * import) so it stays trivially unit-testable.
 */

/** DRAFT = pre-delivery proforma the wholesaler prints/sends; FINAL = issued invoice. */
export type InvoicePdfVariant = "draft" | "final";

/**
 * Default stage when the caller doesn't force one: FINAL once the invoice is
 * issued (status beyond DRAFT) or its order has been delivered; DRAFT while it
 * is still the pre-delivery mirror. The wholesaler can always override this and
 * generate/send either version at any time.
 */
export function deriveInvoiceVariant(inv: {
  status: string;
  order?: { status: string } | null;
}): InvoicePdfVariant {
  if (inv.status !== "DRAFT") return "final";
  if (inv.order?.status === "DELIVERED") return "final";
  return "draft";
}
