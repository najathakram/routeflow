import {
  isCounterTenderRow,
  type TenderOrderKind,
  type TenderRowShape,
} from "./counter-tender-row";

/**
 * SA-750r3 (amended): the ONE place that says a payment row is CASH IN THE TILL DRAWER, i.e. the only kind of payment that
 * moves a closed Z report's expected cash. It is a counter tender row (`isCounterTenderRow`) whose method is CASH; a CHECK,
 * a card, an ACH or a credit application moves no close total. The order's kind decides which group ids count (counter sale: ungrouped; POS pickup
 * hand-over: its own `pickupTenderGroupId`), see `isCounterTenderGroup`. Never write `method === "CASH"` for this question anywhere else.
 */
export const isTillCashRow = (
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
): boolean => isCounterTenderRow(orderId, p, order) && p.method === "CASH";
