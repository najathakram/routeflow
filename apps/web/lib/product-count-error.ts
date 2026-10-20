import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { COUNT_WHOLE_NUMBER_COPY } from "./product-count";

export const COUNT_FRACTIONAL_PACK_COPY = COUNT_WHOLE_NUMBER_COPY;

/**
 * The inline line for a failed count. The filed-period refusal names the period, so its server
 * sentence is shown as written (the only raw read; allow-listed); everything else is fixed copy.
 */
export function countErrorText(err: unknown): string {
  const body = ((err as { response?: { data?: unknown } } | null)?.response?.data ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  const { code, message } = body;
  if (code === API_ERROR_CODES.COUNT_FRACTIONAL_PACK) return COUNT_FRACTIONAL_PACK_COPY;
  if (code === API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD && typeof message === "string" && message)
    return message;
  return genericToastCopy(err);
}
