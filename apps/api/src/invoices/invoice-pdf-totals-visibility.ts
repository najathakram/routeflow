/**
 * R6a: which lines of the invoice PDF's totals block print, decided in one pure place (the template is jest-mocked wholesale).
 * A switch hides LINES only, never a figure: the balance, paid, credit and advance values are computed before this and are
 * untouched. Credit issued / Advance applied never hide. Both switches off (absent) = today's output exactly.
 * Owner 2026-11-18 (box 02:22Z 11-19): Paid off also hides the PAID / PARTIAL stamp and the "Paid: {date}" line;
 * every other status stamp stays, since it says nothing about payment.
 */
export function pdfTotalsVisibility(x: {
  hideAmountPaid?: boolean | null;
  hideBalanceDue?: boolean | null;
  status?: string | null;
  totalPaid: number;
  paymentCount: number;
}) {
  return {
    amountPaidRow: !x.hideAmountPaid && x.totalPaid > 0,
    balanceDueRow: !x.hideBalanceDue,
    paymentHistory: !x.hideAmountPaid && x.paymentCount > 0,
    statusBadge: !(x.hideAmountPaid && (x.status === "PAID" || x.status === "PARTIAL")),
    paidDate: !x.hideAmountPaid,
  };
}
