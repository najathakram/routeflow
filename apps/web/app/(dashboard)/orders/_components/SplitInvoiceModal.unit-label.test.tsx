import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { toSplitInvoiceLine } from "@/lib/split-invoice-line";
import { SplitInvoiceModal } from "./SplitInvoiceModal";

// Row 694 (F01): a boxed line stores qty in PIECES (3 cases of 12 = 36); the Remaining cell printed "36 case".
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreatePartialInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
}));

function renderModal(item: Record<string, unknown>) {
  return renderWithProviders(
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
}

describe("SplitInvoiceModal remaining unit label (F01)", () => {
  it("a boxed line (3 cases of 12 = 36) never reads '36 case'; it names the pieces", () => {
    renderModal({ qty: 36, unitPrice: 18, subtotal: 54, boxes: 3, pieces: 0, unitsPerBox: 12 });
    expect(screen.queryByText(/36\s+cases?$/i)).toBeNull();
    expect(screen.getByText(/^36\s+(pcs?|pieces?)$/i)).toBeInTheDocument();
  });

  it("a line without box fields keeps its own unit: '2 case'", () => {
    renderModal({ qty: 2, unitPrice: 18, subtotal: 36 });
    expect(screen.getByText("2 case")).toBeInTheDocument();
  });
});
