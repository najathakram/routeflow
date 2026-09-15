import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * B421: this page's Balance Due used `payments?.filter(p => p.status !==
 * "VOID")` (no method filter, and DRAFT counted as paid) instead of the
 * confirmed (status === "PAID", method-aware) basis every other surface
 * uses. Two distinct pre-existing bugs, both called out in the brief for
 * this surface specifically.
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
      {
        id: "item-1",
        description: "Widget",
        productId: "p1",
        qty: 1,
        unitPrice: 870,
        discount: 0,
        subtotal: 870,
        priceType: "STANDARD",
      },
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

/** The "Balance Due" summary card's own value text, scoped past the label so
 *  a coincidental match elsewhere (Subtotal/Total/Tax can share a figure with
 *  Balance Due, e.g. both "$0.00" or both the invoice total) never produces a
 *  false pass OR a spurious multi-match failure. */
function balanceDueText(): string | null {
  const label = screen.getByText("Balance Due");
  const card = label.closest(".rounded-xl");
  return card?.querySelector("p")?.textContent ?? null;
}

describe("buyer invoice detail — Balance Due (B421, REG-B421)", () => {
  it("REG-B421: a CREDIT_NOTE application reduces the balance, but is never counted as VOID-excluded cash", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({
        payments: [{ id: "pay-1", amount: 638, method: "CREDIT_NOTE", status: "PAID" }],
      }),
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<Page />);

    expect(balanceDueText()).toBe("$232.00");
  });

  it('REG-B421: a DRAFT (unconfirmed) payment must NOT reduce the balance -- the old `status !== "VOID"` filter let it through', () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({
        payments: [{ id: "pay-1", amount: 500, method: "CASH", status: "DRAFT" }],
      }),
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<Page />);

    expect(balanceDueText()).toBe("$870.00");
  });

  it("a confirmed CASH payment still reduces the balance normally", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({
        payments: [{ id: "pay-1", amount: 870, method: "CASH", status: "PAID" }],
      }),
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<Page />);

    expect(balanceDueText()).toBe("$0.00");
  });

  it("prefers the server's own balanceDue when present, ignoring the local payments array", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice({
        balanceDue: 50,
        payments: [{ id: "pay-1", amount: 999999, method: "CASH", status: "PAID" }],
      }),
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<Page />);

    expect(balanceDueText()).toBe("$50.00");
  });
});
