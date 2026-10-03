import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { SplitInvoiceModal } from "./SplitInvoiceModal";

// The split-invoice preview prorates the stored subtotal, and falls back to a re-price only when
// the line has none. That fallback was `billQty * unitPrice` with hand-rolled rounding, which bills
// a boxed line (qty = pieces, unitPrice = BOX price) unitsPerBox times too much.

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
        {
          id: "li-1",
          productName: "Case of widgets",
          invoicedQty: 0,
          unit: "pc",
          ...item,
        } as any,
      ]}
    />,
  );
}

describe("SplitInvoiceModal — preview fallback is boxed-aware", () => {
  it("one box of 24 @ $12.90 with no stored subtotal previews $12.90, never $309.60", () => {
    renderModal({ qty: 24, unitPrice: 12.9, boxes: 1, pieces: 0, unitsPerBox: 24 });
    expect(screen.getAllByText("$12.90").length).toBeGreaterThan(0);
    expect(screen.queryByText("$309.60")).not.toBeInTheDocument();
  });

  it("two boxes + 6 loose pieces of a 24-pack @ $12.90 (no stored subtotal) previews $29.03", () => {
    // 2.25 boxes x 12.90 = 29.025 -> half-away-from-zero 29.03
    renderModal({ qty: 54, unitPrice: 12.9, boxes: 2, pieces: 6, unitsPerBox: 24 });
    expect(screen.getAllByText("$29.03").length).toBeGreaterThan(0);
  });

  it("a stored subtotal is still the basis when present", () => {
    renderModal({ qty: 24, unitPrice: 12.9, subtotal: 11.5, boxes: 1, pieces: 0, unitsPerBox: 24 });
    // default billed qty = remaining = 24 -> the full stored subtotal
    expect(screen.getAllByText("$11.50").length).toBeGreaterThan(0);
  });
});
