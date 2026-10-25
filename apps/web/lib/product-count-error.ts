import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { COUNT_WHOLE_NUMBER_COPY } from "./product-count";

export const COUNT_FRACTIONAL_PACK_COPY = COUNT_WHOLE_NUMBER_COPY;

/**
 * The inline line for a failed count. Every line is fixed copy: the filed-period refusal is built from
 * its structured fields (`filedFor`, `period`), never the server's sentence.
 */
export function countErrorText(err: unknown): string {
  const body = ((err as { response?: { data?: unknown } } | null)?.response?.data ?? {}) as {
    code?: unknown;
    filedFor?: unknown;
    period?: unknown;
  };
  const { code, filedFor, period } = body;
  if (code === API_ERROR_CODES.COUNT_FRACTIONAL_PACK) return COUNT_FRACTIONAL_PACK_COPY;
  if (
    code === API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD &&
    typeof filedFor === "string" &&
    typeof period === "string"
  )
    return `${filedFor} is filed for ${period}. Choose a later date.`;
  return genericToastCopy(err);
}
