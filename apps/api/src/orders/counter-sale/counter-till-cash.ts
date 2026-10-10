import { isCounterTenderRow, type TenderRowShape } from "./counter-tender-row";

/**
 * SA-750r3 (amended): the ONE place that says a payment row is CASH IN THE TILL DRAWER, i.e. the only kind of payment that
 * moves a closed Z report's expected cash. It is a counter tender row (`isCounterTenderRow`) whose method is CASH; a CHECK,
 * a card, an ACH or a credit application moves no close total. It narrows itself when the split tender (SA-749r2) lands in
 * `isCounterTenderGroup`. Never write `method === "CASH"` for this question anywhere else.
 */
export const isTillCashRow = (orderId: string, p: TenderRowShape): boolean =>
  isCounterTenderRow(orderId, p) && p.method === "CASH";
