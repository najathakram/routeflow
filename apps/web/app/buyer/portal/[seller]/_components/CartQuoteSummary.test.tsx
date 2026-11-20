import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CartQuoteSummary } from "./CartQuoteSummary";

/**
 * SA-1172 K7: the client's "Promotion savings" row shows only while the client subtotal agrees with the quote's (within 1 cent);
 * a quote that disagrees owns every money row, and a row showing savings the quote does not carry would be a second number.
 */
const base = {
  busy: false,
  merging: false,
  unresolvedCount: 0,
  subtotalLabel: "Subtotal (3 items)",
};

describe("CartQuoteSummary: promotion savings follow the quote (K7)", () => {
  it("hides the savings row when the quote subtotal disagrees with the client subtotal", () => {
    render(
      <CartQuoteSummary
        {...base}
        quote={{ subtotal: 30, tax: 2.48, levy: 0, total: 32.48, taxExempt: false }}
        clientSubtotal={31.2}
        savings={4}
      />,
    );
    expect(screen.queryByText("Promotion savings")).toBeNull();
    expect(screen.getByText("$30.00")).toBeInTheDocument();
  });

  it("shows the savings row when the quote subtotal agrees within a cent", () => {
    render(
      <CartQuoteSummary
        {...base}
        quote={{ subtotal: 31.2, tax: 2.57, levy: 0, total: 33.77, taxExempt: false }}
        clientSubtotal={31.205}
        savings={4}
      />,
    );
    expect(screen.getByText("Promotion savings")).toBeInTheDocument();
  });

  it("with no quote the client savings show (the fallback)", () => {
    render(<CartQuoteSummary {...base} quote={undefined} clientSubtotal={31.2} savings={4} />);
    expect(screen.getByText("Promotion savings")).toBeInTheDocument();
  });
});
