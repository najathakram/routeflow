"use client";

import { formatReceiptMoney as money, roundMoney } from "@routeflow/pricing";

/**
 * The running "Total" row of the sale panel. R7b ruling: for cash, "Amount due" below already reads the total, so the row
 * hides while the two are equal to the cent (a tender in progress, a card sale or a differing figure shows it as
 * before). The figure stays in the DOM, visually hidden, for assistive tech and for the tests that read it.
 * SA-1066 F7: small above cash's big Amount due; on other methods it IS the big bottom figure.
 */
export function CounterRunningTotal({
  total,
  cash,
  due,
}: {
  total: number;
  cash: boolean;
  /** what the cash tender still owes (the "Amount due" figure) */
  due: number;
}) {
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
