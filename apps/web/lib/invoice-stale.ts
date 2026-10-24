import { API_ERROR_CODES } from "@routeflow/types";

/**
 * H4: the invoice edit form sends the `updatedAt` it OPENED with as `expectedUpdatedAt`; when another save
 * landed since, PATCH /invoices/:id answers 409 INVOICE_STALE and writes nothing. Fixed copy: what happened and
 * the next step (the server's own sentence is never shown).
 */
export const INVOICE_STALE_COPY =
  "Someone else saved this invoice after you opened it, so your changes were not saved. Reload to see the latest, then re-apply your changes.";

export function isInvoiceStale(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)
    ?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.INVOICE_STALE;
}
