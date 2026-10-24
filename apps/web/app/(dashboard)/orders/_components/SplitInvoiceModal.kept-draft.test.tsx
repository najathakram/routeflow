import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { toSplitInvoiceLine } from "@/lib/split-invoice-line";
import { SplitInvoiceModal } from "./SplitInvoiceModal";

// Row 466: a split invoice that was created and then failed to send must open, not read as "could
// not create" (a retry would create a second one).

const mockMutate = jest.fn();
const mockToast = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreatePartialInvoiceFromOrder: () => ({ mutate: mockMutate, isPending: false }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

describe("SplitInvoiceModal — send failure after create (row 466)", () => {
  it("opens the kept invoice with the fixed copy when the error body carries invoiceId", async () => {
    mockMutate.mockClear();
    mockToast.mockClear();
    const onCreated = jest.fn();
    const onClose = jest.fn();
    renderWithProviders(
      <SplitInvoiceModal
        isOpen
        onClose={onClose}
        onCreated={onCreated}
        orderId="ord-1"
        orderNumber="ORD-1"
        items={[
          toSplitInvoiceLine(
            { id: "li-1", invoicedQty: 0, qty: 2, unitPrice: 5, subtotal: 10 } as any,
            "Widget",
          ),
        ]}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /create invoice/i }));
    const opts = mockMutate.mock.calls[0][1] as { onError: (e: unknown) => void };
    opts.onError({ response: { status: 400, data: { message: "raw", invoiceId: "inv-split" } } });

    expect(onCreated).toHaveBeenCalledWith("inv-split");
    expect(onClose).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Saved as a draft, not sent", variant: "warning" }),
    );
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain("raw");
  });
});
