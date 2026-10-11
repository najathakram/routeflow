import {
  isCounterTenderRow,
  type TenderOrderKind,
  type TenderRowShape,
} from "./counter-tender-row";

/**
 * SA-750r3 (amended): the ONE place that says a payment row is CASH IN THE TILL DRAWER, i.e. the only kind of payment that
 * moves a closed Z report's expected cash. It is a counter tender row (`isCounterTenderRow`, the one predicate, judged
 * against the sale's rows) whose method is CASH; a CHECK, a card, an ACH or a credit application moves no close total. The
 * order's kind and the sale's set decide which group ids count (counter sale: its own leg ids, an ungrouped row of a
 * legacy sale, or its own `pickupTenderGroupId`; POS pickup hand-over: its own `pickupTenderGroupId` only), see
 * `isCounterTenderGroup`. Never write `method === "CASH"` for this question anywhere else.
 */
export const isTillCashRow = (
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
  saleRows: ReadonlyArray<{ paymentGroupId?: string | null; status?: string }>,
): boolean => isCounterTenderRow(orderId, p, order, saleRows) && p.method === "CASH";
