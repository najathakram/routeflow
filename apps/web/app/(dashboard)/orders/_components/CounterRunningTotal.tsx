"use client";

import { formatReceiptMoney as money, roundMoney } from "@routeflow/pricing";

/**
 * The running "Total" row of the sale panel. R7b ruling: for cash, "Amount due" below already reads the total, so the row
 * hides while the two are equal to the cent (a tender in progress, a card sale or a differing figure shows it as
 * before). The figure stays in the DOM, visually hidden, for assistive tech and for the tests that read it.
 * SA-1066 F7: small above cash's big Amount due; on other methods it IS the big bottom figure.
 * SA-1211 A1.1 (VF-6): with a return on the sale, EVERY tender (On account included) reads one line, "Total $100.00 · Return
 * −$40.00 · Amount due $60.00". The three figures are the counter's own (`netOfReturn`): nothing is subtracted here.
 * SA-1231: on Cash the big `change-due` line below is the only "Amount due", so this line stops at "Return −$40.00".
 */
export function CounterRunningTotal({
  total,
  cash,
  due,
  returned = 0,
  payTotal = due,
}: {
  total: number;
  cash: boolean;
  /** what the cash tender still owes (the "Amount due" figure) */
  due: number;
  /** the return's worth (`netOfReturn`'s `returned`); 0 = no return on the sale */
  returned?: number;
  /** what the sale asks for after the return (`netOfReturn`'s `payTotal`), whatever the tender */
  payTotal?: number;
}) {
  if (returned > 0) {
    return (
      <div data-testid="estimated-total-row">
        <p
          className={cash ? "text-lg font-semibold" : "text-xl font-bold"}
          data-testid="running-total"
        >
          {`Total ${money(total)} · Return −${money(returned)}${cash ? "" : ` · Amount due ${money(payTotal)}`}`}
        </p>
      </div>
    );
  }
  if (cash && roundMoney(total) === roundMoney(due)) {
    return (
      <span className="sr-only" data-testid="running-total">
        Total {money(total)}
      </span>
    );
  }
  return (
    <div data-testid="estimated-total-row">
      <div
        className={
          cash
            ? "flex justify-between text-lg font-semibold"
            : "flex justify-between text-3xl font-bold"
        }
        data-testid="running-total"
      >
        <span>Total</span>
        <span>{money(total)}</span>
      </div>
    </div>
  );
}
