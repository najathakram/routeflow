import * as React from "react";
import { render, screen } from "@testing-library/react";
import { InvoiceRevisionMarks } from "./InvoiceRevisionMarks";

describe("InvoiceRevisionMarks", () => {
  it("renders nothing when the API sends neither field (contract-first)", () => {
    const { container } = render(<InvoiceRevisionMarks />);
    expect(container).toBeEmptyDOMElement();
  });
  it("renders the Revised badge", () => {
    render(<InvoiceRevisionMarks revisedAt="2026-10-05T15:30:00.000Z" />);
    expect(screen.getByTestId("invoice-revised-badge")).toHaveTextContent(/^Revised \w{3} \d/);
  });
  it("renders Overpaid by only when > 0", () => {
    const { rerender } = render(<InvoiceRevisionMarks overpaidBy={0} />);
    expect(screen.queryByTestId("invoice-overpaid")).toBeNull();
    rerender(<InvoiceRevisionMarks overpaidBy={7.5} />);
    expect(screen.getByTestId("invoice-overpaid")).toHaveTextContent("Overpaid by $7.50");
  });
});
