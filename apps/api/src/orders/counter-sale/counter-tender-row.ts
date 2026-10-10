/**
 * SA-762r F3: the ONE predicate that says which of an order's payment rows are the COUNTER'S OWN tender, as opposed to
 * money somebody else put on the sale (credit notes, advances, an office payment, a deposited check). The counter-sale
 * void voids exactly the tender rows and refuses (COUNTER_SALE_VOID_FOREIGN_PAYMENT) when any other live row exists;
 * the SA-750 close lock (SA-750r2 item 6) imports this same function instead of a second copy.
 *
 * A counter tender row is a PAID or PENDING CASH / CREDIT_CARD / CHECK row that carries no foreign payment group:
 *  - `paymentGroupId == null` is how `recordPayment` stores a single-invoice counter tender on master today;
 *  - EXTENSION POINT (SA-749r2, not on this base): once the split tender lands, its rows carry
 *    `paymentGroupId === uuidv5(`${orderId}:${i}`, COUNTER_TENDER_NS)` for some i < 4. Neither the namespace nor a
 *    uuid dependency exists here, so `isCounterTenderGroup` accepts null only; add the derived ids THERE and nowhere
 *    else (see the test.todo in counter-tender-row.spec.ts).
 * Known gap until SA-749r2: an ungrouped single-invoice OFFICE payment is indistinguishable from the counter's own
 * tender and is handed back with it.
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

/** The group ids a counter tender may carry for `orderId`. Null today; SA-749r2 adds the derived split ids here. */
export function isCounterTenderGroup(_orderId: string, paymentGroupId: string | null | undefined) {
  return paymentGroupId == null;
}

export function isCounterTenderRow(orderId: string, p: TenderRowShape): boolean {
  if (p.status !== "PAID" && p.status !== "PENDING") return false;
  if (!TENDER_METHODS.has(p.method)) return false;
  // A check the bank has taken is no longer the till's: deposited / cleared reads as foreign money.
  if (p.method === "CHECK" && p.checkStatus != null && p.checkStatus !== "RECORDED") return false;
  return isCounterTenderGroup(orderId, p.paymentGroupId);
}

/**
 * A live (non-VOID) payment row that is not the counter's tender.
 * scan-ok: draft-payment-not-void — a DRAFT row is live and NOT a settled tender, so it reads FOREIGN (it refuses a void).
 */
export const isForeignPaymentRow = (orderId: string, p: TenderRowShape): boolean =>
  p.status !== "VOID" && !isCounterTenderRow(orderId, p);
