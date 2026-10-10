/** "Unmark shipped" asks for a confirm when the order's (non-void) invoice is FINAL (server `pdfVariant`). */
export const UNMARK_FINAL_INVOICE_COPY =
  "This order's invoice was issued as final. Unmarking turns it back into a draft that can change. Continue?";

export function orderHasFinalInvoice(order: {
  invoices?: Array<{ status: string; pdfVariant?: string }> | null;
}): boolean {
  return (order.invoices ?? []).some((i) => i.status !== "VOID" && i.pdfVariant === "final");
}
