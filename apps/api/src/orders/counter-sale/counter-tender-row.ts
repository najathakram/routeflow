import { TENDER_RULES } from "@routeflow/pricing";
import { uuidv5 } from "../../common/uuidv5";

/**
 * SA-762r F3 + SA-749r2: the ONE home of "which of an order's payment rows are the COUNTER'S OWN tender", as opposed
 * to money somebody else put on the sale (credit notes, advances, an office payment, a deposited check). The
 * counter-sale void voids exactly the tender rows and refuses (COUNTER_SALE_VOID_FOREIGN_PAYMENT) when any other live
 * row exists; the SA-750 close lock (SA-750r2 item 6) imports these same functions instead of a second copy, and
 * `readStoredTender` (counter-sale-tender.ts) reads its legs through the same `tenderSetOf`.
 *
 * The question is SET-LEVEL, not per-row, because the group id is only meaningful against the rest of the sale:
 *  - On the split base EVERY new sale's tender is grouped (`paymentGroupId === legGroupId(orderId, i)` for some
 *    i < TENDER_RULES.counter.maxLegs), single-method sales included. A row carrying one of THIS order's leg ids is
 *    the counter's tender.
 *  - A row with NO group id is the counter's tender only while the sale has no grouped row at all: the legacy
 *    single-tender rule (a sale rung before the split deploy). Once any leg-grouped row exists, an ungrouped row is
 *    something the office added later, so it is foreign.
 *  - A row with any other group id (an office multi-invoice payment's random id, another order's leg id) is foreign.
 * Residual gap (no marker exists for it): an ON_ACCOUNT sale has no grouped row, so a single-invoice office payment
 * made on it later reads as legacy tender.
 *
 * Beyond the group, a counter tender row is a PAID or PENDING CASH / CREDIT_CARD / CHECK row; anything else that is not
 * VOID is FOREIGN: CREDIT_NOTE / ADVANCE rows, a CHECK already DEPOSITED or CLEARED, an ACH / ZELLE / OTHER row, a
 * DRAFT row.
 */
export interface TenderRowShape {
  method: string;
  status: string;
  paymentGroupId?: string | null;
  checkStatus?: string | null;
}

const TENDER_METHODS: ReadonlySet<string> = new Set(["CASH", "CREDIT_CARD", "CHECK"]);

/** The server-built `paymentGroupId` of one leg: never in the DTO, never from the idempotency key. */
export function legGroupId(orderId: string, legIndex: number): string {
  return uuidv5(`${orderId}:${legIndex}`, TENDER_RULES.counter.groupNamespace);
}

/**
 * The sale's payment rows seen as a SET. Pass every non-VOID payment of the sale (a VOID row is no part of it);
 * rows that are not tenders at all (a credit note) can ride along, they never carry a leg group id.
 */
export interface TenderSet {
  /** The leg a group id belongs to for this order, or null when it is not one of this order's leg ids. */
  legOf(paymentGroupId: string | null | undefined): number | null;
  /** True when at least one row carries one of this order's leg ids (a sale rung on the split base). */
  hasGrouped: boolean;
}

export function tenderSetOf(
  orderId: string,
  rows: ReadonlyArray<{ paymentGroupId?: string | null; status?: string }>,
): TenderSet {
  const ids = new Map<string, number>();
  for (let i = 0; i < TENDER_RULES.counter.maxLegs; i++) ids.set(legGroupId(orderId, i), i);
  const legOf = (g: string | null | undefined) => (g == null ? null : (ids.get(g) ?? null));
  // scan-ok: draft-payment-not-void — only a VOIDED grouped row is left out of the set (it no longer holds money); a
  // DRAFT row never carries a leg group id, so it cannot make a sale read as grouped.
  return {
    legOf,
    hasGrouped: rows.some((r) => r.status !== "VOID" && legOf(r.paymentGroupId) != null),
  };
}

/** Does this group id belong to the counter's tender of the sale `set` describes? */
export function isCounterTenderGroup(
  set: TenderSet,
  paymentGroupId: string | null | undefined,
): boolean {
  if (paymentGroupId == null) return !set.hasGrouped;
  return set.legOf(paymentGroupId) != null;
}

/** `saleRows` = every non-VOID payment row of the sale (the set the row is judged against). */
export function isCounterTenderRow(
  orderId: string,
  p: TenderRowShape,
  saleRows: ReadonlyArray<TenderRowShape>,
): boolean {
  if (p.status !== "PAID" && p.status !== "PENDING") return false;
  if (!TENDER_METHODS.has(p.method)) return false;
  // A check the bank has taken is no longer the till's: deposited / cleared reads as foreign money.
  if (p.method === "CHECK" && p.checkStatus != null && p.checkStatus !== "RECORDED") return false;
  return isCounterTenderGroup(tenderSetOf(orderId, saleRows), p.paymentGroupId);
}

/**
 * The sale's counter-tender CASH rows: a live cash row (never a voided one) whose group the set above names as the
 * counter's. The ONE definition behind "does a CASH tender already anchor the stored tendered?" (the tender write)
 * and "which rows is the change measured against?" (the read-back, Today's row and the receipt), so the three can not
 * drift. Pass every payment row of the sale.
 * scan-ok: draft-payment-not-void — a DRAFT cash row is listed here and adds nothing to a PAID-only sum (sumConfirmed).
 */
export function counterTenderCashRows<
  T extends { method?: string; status?: string; paymentGroupId?: string | null },
>(orderId: string, payments: readonly T[]): T[] {
  const set = tenderSetOf(orderId, payments);
  return payments.filter(
    (p) =>
      p.status !== "VOID" && p.method === "CASH" && isCounterTenderGroup(set, p.paymentGroupId),
  );
}

/**
 * A live (non-VOID) payment row that is not the counter's tender.
 * scan-ok: draft-payment-not-void — a DRAFT row is live and NOT a settled tender, so it reads FOREIGN (it refuses a void).
 */
export const isForeignPaymentRow = (
  orderId: string,
  p: TenderRowShape,
  saleRows: ReadonlyArray<TenderRowShape>,
): boolean => p.status !== "VOID" && !isCounterTenderRow(orderId, p, saleRows);
