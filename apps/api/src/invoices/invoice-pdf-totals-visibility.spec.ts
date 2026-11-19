import { pdfTotalsVisibility } from "./invoice-pdf-totals-visibility";

// T10b (R6a): the PDF's totals-block decisions live in one pure helper because the template is jest-mocked wholesale.
describe("pdfTotalsVisibility (T10b)", () => {
  const paid = { totalPaid: 50, paymentCount: 2 };

  it("both switches on (absent) = today's output: Amount Paid row, Balance Due row, Payment History", () => {
    const today = {
      amountPaidRow: true,
      balanceDueRow: true,
      paymentHistory: true,
      statusBadge: true,
      paidDate: true,
    };
    expect(pdfTotalsVisibility({ ...paid })).toEqual(today);
    expect(pdfTotalsVisibility({ ...paid, hideAmountPaid: false, hideBalanceDue: false })).toEqual(
      today,
    );
  });

  it("paid off hides the Amount Paid row AND the Payment History block, not the Balance Due row", () => {
    expect(pdfTotalsVisibility({ ...paid, hideAmountPaid: true })).toEqual({
      amountPaidRow: false,
      balanceDueRow: true,
      paymentHistory: false,
      statusBadge: true,
      paidDate: false,
    });
  });

  it("balance off hides only the Balance Due row", () => {
    expect(pdfTotalsVisibility({ ...paid, hideBalanceDue: true })).toEqual({
      amountPaidRow: true,
      balanceDueRow: false,
      paymentHistory: true,
      statusBadge: true,
      paidDate: true,
    });
  });

  it("keeps today's own conditions: nothing paid means no Amount Paid row, no payments means no history", () => {
    expect(pdfTotalsVisibility({ totalPaid: 0, paymentCount: 0 })).toEqual({
      amountPaidRow: false,
      balanceDueRow: true,
      paymentHistory: false,
      statusBadge: true,
      paidDate: true,
    });
  });

  // Owner 2026-11-18 (box 02:22Z 11-19): Paid off hides the PAID / PARTIAL stamp and the paid date.
  it.each([
    ["PAID", false],
    ["PARTIAL", false],
    ["SENT", true],
    ["OVERDUE", true],
    ["VOID", true],
  ])("paid off: the %s stamp shows=%s; the paid date never shows", (status, shown) => {
    const v = pdfTotalsVisibility({ ...paid, status: status as string, hideAmountPaid: true });
    expect(v.statusBadge).toBe(shown);
    expect(v.paidDate).toBe(false);
    expect(pdfTotalsVisibility({ ...paid, status: status as string }).statusBadge).toBe(true);
  });
});
