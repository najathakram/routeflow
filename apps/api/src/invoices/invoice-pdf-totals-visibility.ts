/**
 * R6a: which lines of the invoice PDF's totals block print, decided in one pure place (the template is jest-mocked wholesale).
 * A switch hides LINES only, never a figure: the balance, paid, credit and advance values are computed before this and are
 * untouched. Credit issued / Advance applied never hide. Both switches off (absent) = today's output exactly.
 */
export function pdfTotalsVisibility(x: {
  hideAmountPaid?: boolean | null;
  hideBalanceDue?: boolean | null;
  totalPaid: number;
  paymentCount: number;
}) {
  return {
    amountPaidRow: !x.hideAmountPaid && x.totalPaid > 0,
    balanceDueRow: !x.hideBalanceDue,
    paymentHistory: !x.hideAmountPaid && x.paymentCount > 0,
  };
}
