/**
 * Row 466 ("the record lies"): create-and-send commits the draft first, then sends. When the send
 * step fails the API still answers with an error, but its body carries the committed draft's
 * `invoiceId` (for the sale path, `orderId` too). A client that reads that id opens the kept draft
 * instead of showing a plain failure, so a retry can never create a duplicate.
 *
 * Reads the id from ANY error body, not only EMAIL_SEND_FAILED. It never reads the server's message.
 */
export function keptDraftInvoiceId(err: unknown): string | null {
  const id = (err as { response?: { data?: { invoiceId?: unknown } } } | null)?.response?.data
    ?.invoiceId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Fixed copy (B980): the invoice exists, it just was not sent. */
export const KEPT_DRAFT_TOAST = {
  title: "Saved as a draft, not sent",
  description: "The invoice was saved but could not be sent. Open it to send it.",
} as const;
