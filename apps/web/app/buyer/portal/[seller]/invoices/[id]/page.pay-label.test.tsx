import { invoiceItem } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen, fireEvent } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/** UX guide B3: the pay button names the amount, not a promise about which invoice it settles. */
function makeInvoice(overrides: Record<string, unknown> = {}): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "SENT",
    subtotal: 60,
    balanceDue: 60,
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

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-1" }),
  useRouter: () => ({ push }),
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

describe("buyer invoice detail — pay button label (UX guide B3)", () => {
  beforeEach(() => push.mockClear());

  it("reads Pay <balance>, never Pay this invoice", () => {
    mockUseBuyerInvoice.mockReturnValue({ data: makeInvoice(), isLoading: false, isError: false });
    renderWithProviders(<Page />);
    expect(screen.getByRole("button", { name: "Pay $60.00" })).toBeInTheDocument();
    expect(screen.queryByText("Pay this invoice")).toBeNull();
  });

  it("guard: it still seeds the payments page with amount=60.00", () => {
    mockUseBuyerInvoice.mockReturnValue({ data: makeInvoice(), isLoading: false, isError: false });
    renderWithProviders(<Page />);
    fireEvent.click(screen.getByRole("button", { name: /^Pay / }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining("amount=60.00"));
  });
});
