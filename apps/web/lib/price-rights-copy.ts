import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA-1034 rule 10: the one sentence for "you may not set a price here" (a disabled "Add custom item", and the
 * 403 PRICE_EDIT_NOT_PERMITTED a save answers with). Fixed copy, never the server's text (B980).
 */
export const PRICE_RIGHTS_COPY = "Needs price rights. Ask your admin.";

/** The 403 the server answers an unpermitted price with. */
export function isPriceEditRefusal(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 403 && res.data?.code === API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED;
}

/** The sentence for a refused price, or null for any other error. */
export function priceRightsRefusalCopy(err: unknown): string | null {
  return isPriceEditRefusal(err) ? PRICE_RIGHTS_COPY : null;
}
