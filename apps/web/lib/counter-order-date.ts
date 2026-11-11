// W-1188: the till's fixed copy for the server's two order-date refusals (400 ORDER_DATE_OUT_OF_RANGE, 409
// ORDER_DATE_PERIOD_LOCKED). Both are refused BEFORE anything is written. The server's own message is never shown.
import { API_ERROR_CODES } from "@routeflow/types";
import { longDay, monthYearLabel } from "./natural-date";

type Refusal =
  { response?: { status?: number; data?: Record<string, unknown> } } | null | undefined;

const PAST_END = /^That date is more than 2 years back\. Pick .* or later\.$/;
const OUTSIDE = "That date is outside the dates this till takes. Pick another day.";
const FUTURE = "That date is more than a year ahead. Check the year.";
const LOCKED_END = " Pick a date in an open month, or use today.";

/** The copy for a date refusal, or null when `err` is not one. */
export function orderDateRefusalCopy(err: unknown, sentDay?: string): string | null {
  const res = (err as Refusal)?.response;
  const data = res?.data;
  if (res?.status === 400 && data?.code === API_ERROR_CODES.ORDER_DATE_OUT_OF_RANGE) {
    const min = typeof data.min === "string" ? data.min : "";
    const max = typeof data.max === "string" ? data.max : "";
    // One code covers both ends, so the day the clerk sent says which bound it crossed.
    if (sentDay && max && sentDay > max) return FUTURE;
    if (!sentDay || !min) return OUTSIDE;
    return `That date is more than 2 years back. Pick ${longDay(min)} or later.`;
  }
  if (res?.status === 409 && data?.code === API_ERROR_CODES.ORDER_DATE_PERIOD_LOCKED) {
    const when = typeof data.periodKey === "string" ? monthYearLabel(data.periodKey) : "That month";
    const cat = typeof data.categoryName === "string" && data.categoryName ? data.categoryName : "";
    return `${when} is filed and locked${cat ? ` for ${cat}` : ""}.${LOCKED_END}`;
  }
  return null;
}

/** True for copy this module produced: the chip shows its red ring while the checkout message is one of these. */
export function isOrderDateRefusalCopy(s: string): boolean {
  return (
    PAST_END.test(s) || s === FUTURE || /is filed and locked.*Pick a date in an open month/.test(s)
  );
}

export const ORDER_DATE_REFUSAL_CODES = [
  API_ERROR_CODES.ORDER_DATE_OUT_OF_RANGE,
  API_ERROR_CODES.ORDER_DATE_PERIOD_LOCKED,
] as const;
