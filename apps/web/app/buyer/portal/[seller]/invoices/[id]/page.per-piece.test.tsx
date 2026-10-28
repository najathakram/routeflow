import { invoiceItem } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/** SA-1029 W-R2: the buyer portal prints the per-piece price and the unit-aware Qty. */
function makeInvoice(items: BuyerInvoiceDetail["items"]): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "SENT",
    subtotal: 60.02,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 60.02,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-01-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    items,
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
  };
}

const mockUseBuyerInvoice = jest.fn((..._args: unknown[]) => ({
  data: makeInvoice([]),
  isLoading: false,
  isError: false,
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { id: "seller-1", slug: "acme" }, isLoading: false }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerInvoice: (...args: unknown[]) => mockUseBuyerInvoice(...args),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

const packLine = {
  id: "item-1",
  productId: "p1",
  description: "Acme Pack",
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 48,
  subtotal: 96,
  components: null,
  displayUnit: { kind: "legacy", label: null },
};

function show(item: ReturnType<typeof invoiceItem>) {
  mockUseBuyerInvoice.mockReturnValue({
    data: makeInvoice([item]),
    isLoading: false,
    isError: false,
  });
  renderWithProviders(<Page />);
}

describe("SA-1029 buyer portal invoice: per-piece price", () => {
  it("W-R2: Per piece header, $2.00/pc, and Qty reads 2 boxes", () => {
    show(invoiceItem({ ...packLine, perBaseUnit: { price: 2, unit: "pc" } } as never));
    expect(screen.getAllByText("Per piece").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$2.00/pc").length).toBeGreaterThan(0);
    expect(screen.getByTestId("invoice-line-qty-item-1")).toHaveTextContent("2 boxes");
  });

  it("G-1: a loose-only invoice has no Per piece column", () => {
    show(
      invoiceItem({
        ...packLine,
        boxes: 0,
        pieces: 3,
        qty: 3,
        unitsPerBox: 1,
        perBaseUnit: null,
      } as never),
    );
    expect(screen.queryByText("Per piece")).toBeNull();
  });

  it("G-4: the pieces layout prints no per-piece cell", () => {
    show(
      invoiceItem({
        ...packLine,
        displayUnit: { kind: "pieces", label: "Piece" },
        perBaseUnit: { price: 2, unit: "pc" },
      } as never),
    );
    expect(screen.queryByText("$2.00/pc")).toBeNull();
  });
});
