/**
 * Which stored payment rows are the TILL'S tender of a counter sale (SA-762r F3, shared by the void and the day close).
 *
 * A counter tender row is a non-VOID CASH / CREDIT_CARD / CHECK payment whose `paymentGroupId` is null (every row master
 * writes today). Everything else is FOREIGN: CREDIT_NOTE / ADVANCE applications, an office payment with a group id of its own,
 * a CHECK already DEPOSITED / CLEARED.
 *
 * Known gap until SA-749r2 stamps split-payment leg ids: an ungrouped single-invoice OFFICE payment on a counter invoice is
 * indistinguishable from the till's tender and reads as a tender. When the split-payment PR lands it extends this ONE predicate
 * with `uuidv5("<orderId>:<i>", COUNTER_TENDER_NS)` for i < 4; no other file changes.
 */
export interface TenderRowLike {
  method?: string | null;
  status?: string | null;
  paymentGroupId?: string | null;
  checkStatus?: string | null;
}

const TILL_METHODS: readonly string[] = ["CASH", "CREDIT_CARD", "CHECK"];

export function isCounterTenderRow(_orderId: string, p: TenderRowLike): boolean {
  if (p.status === "VOID") return false;
  if (!p.method || !TILL_METHODS.includes(p.method)) return false;
  if (p.method === "CHECK" && (p.checkStatus === "DEPOSITED" || p.checkStatus === "CLEARED")) {
    return false;
  }
  return p.paymentGroupId == null;
}
