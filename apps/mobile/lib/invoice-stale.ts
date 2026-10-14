import { API_ERROR_CODES } from "@routeflow/types";

/**
 * H4 (mirrors web lib/invoice-stale.ts): the edit screen sends the `updatedAt` it hydrated from as
 * `expectedUpdatedAt`; another save since is a 409 INVOICE_STALE with nothing written. Fixed copy, never the
 * server's sentence.
 */
export const INVOICE_STALE_TITLE = "Invoice changed";
export const INVOICE_STALE_COPY =
  "Someone else saved this invoice after you opened it, so your changes were not saved. Reload to see the latest, then re-apply your changes.";

export function isInvoiceStale(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)
    ?.response;
  return res?.status === 409 && res.data?.code === API_ERROR_CODES.INVOICE_STALE;
}
