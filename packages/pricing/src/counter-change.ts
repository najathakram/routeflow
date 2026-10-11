import { roundMoney } from "./pricing";

/**
 * The order a counter sale's tender methods are LISTED in, everywhere (Today's sales row, the receipt document, the
 * live receipt, the tender response): non-cash methods first, CASH last, because the server applies the legs in that
 * order (`planTenderLegs`) and a cash leg is the one that takes what the others left. ONE list: the API and the web
 * both import it from here (the API cannot value-import `@routeflow/types`).
 */
export const COUNTER_TENDER_DISPLAY_ORDER = [
  "CARD",
  "CHECK",
  "OTHER",
  "STORE_CREDIT",
  "CASH",
] as const;
export type CounterTenderDisplayMethod = (typeof COUNTER_TENDER_DISPLAY_ORDER)[number];

/**
 * THE change of a counter sale (SA-749r2): the ONE formula, used by the tender response, the by-key read-back, Today's
 * sales and the receipt / reprint, so no surface keeps a second one.
 *
 * - `total`: what the sale owed.
 * - `nonCashApplied`: money applied to it that is NOT the cash leg (card, check, credit, an advance).
 * - `tendered`: the cash handed over (`Order.counterCashTendered`, the cash leg's amount).
 *
 * The cash the sale takes is what the other methods left: `cashApplied = max(0, total - nonCashApplied)`; whatever
 * was handed over beyond that goes back: `change = max(0, tendered - cashApplied)`. Every step is rounded to the cent.
 * The cash APPLIED (a payment row) is what the till and the day close count, never `tendered`.
 */
export function counterChange(input: { total: number; nonCashApplied: number; tendered: number }): {
  cashApplied: number;
  change: number;
} {
  const cashApplied = Math.max(
    0,
    roundMoney(roundMoney(input.total) - roundMoney(input.nonCashApplied)),
  );
  const change = Math.max(0, roundMoney(roundMoney(input.tendered) - cashApplied));
  return { cashApplied, change };
}
