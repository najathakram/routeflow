import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * SA-762r F3: the ONE predicate that says which of an order's payment rows are the COUNTER'S OWN tender, as opposed to
 * money somebody else put on the sale (credit notes, advances, an office payment, a deposited check). The counter-sale
 * void voids exactly the tender rows and refuses (COUNTER_SALE_VOID_FOREIGN_PAYMENT) when any other live row exists;
 * the SA-750 close lock (SA-750r2 item 6) imports this same function instead of a second copy.
 *
 * A counter tender row is a PAID or PENDING CASH / CREDIT_CARD / CHECK row that carries no foreign payment group:
 *  - `paymentGroupId == null` is how `recordPayment` stores a single-invoice counter tender on master today;
 *  - `paymentGroupId === pickupTenderGroupId(orderId)` is the hand-over cash pickup-complete takes on a counter sale (a counter
 *    sale is a PICKUP order too; the group id is written for every order kind);
 *  - EXTENSION POINT (SA-749r2, not on this base): once the split tender lands, its rows carry
 *    `paymentGroupId === uuidv5(`${orderId}:${i}`, COUNTER_TENDER_NS)` for some i < 4. Neither the namespace nor a
 *    uuid dependency exists here, so `isCounterTenderGroup` accepts null and the order's own pickup id only; add the derived
 *    ids THERE and nowhere else (see the test.todo in counter-tender-row.spec.ts).
 * Known gap until SA-749r2: an ungrouped single-invoice OFFICE payment is indistinguishable from the counter's own
 * tender and is handed back with it.
 *
 * SA-750r3 r-note (Train 4 meets day close): ONE predicate, TWO clauses, keyed on the ORDER'S KIND, which every caller must
 * state (`order`, never defaulted):
 *  (i) a counter-sale order (`counterSale === true`): the rule above, ungrouped rows or its own pickup id (the SA-749r2 leg ids join here);
 *  (ii) any other order (a POS-mode pickup hand-over): ONLY a row whose `paymentGroupId === pickupTenderGroupId(orderId)`.
 *       Driver, route and office payments never carry that deterministic id, so on a non-counter order an ungrouped or
 *       random-group row is NOT a tender (it stays "not taken at the till"); the ungrouped acceptance is scoped to counter
 *       sales and never spreads to regular orders. Another order's pickup id is foreign on either kind.
 *
 * Anything else that is not VOID is FOREIGN: CREDIT_NOTE / ADVANCE rows, an office payment with a random group id, a
 * CHECK already DEPOSITED or CLEARED, an ACH / ZELLE / OTHER row, a DRAFT row.
 */
export interface TenderRowShape {
  method: string;
  status: string;
  paymentGroupId?: string | null;
  checkStatus?: string | null;
}

const TENDER_METHODS: ReadonlySet<string> = new Set(["CASH", "CREDIT_CARD", "CHECK"]);

/** The order's kind, as the predicate reads it. Required on every call: a caller must classify, never fall into a default. */
export interface TenderOrderKind {
  counterSale?: boolean | null;
}

/**
 * The group ids a tender may carry for `orderId`. A counter-sale order: none (null), its OWN pickup hand-over id (pickup-complete
 * runs on counter sales too and stamps `pickupTenderGroupId(orderId)` on every order kind), and, once SA-749r2 lands, the derived
 * split ids here. A non-counter order: only its own pickup hand-over id.
 */
export function isCounterTenderGroup(
  orderId: string,
  paymentGroupId: string | null | undefined,
  order: TenderOrderKind,
) {
  const ownPickup = paymentGroupId != null && paymentGroupId === pickupTenderGroupId(orderId);
  if (order.counterSale === true) return paymentGroupId == null || ownPickup;
  return ownPickup;
}

export function isCounterTenderRow(
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
): boolean {
  if (p.status !== "PAID" && p.status !== "PENDING") return false;
  if (!TENDER_METHODS.has(p.method)) return false;
  // A check the bank has taken is no longer the till's: deposited / cleared reads as foreign money.
  if (p.method === "CHECK" && p.checkStatus != null && p.checkStatus !== "RECORDED") return false;
  return isCounterTenderGroup(orderId, p.paymentGroupId, order);
}

/**
 * A live (non-VOID) payment row that is not the counter's tender.
 * scan-ok: draft-payment-not-void — a DRAFT row is live and NOT a settled tender, so it reads FOREIGN (it refuses a void).
 */
export const isForeignPaymentRow = (
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
): boolean => p.status !== "VOID" && !isCounterTenderRow(orderId, p, order);
