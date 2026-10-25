import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { COUNT_WHOLE_NUMBER_COPY } from "./product-count";

export const COUNT_FRACTIONAL_PACK_COPY = COUNT_WHOLE_NUMBER_COPY;

/**
 * The inline line for a failed count. The fractional-pack refusal has its own fixed line; every other
 * code (the filed-period 409 included) goes through `genericToastCopy`, the one place a code's words live.
 */
export function countErrorText(err: unknown): string {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  if (code === API_ERROR_CODES.COUNT_FRACTIONAL_PACK) return COUNT_FRACTIONAL_PACK_COPY;
  return genericToastCopy(err);
}
