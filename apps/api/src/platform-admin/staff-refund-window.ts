/**
 * R-2 (SA-1297 ruling 1): the staff refund's 14-day clock, as ONE pure function the service calls before and after the
 * tenant lock. The window is judged on the ENTERED refund date (the day the money moved in the provider's dashboard), in
 * UTC instants; recording later is allowed, so there is no recording deadline.
 *
 *   deadline = paidAt + 14 x 24h
 *   dayStart = Date.UTC(Y, M-1, D) of the entered day;  dayEnd = dayStart + 24h - 1ms
 *   before the payment : dayEnd < paidAt            -> OUT_OF_RANGE (a plain 400)
 *   in the future      : dayStart > now             -> OUT_OF_RANGE (a plain 400)
 *   past the window    : dayStart > deadline        -> WINDOW_PASSED (409 STAFF_REFUND_WINDOW_PASSED); inclusive at exactly 14 x 24h
 */
export const REFUND_WINDOW_MS = 14 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export type RefundDateVerdict =
  { ok: true } | { ok: false; reason: "OUT_OF_RANGE" | "WINDOW_PASSED" };

/** The last instant a refund day may start at: paidAt + 14 x 24h. */
export function refundDeadline(paidAt: Date): Date {
  return new Date(paidAt.getTime() + REFUND_WINDOW_MS);
}

/** The start instant (UTC midnight) of a `YYYY-MM-DD` day, or null when the text is not a real calendar day. */
export function utcDayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Date.UTC rolls 2026-02-30 into March; a round trip catches it.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return t;
}

export function checkRefundDate(paidAt: Date, refundDate: string, now: Date): RefundDateVerdict {
  const dayStart = utcDayStart(refundDate);
  if (dayStart === null) return { ok: false, reason: "OUT_OF_RANGE" };
  const dayEnd = dayStart + DAY_MS - 1;
  if (dayEnd < paidAt.getTime()) return { ok: false, reason: "OUT_OF_RANGE" };
  if (dayStart > now.getTime()) return { ok: false, reason: "OUT_OF_RANGE" };
  if (dayStart > refundDeadline(paidAt).getTime()) return { ok: false, reason: "WINDOW_PASSED" };
  return { ok: true };
}
