import { API_ERROR_CODES, INVOICE_TAX_STATE_STALE_COPY } from "@routeflow/types";

/**
 * SA-814e: a 409 INVOICE_TAX_STATE_STALE (the invoice's stored tax can't be reproduced from its lines) is shown
 * as FIXED copy chosen by the body's `path`, the same sentences web shows (`INVOICE_TAX_STATE_STALE_COPY` in
 * @routeflow/types). Mobile edits drafts, so a body with no path gets the draft sentence. Any other error
 * returns null so the caller keeps its own fallback.
 */
export function taxStateStaleCopy(e: unknown): string | null {
  const data = (e as { response?: { status?: number; data?: { code?: unknown; path?: unknown } } })
    ?.response?.data;
  if (data?.code !== API_ERROR_CODES.INVOICE_TAX_STATE_STALE) return null;
  return data.path === "PRICE_ADJUSTMENT"
    ? INVOICE_TAX_STATE_STALE_COPY.PRICE_ADJUSTMENT
    : INVOICE_TAX_STATE_STALE_COPY.DRAFT_EDIT;
}
