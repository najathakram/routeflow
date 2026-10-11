import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA-750r3: the end-of-day close refusals on an invoice's payments, shown as FIXED copy chosen by `body.code` (the server's
 * message is never read). A null result means "not a day-close refusal": the caller keeps its own copy.
 */
export const DAY_CLOSED_FOR_PAYMENT_DATE_COPY = "That day is closed. Record it with today's date.";
export const COUNTER_SALE_DAY_CLOSED_COPY = "This day has been closed. Reopen the close first.";

export function dayClosedCopy(err: unknown): string | null {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  if (res?.status !== 409) return null;
  if (res.data?.code === API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE)
    return DAY_CLOSED_FOR_PAYMENT_DATE_COPY;
  if (res.data?.code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED)
    return COUNTER_SALE_DAY_CLOSED_COPY;
  return null;
}
