import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA-750r3: the end-of-day close refusals, shown as FIXED copy chosen by `body.code` (the server's
 * message is never read). A null result means "not a day-close refusal": the caller keeps its own copy.
 *
 * Two codes, one rule (a closed day's money never moves):
 * - `DAY_CLOSED_FOR_PAYMENT_DATE`: a payment dated inside a closed day. The way out is a date after the close.
 * - `COUNTER_SALE_DAY_CLOSED`: a till write dated now/inside a closed window (a payment record/edit/delete/void, a
 *   check-status change, a pickup tender, a till sale's tender, a sale void, a refund). The generic sentence below is the
 *   one every surface falls back to; a surface that has a better next step (Void: Return, Refund: store credit) says it in
 *   its own fixed copy (`counter-void-copy.ts`, `REFUND_DAY_CLOSED_COPY`, `PICKUP_DAY_CLOSED_COPY`,
 *   `COUNTER_SALE_DAY_CLOSED_TILL_COPY`). `generic-toast-copy.ts` carries both codes, so a dialog with no copy of its own
 *   never falls to "That conflicts with something...".
 */
export const DAY_CLOSED_FOR_PAYMENT_DATE_COPY = "That day is closed. Record it with today's date.";
export const COUNTER_SALE_DAY_CLOSED_COPY =
  "This day is closed, so this can't be changed. Record it with today's date instead.";

/**
 * A refund (a recorded cash / card / check payout of a return) dated inside a closed day. Store credit mints no drawer money,
 * so it is the way out; the saved return stays pending and the refund can be recorded on a later date.
 */
export const REFUND_DAY_CLOSED_COPY =
  "This day is closed, so the refund can't be recorded now. Give store credit instead, or record the refund on a later date.";

type Refusal = { response?: { status?: number; data?: { code?: unknown } } } | null | undefined;

/** The day-close code of a 409 refusal, or null. */
function dayClosedCode(err: unknown): string | null {
  const res = (err as Refusal)?.response;
  if (res?.status !== 409) return null;
  const code = res.data?.code;
  return code === API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE ||
    code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED
    ? code
    : null;
}

/** True for a 409 end-of-day close refusal (either code): the surface owns its copy, so the global toast stays quiet. */
export function isDayClosedRefusal(err: unknown): boolean {
  return dayClosedCode(err) !== null;
}

/** True only for 409 COUNTER_SALE_DAY_CLOSED (a till write, not a payment date). */
export function isCounterSaleDayClosed(err: unknown): boolean {
  return dayClosedCode(err) === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED;
}

export function dayClosedCopy(err: unknown): string | null {
  const code = dayClosedCode(err);
  if (code === API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE) return DAY_CLOSED_FOR_PAYMENT_DATE_COPY;
  if (code === API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED) return COUNTER_SALE_DAY_CLOSED_COPY;
  return null;
}
