import { invoiceItem } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * Row 401: a counter sale paid at the till is settled when it is rung, so the buyer's copy shows no due date, no
 * payment terms and no "Terms & Conditions" that is only the payment terms. The server answers `paidAtSale`; any
 * other invoice keeps all three, and a real long-form T&C text stays either way.
 */
function makeInvoice(overrides: Record<string, unknown> = {}): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "PAID",
    subtotal: 10,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 10,
    dueDate: "2026-11-06",
    sentAt: null,
    viewedAt: null,
    paidAt: "2026-10-07",
    issueDate: "2026-10-07",
    pdfUrl: null,
    notes: null,
    terms: "Net 30",
    paymentTermsLabel: "Net 30",
    orderId: null,
    items: [
      invoiceItem({
        id: "item-1",
        description: "Mango Juice",
        productId: "p1",
        qty: 1,
        unitPrice: 10,
        discount: 0,
        subtotal: 10,
        priceType: "STANDARD",
        notes: null,
      }),
    ],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
    ...overrides,
  } as unknown as BuyerInvoiceDetail;
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

const show = (over: Record<string, unknown>) => {
  mockUseBuyerInvoice.mockReturnValue({
    data: makeInvoice(over),
    isLoading: false,
    isError: false,
  });
  renderWithProviders(<Page />);
};

describe("buyer invoice detail — paid at sale (row 401)", () => {
  it("paid at sale: no due date, no Terms line, no T&C block that is only the payment terms", () => {
    show({ paidAtSale: true });
    expect(screen.getByText(/Issued/)).toBeInTheDocument();
    expect(screen.queryByText(/Due /)).toBeNull();
    expect(screen.queryByText(/Terms:/)).toBeNull();
    expect(screen.queryByText(/Terms & Conditions/)).toBeNull();
    expect(screen.queryByText("Net 30")).toBeNull();
  });

  it("paid at sale: a real long-form T&C text stays", () => {
    show({ paidAtSale: true, terms: "All sales final." });
    expect(screen.getByText("All sales final.")).toBeInTheDocument();
    expect(screen.queryByText(/Due /)).toBeNull();
  });

  it("paid at sale: the deposit schedule (its remainder is a due date) goes too; otherwise it shows", () => {
    const dep = { depositPercent: 25, depositDueDate: "2026-10-07", depositAmount: 2.5 };
    show({ ...dep, paidAtSale: true });
    expect(screen.queryByText(/Remainder due/)).toBeNull();
  });

  it("any other invoice keeps its deposit schedule", () => {
    show({
      depositPercent: 25,
      depositDueDate: "2026-10-07",
      depositAmount: 2.5,
      paidAtSale: false,
    });
    expect(screen.getByText(/Remainder due/)).toBeInTheDocument();
  });

  it("any other invoice keeps its due date, terms line and T&C", () => {
    show({ paidAtSale: false });
    expect(screen.getByText(/Due /)).toBeInTheDocument();
    expect(screen.getByText(/Terms: Net 30/)).toBeInTheDocument();
    expect(screen.getByText("Net 30")).toBeInTheDocument();
  });
});
