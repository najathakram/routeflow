import { invoiceItem } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/** SA-827 P5: the buyer invoice renders a composed box as its component pieces when the
 * line's displayUnit is "pieces", and keeps today's layout (with "(included)" sub-lines) otherwise. */
const comps = [
  {
    componentProductId: "a1",
    name: "Acme Alpha",
    qty: 10,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: 0.63,
    position: 0,
  },
  {
    componentProductId: "a2",
    name: "Acme Beta",
    qty: 20,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: 0.63,
    position: 1,
  },
];
const boxLine = {
  id: "item-1",
  description: "Acme Mixed Box",
  qty: 30,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 15,
  unitPrice: 30.01,
  subtotal: 60.02,
  notes: "Leave at the back door",
  msrp: 4.99,
  promoFreeUnits: 2,
  components: comps,
};

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

const pieceUnit = { kind: "pieces", label: "Piece" } as const;

function show(item: ReturnType<typeof invoiceItem>) {
  mockUseBuyerInvoice.mockReturnValue({
    data: makeInvoice([item]),
    isLoading: false,
    isError: false,
  });
  renderWithProviders(<Page />);
}

describe("buyer invoice detail — display units (SA-827)", () => {
  it("components: rows first, then the box's own row WITH its notes/MSRP/free note and amount, then the tax row", () => {
    show(
      invoiceItem({
        ...boxLine,
        categoryTaxAmount: 3.5,
        trackedCategory: { name: "Tobacco" },
        displayUnit: pieceUnit,
      }),
    );
    const a1 = screen.getByTestId("display-row-item-1-a1");
    const a2 = screen.getByTestId("display-row-item-1-a2");
    const group = screen.getByTestId("display-group-row-item-1");
    const tax = screen.getByTestId("display-category-tax-item-1");
    expect(a1).toHaveTextContent("10 Pieces");
    expect(a1).toHaveTextContent("$20.01");
    expect(a2).toHaveTextContent("$40.01");
    // the box's own row is kept in full
    expect(group).toHaveTextContent("Acme Mixed Box");
    expect(group).toHaveTextContent("Leave at the back door");
    expect(group).toHaveTextContent("MSRP $4.99/pc");
    expect(group).toHaveTextContent("2 free");
    expect(screen.getByTestId("invoice-line-subtotal-item-1")).toHaveTextContent("$60.02");
    expect(screen.queryByTestId("display-group-total-item-1")).toBeNull();
    expect(screen.queryByText(/\(included\)/)).toBeNull();
    expect(tax).toHaveTextContent("Tobacco tax");
    expect(tax).toHaveTextContent("$3.50");
    const before = (x: HTMLElement, y: HTMLElement) =>
      Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(a1, a2)).toBe(true);
    expect(before(a2, group)).toBe(true);
    expect(before(group, tax)).toBe(true);
    // small-screen labels follow today's pattern
    expect(a1.querySelector('[data-label="Qty"]')).not.toBeNull();
  });

  it("pieces: today's row with only qty and unit price swapped; notes, MSRP, free note and amount stay", () => {
    show(invoiceItem({ ...boxLine, components: null, displayUnit: pieceUnit }));
    expect(screen.getByTestId("invoice-line-qty-item-1")).toHaveTextContent("30 Pieces");
    expect(screen.getByTestId("invoice-line-qty-item-1")).toHaveTextContent("2 free");
    expect(screen.getByTestId("invoice-line-unit-item-1")).toHaveTextContent("$2.0007");
    expect(screen.getByTestId("invoice-line-unit-item-1")).toHaveTextContent("MSRP $4.99/pc");
    expect(screen.getByTestId("invoice-line-subtotal-item-1")).toHaveTextContent("$60.02");
    expect(screen.getByText("Leave at the back door")).toBeInTheDocument();
  });

  it("legacy: keeps today's row and prints the (included) sub-lines", () => {
    show(invoiceItem({ ...boxLine, displayUnit: { kind: "legacy", label: null } }));
    expect(screen.queryByTestId("display-row-item-1-a1")).toBeNull();
    expect(screen.getByTestId("invoice-line-subtotal-item-1")).toHaveTextContent("$60.02");
    expect(screen.getAllByTestId("line-component-sub-line")).toHaveLength(2);
    expect(screen.getAllByText(/\(included\)/)).toHaveLength(2);
  });

  it("pieces fallback (components do not sum to the line): still prints the (included) sub-lines", () => {
    show(invoiceItem({ ...boxLine, components: [comps[1]], displayUnit: pieceUnit }));
    expect(screen.getByTestId("invoice-line-qty-item-1")).toHaveTextContent("30 Pieces");
    expect(screen.getAllByTestId("line-component-sub-line")).toHaveLength(1);
    expect(screen.getByText(/\(included\)/)).toBeInTheDocument();
  });
});
