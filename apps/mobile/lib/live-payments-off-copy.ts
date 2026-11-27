import { API_ERROR_CODES } from "@routeflow/types";
import { LIVE_PAYMENTS_OFF_SENTENCE } from "@routeflow/types/live-payments-off-copy";

/**
 * SA-1547 M1 (mirror of web's generic-toast-copy): the wall's `LIVE_PAYMENTS_OFF` refusal is shown as FIXED copy chosen
 * by `response.data.code`, never the server message. Null for any other code so the caller falls through.
 */
export const LIVE_PAYMENTS_OFF_COPY = LIVE_PAYMENTS_OFF_SENTENCE;

export function livePaymentsOffCopy(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  return code === API_ERROR_CODES.LIVE_PAYMENTS_OFF ? LIVE_PAYMENTS_OFF_COPY : null;
}
