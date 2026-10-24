import { API_ERROR_CODES } from "@routeflow/types";
import { safeTextErrorCopy } from "./safe-text-error-copy";

export const PRODUCT_SAVE_FALLBACK = "Couldn't save. Try again.";

/**
 * Fixed copy for the known product-save refusals (owner rule: no raw server strings in the UI). The server `message`
 * is never shown. Anything unmapped gets the blanket line.
 *  - FAMILY_PRICE_AUTHORITY (409): the family owns the variant's price (mixed_packs mode).
 *  - TEXT_CELL_FORMULA_LEAD (400): an unsafe name / category (starts with = + - @ or a tab/line break).
 *  - FAMILY_ROWS_CONFLICT (409) / FAMILY_NOT_FOUND (404): the family rows changed under the form.
 *  - PRODUCT_PACK_STALE (409): the pack the form opened with moved meanwhile (SA-797, e.g. a unit rename).
 */
export function productSaveErrorCopy(err: unknown): string {
  const unsafe = safeTextErrorCopy(err);
  if (unsafe) return unsafe;
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  switch (code) {
    case API_ERROR_CODES.FAMILY_PRICE_AUTHORITY:
      return "This variant's price is set on its family. Change it on the family instead.";
    case API_ERROR_CODES.FAMILY_ROWS_CONFLICT:
    case API_ERROR_CODES.FAMILY_NOT_FOUND:
      return "Some of those products changed. Reload and try again.";
    case API_ERROR_CODES.VARIANT_PARENT_INACTIVE:
      return "Turn the family back on first, then reactivate this variant.";
    case API_ERROR_CODES.PRODUCT_PACK_STALE:
      return "This product changed since you opened it. Reload to see the latest.";
    default:
      return PRODUCT_SAVE_FALLBACK;
  }
}
