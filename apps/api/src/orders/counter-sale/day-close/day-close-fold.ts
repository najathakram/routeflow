import { roundMoney } from "@routeflow/pricing";
import type { DayCloseTotals } from "@routeflow/types";
import { refundTenderOfColumn } from "../../../returns/refund-tender";
import { isCounterTenderRowIn, tenderSetOf, type TenderSet } from "../counter-tender-row";
import {
  REFUND_METHOD_EXTERNAL,
  foldSummary,
  type PaidAggregate,
  type PaymentGroup,
  type SalesAggregate,
  type WindowReturn,
} from "../counter-sale-today";

/**
 * Counter day close: the PURE half. The Today's-sales fold (`foldSummary`) over a close window, with the till-cash rules applied:
 * a payment is TILL money only when it is a counter tender row (`isCounterTenderRowIn`, the one predicate the void shares, told the
 * order's kind and judged against the sale's set: a counter sale's leg row, a legacy ungrouped row, its own pickup hand-over
 * row, or a POS-mode pickup hand-over's own-group row); a
 * payment on a counter invoice that is not (an office or driver payment, a deposited check) is shown apart as `notAtTill` and
 * never enters the expected cash. Store-credit applications are not money in. A refund with no recorded tender is never cash.
 */

/**
 * One PAID payment read in the window, with the invoice's order id and the order's kind (the predicate's arguments). The facts read
 * a counter sale's payments AND a POS-mode pickup hand-over's tender (a non-counter order's row carrying its pickup group id).
 */
export interface WindowPayment {
  amount: unknown;
  method: string;
  status: string;
  paymentGroupId?: string | null;
  checkStatus?: string | null;
  invoice?: {
    orderId: string | null;
    order?: {
      counterSale: boolean | null;
      /**
       * The order's other payments that carry a group id (any invoice, a VOID row or a voided invoice's too): the SET the one tender predicate
       * judges an ungrouped row against (is this sale's tender grouped, or a legacy ungrouped one?). Absent reads as none.
       */
      invoices?: ReadonlyArray<{
        payments?: ReadonlyArray<{ paymentGroupId: string | null; status: string }>;
      }> | null;
    } | null;
  } | null;
}

/** What the window's queries returned; `foldDayClose` is the only thing that reads it. */
export interface WindowFacts {
  sales: SalesAggregate;
  payments: readonly WindowPayment[];
  paidOnSales: PaidAggregate;
  returns: readonly WindowReturn[];
}

export interface DayCloseFold {
  totals: DayCloseTotals;
  /** CASH taken at the till in the window (before the float) */
  tillCash: number;
  /** CASH refunds paid out of the drawer in the window */
  cashRefunds: number;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const CREDIT_APPLICATIONS: readonly string[] = ["CREDIT_NOTE", "ADVANCE"];

export function foldDayClose(facts: WindowFacts): DayCloseFold {
  const groups = new Map<string, number>();
  // One sale SET per order, built once for all its rows: the order's other grouped payments (the facts read them nested)
  // and the window's own rows of that order.
  const inWindow = new Map<string, WindowPayment[]>();
  for (const r of facts.payments) {
    const id = r.invoice?.orderId ?? "";
    inWindow.set(id, [...(inWindow.get(id) ?? []), r]);
  }
  const sets = new Map<string, TenderSet>();
  const saleSetOf = (p: WindowPayment): TenderSet => {
    const orderId = p.invoice?.orderId ?? "";
    let set = sets.get(orderId);
    if (!set) {
      const nested = (p.invoice?.order?.invoices ?? []).flatMap((i) => i.payments ?? []);
      set = tenderSetOf(orderId, [...nested, ...(inWindow.get(orderId) ?? [])]);
      sets.set(orderId, set);
    }
    return set;
  };
  let notAtTill = 0;
  let handOverCount = 0;
  let handOverCash = 0;
  for (const p of facts.payments) {
    if (p.status !== "PAID") continue; // sumConfirmed rule: PAID only
    const amount = num(p.amount);
    if (CREDIT_APPLICATIONS.includes(p.method)) {
      groups.set(p.method, roundMoney((groups.get(p.method) ?? 0) + amount));
    } else if (
      isCounterTenderRowIn(
        p.invoice?.orderId ?? "",
        p,
        { counterSale: p.invoice?.order?.counterSale },
        saleSetOf(p),
      )
    ) {
      groups.set(p.method, roundMoney((groups.get(p.method) ?? 0) + amount));
      // Only the NON-counter clause makes a POS pickup hand-over: a counter order's own pickup cash is ordinary counter till
      // cash (already in the groups above) and must not be counted a second time here (informational, never added to the money).
      if (p.invoice?.order?.counterSale !== true) {
        handOverCount += 1;
        if (p.method === "CASH") handOverCash = roundMoney(handOverCash + amount);
      }
    } else {
      notAtTill = roundMoney(notAtTill + amount);
    }
  }
  const payments: PaymentGroup[] = [...groups].map(([method, amount]) => ({
    method,
    _sum: { amount },
  }));
  const summary = foldSummary({
    sales: facts.sales,
    payments,
    paidOnSales: facts.paidOnSales,
    returns: facts.returns,
  });
  const unknownTenderCount = facts.returns.filter(
    (r) =>
      r.refundMethod === REFUND_METHOD_EXTERNAL && refundTenderOfColumn(r.refundTender) == null,
  ).length;
  const totals: DayCloseTotals = {
    salesCount: summary.sales.count,
    salesTotal: summary.sales.total,
    moneyIn: summary.moneyIn,
    refunds: { ...summary.refunds, unknownTenderCount },
    storeCreditUsed: summary.storeCreditUsed,
    storeCreditIssued: summary.storeCreditIssued,
    onAccount: summary.onAccount,
    netCollected: summary.netCollected,
    notAtTill,
    handOver: { count: handOverCount, cash: handOverCash },
  };
  return {
    totals,
    tillCash: totals.moneyIn.cash,
    cashRefunds: totals.refunds.cash,
  };
}

/** `expected = openingFloat + till cash - cash refunds`, to the cent. */
export function expectedCashOf(
  openingFloat: number,
  fold: Pick<DayCloseFold, "tillCash" | "cashRefunds">,
) {
  return roundMoney(openingFloat + fold.tillCash - fold.cashRefunds);
}
