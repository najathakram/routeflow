import * as React from "react";
import { render, screen } from "@testing-library/react";
import { CustomerToCollectChip } from "./CustomerToCollectChip";

/**
 * SA-1026 A: the customer detail's To collect chip: the count and the existing balance due of the customer's To collect
 * invoices, from the staff statement (the server sums them; no money math here). It links to that customer's To collect list.
 */
describe("CustomerToCollectChip", () => {
  it("shows the word, the count and the sum, and links to the filtered invoice list", () => {
    render(<CustomerToCollectChip customerId="c1" summary={{ count: 2, balance: 260.3 }} />);
    const link = screen.getByRole("link", { name: /To collect/ });
    expect(link).toHaveTextContent("To collect");
    expect(link).toHaveTextContent("2");
    expect(link).toHaveTextContent("$260.30");
    expect(link).toHaveAttribute("href", "/invoices?customerId=c1&toCollect=true");
  });

  it("nothing for a count of 0 or no summary (an older server, a buyer read)", () => {
    const { container, rerender } = render(
      <CustomerToCollectChip customerId="c1" summary={{ count: 0, balance: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<CustomerToCollectChip customerId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
