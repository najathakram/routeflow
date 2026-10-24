import { invoiceItem, invoicePayment } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * Row 398: the buyer's invoice shows the regular tax and each regulated charge (deposit, excise) as their own named
 * tiles, the same lines the PDF prints, never the levy inside "Tax". The server computes them (regularTaxAmount,
 * chargeLines); an older server that sends neither falls back to the stored header as "Tax".
 */
function makeInvoice(overrides: Partial<BuyerInvoiceDetail> = {}): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "SENT",
    subtotal: 870,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 870,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-01-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    items: [
      invoiceItem({
        id: "item-1",
        description: "Widget",
        productId: "p1",
        qty: 1,
        unitPrice: 870,
        discount: 0,
        subtotal: 870,
        priceType: "STANDARD",
      }),
    ],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
    ...overrides,
  };
}

const mockUseBuyerInvoice = jest.fn((..._args: unknown[]) => ({
  data: makeInvoice(),
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

const tile = (key: string) => screen.queryByTestId(`invoice-tile-${key}`)?.textContent ?? null;

describe("buyer invoice detail: the levy is its own named charge (row 398)", () => {
  it("Tax is the regular tax and 'CRV deposit' is its own tile; the two add up to the stored header", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({
        subtotal: 31.48,
        taxAmount: 5.4,
        total: 36.88,
        regularTaxAmount: 2.6,
        chargeLines: [{ key: "cat-crv", label: "CRV deposit", amount: 2.8 }],
      }),
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<Page />);
    expect(tile("tax")).toBe("$2.60");
    expect(tile("charge-cat-crv")).toBe("$2.80");
    expect(screen.getByText("CRV deposit")).toBeInTheDocument();
    expect(tile("total")).toBe("$36.88");
  });

  it("an older server (no regularTaxAmount, no chargeLines) still shows the stored header as Tax", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({ subtotal: 31.48, taxAmount: 5.4, total: 36.88 }),
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<Page />);
    expect(tile("tax")).toBe("$5.40");
    expect(screen.queryByTestId(/^invoice-tile-charge-/)).toBeNull();
  });

  it("an exempt customer's invoice (no tax, no charge) shows a $0.00 Tax tile and no charge tile", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({ regularTaxAmount: 0, chargeLines: [] }),
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<Page />);
    expect(tile("tax")).toBe("$0.00");
    expect(screen.queryByTestId(/^invoice-tile-charge-/)).toBeNull();
  });
});
