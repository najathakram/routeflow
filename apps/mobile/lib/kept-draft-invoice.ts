/**
 * Row 466 ("the record lies"): create-and-send commits the draft first, then sends. When the send
 * step fails the API still answers with an error, but its body carries the committed draft's
 * `invoiceId` (the sale path adds `orderId`). The screen reads that id from ANY error body, not only
 * EMAIL_SEND_FAILED, and opens the kept draft instead of showing a plain failure, so a retry can
 * never create a duplicate. Mirrors apps/web/lib/kept-draft-invoice.ts. Never reads the server's
 * message (owner rule: no raw server strings in the UI).
 */
export function keptDraftInvoiceId(err: unknown): string | null {
  const id = (err as { response?: { data?: { invoiceId?: unknown } } } | null)?.response?.data
    ?.invoiceId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Fixed copy: the invoice exists, it just was not sent. */
export const KEPT_DRAFT_COPY = "Saved as a draft, not sent. Open it to send.";

/**
 * createSale commits the ORDER, then builds its invoice. When the invoice step fails the body carries
 * `orderId` (and `invoiceId` too if the invoice was created and only its send failed). The composer
 * opens the invoice when there is one (keptDraftInvoiceId), else this order, never a second sale.
 */
export function keptOrderId(err: unknown): string | null {
  const id = (err as { response?: { data?: { orderId?: unknown } } } | null)?.response?.data
    ?.orderId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
