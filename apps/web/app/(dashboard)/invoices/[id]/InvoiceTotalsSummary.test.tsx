import { render, screen } from "@testing-library/react";
import { InvoiceTotalsSummary, type InvoiceTotalsSummaryProps } from "./InvoiceTotalsSummary";

/**
 * The client's actual report (B421): a credit-note application rendered as
 * "Paid to date -$638.00" / "Paid $638.00" although the customer never paid
 * anything. These assertions pin the fixed wording directly against the
 * rendered DOM — the money-correctness math itself is covered by
 * `@routeflow/pricing`'s payment-confirmation.spec.ts; this file is only
 * about what the operator actually reads.
 */
const BASE: InvoiceTotalsSummaryProps = {
  subtotal: 870,
  discount: 0,
  taxAmount: 0,
  shippingFee: 0,
  amountPaid: 0,
  creditApplied: 0,
  advanceApplied: 0,
  balanceDue: 870,
};

describe("InvoiceTotalsSummary wording (B421, REG-B421)", () => {
  it("a credit-note-only invoice shows 'Payments received $0.00' and 'Credits applied', never a bare 'Paid'", () => {
    render(<InvoiceTotalsSummary {...BASE} creditApplied={638} balanceDue={232} />);

    expect(screen.getByText("Payments received")).toBeInTheDocument();
    expect(screen.getByText("-$0.00")).toBeInTheDocument();
    expect(screen.getByText("Credits applied")).toBeInTheDocument();
    expect(screen.getByText("-$638.00")).toBeInTheDocument();
    expect(screen.getByText("$232.00")).toBeInTheDocument();
    // The pre-fix wording must be completely gone -- not relabeled, not still
    // present alongside the new lines.
    expect(screen.queryByText("Paid to date")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Paid$/)).not.toBeInTheDocument();
  });

  it("an advance-only invoice shows 'Payments received $0.00' and 'Advance applied'", () => {
    render(<InvoiceTotalsSummary {...BASE} advanceApplied={100} balanceDue={770} />);

    expect(screen.getByText("Payments received")).toBeInTheDocument();
    expect(screen.getByText("-$0.00")).toBeInTheDocument();
    expect(screen.getByText("Advance applied")).toBeInTheDocument();
    expect(screen.getByText("-$100.00")).toBeInTheDocument();
  });

  it("a cash + credit invoice shows both lines with their own correct figures", () => {
    render(<InvoiceTotalsSummary {...BASE} amountPaid={232} creditApplied={638} balanceDue={0} />);

    expect(screen.getByText("Payments received")).toBeInTheDocument();
    expect(screen.getByText("-$232.00")).toBeInTheDocument();
    expect(screen.getByText("Credits applied")).toBeInTheDocument();
    expect(screen.getByText("-$638.00")).toBeInTheDocument();
  });

  it("an all-cash invoice with no credit/advance shows only 'Payments received' -- no credit/advance line at all", () => {
    render(<InvoiceTotalsSummary {...BASE} amountPaid={870} balanceDue={0} />);

    expect(screen.getByText("Payments received")).toBeInTheDocument();
    expect(screen.queryByText("Credits applied")).not.toBeInTheDocument();
    expect(screen.queryByText("Advance applied")).not.toBeInTheDocument();
  });

  it("an unpaid invoice with no confirmed activity at all shows none of the three lines", () => {
    render(<InvoiceTotalsSummary {...BASE} />);

    expect(screen.queryByText("Payments received")).not.toBeInTheDocument();
    expect(screen.queryByText("Credits applied")).not.toBeInTheDocument();
    expect(screen.queryByText("Advance applied")).not.toBeInTheDocument();
  });
});
