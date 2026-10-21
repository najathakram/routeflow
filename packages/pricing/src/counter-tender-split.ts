import { CONFIRMED_STATUS } from "./payment-confirmation";
import { roundMoney } from "./pricing";

/**
 * B1262 / SA-838: the ONE split of a counter sale's payments into what the customer TENDERED and the credit the sale's
 * OWN return made. A return on a sale mints a credit note and applies it back to that sale's invoice (an `InvoicePayment`
 * with `creditNoteId` set): that is the return settling the invoice, not new money, so it is neither a tender on the paper
 * nor part of "Paid". Every other payment (cash, card, check, an advance, store credit from ANOTHER order's return) is a
 * tender. The API calls this once per row; the web never re-derives it.
 *
 * Which credit notes are the sale's own is the CALLER's provenance read (`ownReturnCreditNoteIds`): a payment counts as
 * return credit only when its `creditNoteId` is in that set, so anything the caller could not prove stays a tender and
 * no money is ever hidden. Only PAID rows count (the `sumConfirmed` rule); every figure goes through `roundMoney`.
 */
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
  /** the PAID payments that applied one of the sale's own return credit notes */
  returnCredit: number;
  /** the tenders by method (own return credit excluded), only methods above zero */
  methods: Array<{ method: M; amount: number }>;
}

export function counterTenderSplit<M extends string>(
  payments: ReadonlyArray<CounterTenderPayment<M>>,
  ownReturnCreditNoteIds: ReadonlyArray<string> | ReadonlySet<string>,
  /** the order the methods list in (a receipt's fixed order); omitted: order of first appearance */
  methodOrder?: ReadonlyArray<M>,
): CounterTenderSplit<M> {
  const own =
    ownReturnCreditNoteIds instanceof Set
      ? ownReturnCreditNoteIds
      : new Set(ownReturnCreditNoteIds);
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
    returnCredit: sum(confirmed.filter(isOwnCredit)),
    methods,
  };
}
