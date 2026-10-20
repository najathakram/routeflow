import { API_ERROR_CODES, INVOICE_TAX_STATE_STALE_COPY } from "@routeflow/types";

/**
 * SA-814e: a 409 INVOICE_TAX_STATE_STALE (the invoice's stored tax can't be reproduced from its lines) is shown
 * as FIXED copy chosen by the body's `path` (DRAFT_ORDER, DRAFT_MANUAL, ISSUED), the same sentences web shows (`INVOICE_TAX_STATE_STALE_COPY` in
 * @routeflow/types). A body with no (or an unknown) path gets the issued-invoice sentence, which makes no claim about drafts. Any other error
 * returns null so the caller keeps its own fallback.
 */
export function taxStateStaleCopy(e: unknown): string | null {
  const data = (e as { response?: { status?: number; data?: { code?: unknown; path?: unknown } } })
    ?.response?.data;
  if (data?.code !== API_ERROR_CODES.INVOICE_TAX_STATE_STALE) return null;
  const copy = INVOICE_TAX_STATE_STALE_COPY as Record<string, string>;
  return typeof data.path === "string" && Object.prototype.hasOwnProperty.call(copy, data.path)
    ? copy[data.path]
    : INVOICE_TAX_STATE_STALE_COPY.ISSUED;
}
