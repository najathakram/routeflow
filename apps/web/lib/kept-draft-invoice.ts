/**
 * Row 466 ("the record lies"): create-and-send commits the draft first, then sends. When the send
 * step fails the API still answers with an error, but its body carries the committed draft's
 * `invoiceId` (for the sale path, `orderId` too). A client that reads that id opens the kept draft
 * instead of showing a plain failure, so a retry can never create a duplicate.
 *
 * Reads the id from ANY error body, not only EMAIL_SEND_FAILED. It never reads the server's message.
 */
export function keptDraftInvoiceId(err: unknown): string | null {
  const data = (err as { response?: { data?: { invoiceId?: unknown; code?: unknown } } } | null)
    ?.response?.data;
  // A request-validation refusal happens BEFORE anything is committed, so an `invoiceId` riding on one is not a
  // kept draft (row 448's control: only a failure AFTER the draft was created names it).
  if (data?.code === "VALIDATION_FAILED") return null;
  const id = data?.invoiceId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Fixed copy (B980): the invoice exists, it just was not sent. */
export const KEPT_DRAFT_TOAST = {
  title: "Saved as a draft, not sent",
  description: "The invoice was saved but could not be sent. Open it to send it.",
} as const;

/**
 * createSale commits the ORDER, then builds its invoice. When the invoice step fails the body carries
 * `orderId` (and `invoiceId` too if the invoice was created and only its send failed). The page opens
 * the invoice when there is one (keptDraftInvoiceId), else this order, never a second sale.
 */
export function keptOrderId(err: unknown): string | null {
  const id = (err as { response?: { data?: { orderId?: unknown } } } | null)?.response?.data
    ?.orderId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Where to send the clerk when a sale call (POST /orders/sell or /orders/counter-sale) failed AFTER it
 * committed: the invoice when the body carries one, else the order. Null when nothing was committed.
 */
export function keptSaleHref(err: unknown): string | null {
  const invoiceId = keptDraftInvoiceId(err);
  if (invoiceId) return `/invoices/${invoiceId}`;
  const orderId = keptOrderId(err);
  return orderId ? `/orders/${orderId}` : null;
}
