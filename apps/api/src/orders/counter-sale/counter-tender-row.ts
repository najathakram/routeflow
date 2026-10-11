import { TENDER_RULES } from "@routeflow/pricing";
import { uuidv5 } from "../../common/uuidv5";
import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * SA-762r F3 + SA-749r2 + SA-750r3: the ONE home of "which of an order's payment rows are the COUNTER'S OWN tender", as
 * opposed to money somebody else put on the sale (credit notes, advances, an office payment, a deposited check). The
 * counter-sale void voids exactly the tender rows and refuses (COUNTER_SALE_VOID_FOREIGN_PAYMENT) when any other live row
 * exists; the day close's fold, the closed-day payment guard (`isTillCashRow` is this predicate AND method CASH) and
 * `readStoredTender` (counter-sale-tender.ts, through `tenderSetOf`) all read the same functions instead of a second copy.
 *
 * ONE predicate, keyed on the ORDER'S KIND, which every caller must state (`order`, never defaulted), and judged against the
 * SALE'S payment rows as a SET (`saleRows`), because a group id is only meaningful against the rest of the sale:
 *  (i) a counter-sale order (`counterSale === true`) takes a row when it is
 *      - one of THIS order's leg rows: `paymentGroupId === legGroupId(orderId, i)` for some i < TENDER_RULES.counter.maxLegs
 *        (every new sale's tender is grouped on the split base, single-method sales included); or
 *      - ungrouped (no group id) while the sale has NO leg-grouped row at all: the legacy single-tender rule (a sale rung
 *        before the split deploy). Once any leg-grouped row exists, an ungrouped row is something the office added later:
 *        foreign; or
 *      - the order's OWN pickup hand-over id (`pickupTenderGroupId(orderId)`): a counter sale is a PICKUP order too, and the
 *        hand-over cash is till cash;
 *  (ii) any other order (a POS-mode pickup hand-over): ONLY a row whose `paymentGroupId === pickupTenderGroupId(orderId)`.
 *       Driver, route and office payments never carry that deterministic id, so on a non-counter order an ungrouped or
 *       random-group row is NOT a tender (it stays "not taken at the till"); the ungrouped acceptance is scoped to counter
 *       sales and never spreads to regular orders.
 * A row with any other group id (an office multi-invoice payment's random id, another order's leg id or pickup id) is
 * FOREIGN on either kind. "Leg-grouped" means a leg id only: a pickup hand-over row never turns a legacy sale's ungrouped
 * till tender into foreign money.
 * Residual gap (no marker exists for it): an ON_ACCOUNT sale has no grouped row, so a single-invoice office payment
 * made on it later reads as legacy tender.
 *
 * Beyond the group, a counter tender row is a PAID or PENDING CASH / CREDIT_CARD / CHECK row; anything else that is not
 * VOID is FOREIGN: CREDIT_NOTE / ADVANCE rows, a CHECK already DEPOSITED or CLEARED, an ACH / ZELLE / OTHER row, a
 * DRAFT row.
 *
 * What the TENDER itself took (the cash APPLIED the change is measured against, and what "the tender completed" is
 * judged on) is the predicate's first clause only: the sale's own leg rows (or the legacy ungrouped ones), never a later
 * hand-over's cash, because that is another till event with no handed-over amount of its own (`counterTenderCashRows`,
 * `tenderTakenCents`, both below).
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

/** The server-built `paymentGroupId` of one leg: never in the DTO, never from the idempotency key. */
export function legGroupId(orderId: string, legIndex: number): string {
  return uuidv5(`${orderId}:${legIndex}`, TENDER_RULES.counter.groupNamespace);
}

/** Every leg group id this order's counter tender can carry (a reader that must find the sale's grouped rows in SQL). */
export function legGroupIds(orderId: string): string[] {
  return Array.from({ length: TENDER_RULES.counter.maxLegs }, (_, i) => legGroupId(orderId, i));
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
  legGroupIds(orderId).forEach((g, i) => ids.set(g, i));
  const legOf = (g: string | null | undefined) => (g == null ? null : (ids.get(g) ?? null));
  // scan-ok: draft-payment-not-void — only a VOIDED grouped row is left out of the set (it no longer holds money); a
  // DRAFT row never carries a leg group id, so it cannot make a sale read as grouped.
  return {
    legOf,
    hasGrouped: rows.some((r) => r.status !== "VOID" && legOf(r.paymentGroupId) != null),
  };
}

/**
 * The predicate's first clause: does this group id belong to the counter's OWN tender of the sale `set` describes (a leg
 * id of this order, or no group at all while the sale has no leg-grouped row)? A pickup hand-over's id is NOT this clause.
 */
export function isTenderLegGroup(
  set: TenderSet,
  paymentGroupId: string | null | undefined,
): boolean {
  if (paymentGroupId == null) return !set.hasGrouped;
  return set.legOf(paymentGroupId) != null;
}

/**
 * The group clause of the ONE predicate, for an order of kind `order` and the sale `set`: a counter sale takes its own
 * tender legs (or the legacy ungrouped rows) and its own pickup hand-over id; any other order only its own pickup id.
 */
export function isCounterTenderGroup(
  orderId: string,
  set: TenderSet,
  paymentGroupId: string | null | undefined,
  order: TenderOrderKind,
): boolean {
  const ownPickup = paymentGroupId != null && paymentGroupId === pickupTenderGroupId(orderId);
  if (order.counterSale === true) return ownPickup || isTenderLegGroup(set, paymentGroupId);
  return ownPickup;
}

/**
 * The ONE predicate, against a prebuilt `set` (a fold over many rows of one sale builds it once). `isCounterTenderRow`
 * is this with the set built from the sale's rows.
 */
export function isCounterTenderRowIn(
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
  set: TenderSet,
): boolean {
  if (p.status !== "PAID" && p.status !== "PENDING") return false;
  if (!TENDER_METHODS.has(p.method)) return false;
  // A check the bank has taken is no longer the till's: deposited / cleared reads as foreign money.
  if (p.method === "CHECK" && p.checkStatus != null && p.checkStatus !== "RECORDED") return false;
  return isCounterTenderGroup(orderId, set, p.paymentGroupId, order);
}

/**
 * `saleRows` = the sale's non-VOID payment rows, or at least every one that carries a group id (the set the row is judged
 * against; a row with a leg id needs none of the others, an ungrouped row needs to know whether any leg-grouped row exists).
 */
export function isCounterTenderRow(
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
  saleRows: ReadonlyArray<{ paymentGroupId?: string | null; status?: string }>,
): boolean {
  return isCounterTenderRowIn(orderId, p, order, tenderSetOf(orderId, saleRows));
}

/**
 * The sale's counter-tender CASH rows: a live cash row (never a voided one) of the sale's OWN tender (the predicate's
 * first clause: a leg of this order, or a legacy ungrouped row). The ONE definition behind "does a CASH tender already
 * anchor the stored tendered?" (the tender write) and "which rows is the change measured against?" (the read-back,
 * Today's row and the receipt), so the three can not drift. A later pickup hand-over's cash is the till's (the predicate)
 * but not this tender's: the stored tendered is the cash LEG's handed-over amount. Pass every payment row of the sale.
 * scan-ok: draft-payment-not-void — a DRAFT cash row is listed here and adds nothing to a PAID-only sum (sumConfirmed).
 */
export function counterTenderCashRows<
  T extends { method?: string; status?: string; paymentGroupId?: string | null },
>(orderId: string, payments: readonly T[]): T[] {
  const set = tenderSetOf(orderId, payments);
  return payments.filter(
    (p) => p.status !== "VOID" && p.method === "CASH" && isTenderLegGroup(set, p.paymentGroupId),
  );
}

/**
 * What the sale's tender HAD TAKEN at its peak: the counter-tender rows (CASH / CREDIT_CARD / CHECK of this sale's own
 * tender, the predicate's first clause) plus the credit applied up front (CREDIT_NOTE / ADVANCE), counting a row that was
 * voided afterwards. A tender that reached the total "completed at the time", so a card payment voided later or a total
 * cut later does not reopen it; an interrupted tender (one leg's rows only part-written) stays short of the total for
 * good, and a later hand-over does not complete it. Pass every payment row of the sale.
 * scan-ok: draft-payment-not-void — a VOID row is counted on purpose here (the tender completed when it was taken), a DRAFT
 * row is never a taken payment.
 */
export function tenderTakenCents(
  orderId: string,
  payments: ReadonlyArray<{
    method?: string;
    status?: string;
    amount: unknown;
    paymentGroupId?: string | null;
  }>,
): number {
  // group membership is judged with the voided rows in the set (a sale whose leg rows were all voided is still a grouped sale)
  const set = tenderSetOf(
    orderId,
    payments.map((p) => ({ paymentGroupId: p.paymentGroupId, status: "PAID" })),
  );
  const taken = payments
    .filter((p) => p.status === "PAID" || p.status === "VOID" || p.status === "PENDING")
    .filter((p) =>
      p.method === "CREDIT_NOTE" || p.method === "ADVANCE"
        ? p.status !== "PENDING"
        : TENDER_METHODS.has(p.method ?? "") && isTenderLegGroup(set, p.paymentGroupId),
    )
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  return Math.round(taken * 100);
}

/**
 * A live (non-VOID) payment row that is not the counter's tender.
 * scan-ok: draft-payment-not-void — a DRAFT row is live and NOT a settled tender, so it reads FOREIGN (it refuses a void).
 */
export const isForeignPaymentRow = (
  orderId: string,
  p: TenderRowShape,
  order: TenderOrderKind,
  saleRows: ReadonlyArray<{ paymentGroupId?: string | null; status?: string }>,
): boolean => p.status !== "VOID" && !isCounterTenderRow(orderId, p, order, saleRows);
