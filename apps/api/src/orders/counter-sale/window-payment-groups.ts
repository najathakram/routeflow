import { roundMoney } from "@routeflow/pricing";
import { isCounterTenderRow } from "./counter-tender-row";

/**
 * The ONE classification of a PAID payment row read in a window, shared by the day close's fold and Today's sales' summary, so
 * "money in" cannot mean two things (row 374 a). A row is exactly one of:
 *  - a credit APPLICATION (CREDIT_NOTE / ADVANCE): store credit used, never money in;
 *  - a counter TENDER row (`isCounterTenderRow`, told the order's kind): money in by method, till money;
 *  - anything else on the register's invoices (an office payment with its own group id, a deposited check, an ACH): `notAtTill`.
 * A POS pickup hand-over (a tender row on a NON-counter order) is also counted: distinct orders, and the CASH of them. A
 * counter order's own pickup-group cash is ordinary counter till cash and is never counted as a hand-over a second time.
 */
export interface WindowPaymentRow {
  amount: unknown;
  method: string;
  status: string;
  paymentGroupId?: string | null;
  checkStatus?: string | null;
  invoice?: { orderId: string | null; order?: { counterSale: boolean | null } | null } | null;
}

export interface WindowPaymentGroups {
  /** method -> amount: money in by method, plus the credit applications under their own method names */
  byMethod: Map<string, number>;
  /** the sum of the rows that are not till money and not a credit application */
  notAtTill: number;
  /** POS pickup hand-overs: DISTINCT orders, and their CASH */
  handOver: { count: number; cash: number };
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const CREDIT_APPLICATIONS: readonly string[] = ["CREDIT_NOTE", "ADVANCE"];

export function groupWindowPayments(payments: readonly WindowPaymentRow[]): WindowPaymentGroups {
  const byMethod = new Map<string, number>();
  const handOverOrders = new Set<string>();
  let notAtTill = 0;
  let handOverCash = 0;
  for (const p of payments) {
    if (p.status !== "PAID") continue; // sumConfirmed rule: PAID only
    const amount = num(p.amount);
    if (CREDIT_APPLICATIONS.includes(p.method)) {
      byMethod.set(p.method, roundMoney((byMethod.get(p.method) ?? 0) + amount));
    } else if (
      isCounterTenderRow(p.invoice?.orderId ?? "", p, {
        counterSale: p.invoice?.order?.counterSale,
      })
    ) {
      byMethod.set(p.method, roundMoney((byMethod.get(p.method) ?? 0) + amount));
      if (p.invoice?.order?.counterSale !== true) {
        handOverOrders.add(p.invoice?.orderId ?? "");
        if (p.method === "CASH") handOverCash = roundMoney(handOverCash + amount);
      }
    } else {
      notAtTill = roundMoney(notAtTill + amount);
    }
  }
  return {
    byMethod,
    notAtTill,
    handOver: { count: handOverOrders.size, cash: handOverCash },
  };
}
