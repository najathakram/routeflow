import * as React from "react";
import { render, screen } from "@testing-library/react";
import { InvoicedEditNotice } from "./InvoicedEditNotice";

/** O7: one inline line on an invoiced order; nothing otherwise. */
describe("InvoicedEditNotice (O7)", () => {
  it("names the invoice and says saving marks it for review", () => {
    render(<InvoicedEditNotice invoices={[{ invoiceNumber: "INV-2026-0003", status: "DRAFT" }]} />);
    expect(screen.getByTestId("invoiced-edit-notice")).toHaveTextContent(
      "This order is invoiced (INV-2026-0003). Saving changes marks the invoice for review.",
    );
  });

  it("lists several invoices and pluralises", () => {
    render(
      <InvoicedEditNotice
        invoices={[
          { invoiceNumber: "INV-1", status: "SENT" },
          { invoiceNumber: "INV-2", status: "PAID" },
        ]}
      />,
    );
    expect(screen.getByTestId("invoiced-edit-notice")).toHaveTextContent(
      "(INV-1, INV-2). Saving changes marks the invoices for review.",
    );
  });

  it.each([[undefined], [null], [[]], [[{ invoiceNumber: "INV-9", status: "VOID" }]]])(
    "renders nothing without a live invoice (%j)",
    (invoices) => {
      const { container } = render(<InvoicedEditNotice invoices={invoices as never} />);
      expect(container).toBeEmptyDOMElement();
    },
  );
});
