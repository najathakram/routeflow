import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { toSplitInvoiceLine } from "@/lib/split-invoice-line";
import { SplitInvoiceModal } from "./SplitInvoiceModal";

// SA-1066 F04: typing more than is left snapped the box back to the remaining quantity without a word.
// The clamp stays; the box now says how much is left.
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreatePartialInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
}));

function renderModal(item: Record<string, unknown>) {
  renderWithProviders(
    <SplitInvoiceModal
      isOpen
      onClose={jest.fn()}
      orderId="ord-1"
      orderNumber="ORD-1"
      items={[
        toSplitInvoiceLine(
          { id: "li-1", invoicedQty: 0, product: { unit: "case" }, ...item } as any,
          "Chips",
        ),
      ]}
    />,
  );
  return screen.getByRole("spinbutton") as HTMLInputElement;
}

describe("SplitInvoiceModal: a quantity above what is left (F04)", () => {
  it("typing 5 with 1 left keeps the clamp at 1 and says 'Only 1 case left to invoice'", () => {
    const box = renderModal({ qty: 1, unitPrice: 18, subtotal: 18 });
    fireEvent.change(box, { target: { value: "5" } });
    expect(box.value).toBe("1");
    expect(screen.getByText("Only 1 case left to invoice")).toBeInTheDocument();
  });

  it("names the plural unit when more than one is left", () => {
    const box = renderModal({ qty: 3, unitPrice: 18, subtotal: 54 });
    fireEvent.change(box, { target: { value: "9" } });
    expect(box.value).toBe("3");
    expect(screen.getByText("Only 3 cases left to invoice")).toBeInTheDocument();
  });

  it("a quantity within what is left shows no message, and a valid one after an over clears it", () => {
    const box = renderModal({ qty: 3, unitPrice: 18, subtotal: 54 });
    fireEvent.change(box, { target: { value: "2" } });
    expect(screen.queryByText(/left to invoice/)).toBeNull();
    fireEvent.change(box, { target: { value: "9" } });
    expect(screen.getByText(/left to invoice/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "2" } });
    expect(screen.queryByText(/left to invoice/)).toBeNull();
  });

  it("the message is tied to its box", () => {
    const box = renderModal({ qty: 1, unitPrice: 18, subtotal: 18 });
    fireEvent.change(box, { target: { value: "5" } });
    const id = box.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toHaveTextContent("Only 1 case left to invoice");
  });
});
