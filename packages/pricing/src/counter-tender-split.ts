import type { TodaysSaleMethod } from "@routeflow/types";
import { CONFIRMED_STATUS } from "./payment-confirmation";
import { formatReceiptMoney } from "./receipt-line-detail";
import { roundMoney } from "./pricing";
import type { ReturnSettlement } from "./return-settlement";

/**
 * The ONE copy of what the till calls each display method (a receipt's Payment method row, the hand-over rows, the emailed
 * receipt). `Record<TodaysSaleMethod, string>` makes a new method a compile error here, in the one place (L-072).
 */
export const COUNTER_METHOD_LABEL: Record<TodaysSaleMethod, string> = {
  ADVANCE: "Advance",
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  OTHER: "Other",
  STORE_CREDIT: "Store credit",
};

/**
 * The Payment method row of a receipt, ONE formatter for the emailed receipt and the reprint (SA-751r: a figure is never on one
 * and not the other). SA-838a: EVERY tender carries its amount ("Advance $12.50", "Cash $5.00 + Card $7.50"), joined with " + ",
 * so a sale that was partly returned still reads what each method took. The no-split (older server) reprint keeps the labels
 * joined as ever.
 */
export function counterMethodLine(
  tenders: ReadonlyArray<{ method: TodaysSaleMethod; amount: number }>,
): string {
  return tenders
    .map((t) => `${COUNTER_METHOD_LABEL[t.method]} ${formatReceiptMoney(t.amount)}`)
    .join(" + ");
}

export interface CounterTenderPayment<M extends string = string> {
  /** the DISPLAY method the till names the payment by (the caller maps the stored method) */
  method: M;
  amount: unknown;
  status?: string;
  /** the credit note this payment applied, when it applied one */
  creditNoteId?: string | null;
}

export interface CounterTenderSplit<M extends string = string> {
  /** what the customer tendered: every PAID payment that is not the sale's own return credit */
  tenderPaid: number;
  /** the sale's own return credit applied to its invoices: the SUM of the settlements' `applied`, derived nowhere else */
  returnCredit: number;
  /** the tenders by method (own return credit excluded), only methods above zero */
  methods: Array<{ method: M; amount: number }>;
}

/**
 * B1262 / SA-838 + SA-838a: the ONE split of a counter sale's payments into what the customer TENDERED and the credit the
 * sale's OWN return made. A return mints a credit note and may apply it back to that sale's invoice (an `InvoicePayment`
 * with `creditNoteId` set): that is the return settling the invoice, not new money, so it is neither a tender on the paper
 * nor part of "Paid". Every other payment (cash, card, check, an advance, store credit from ANOTHER order's return) is a
 * tender. The API calls this once per row; the web never re-derives it.
 *
 * Which credit is the sale's own is `returnSettlement`'s answer (the caller's provenance read feeds it): a payment is return
 * credit only when it applied the note of a settlement with `applied > 0`, so anything unproven stays a tender and no money is
 * ever hidden. `returnCredit` is those settlements' `applied`, summed; this function adds no second derivation of it. Only PAID
 * rows count (the `sumConfirmed` rule); every figure goes through `roundMoney`.
 */
export function counterTenderSplit<M extends string>(
  payments: ReadonlyArray<CounterTenderPayment<M>>,
  settlements: ReadonlyArray<Pick<ReturnSettlement, "creditNoteId" | "applied">>,
  /** the order the methods list in (a receipt's fixed order); omitted: order of first appearance */
  methodOrder?: ReadonlyArray<M>,
): CounterTenderSplit<M> {
  const own = new Set(
    settlements.flatMap((s) => (s.creditNoteId && s.applied > 0 ? [s.creditNoteId] : [])),
  );
  const confirmed = payments.filter((p) => p.status === CONFIRMED_STATUS);
  const isOwnCredit = (p: CounterTenderPayment<M>) => !!p.creditNoteId && own.has(p.creditNoteId);
  const sum = (rows: ReadonlyArray<CounterTenderPayment<M>>) =>
    roundMoney(rows.reduce((s, p) => s + Number(p.amount), 0));

  const tenders = confirmed.filter((p) => !isOwnCredit(p));
  const seen = tenders.map((p) => p.method).filter((m, i, all) => all.indexOf(m) === i);
  const order = methodOrder ? methodOrder.filter((m) => seen.includes(m)) : seen;
  const methods = order.flatMap((method) => {
    const amount = sum(tenders.filter((p) => p.method === method));
    return amount > 0 ? [{ method, amount }] : [];
  });
  return {
    tenderPaid: sum(tenders),
    returnCredit: roundMoney(settlements.reduce((s, r) => s + r.applied, 0)),
    methods,
  };
}
