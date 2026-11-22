import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * SA-1208 D1 / M1-03 (SA-1211 BF-6): every cash-type payment row on the invoice opens its receipt ("View receipt" to
 * /finance/payments/<id>), so "what did this check pay for" is one click from the invoice. A credit use is not a receipt and
 * has no link. The existing attached-image button no longer shares the words "View receipt" (it reads "View image").
 */
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: "inv-1" }),
  usePathname: () => "/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/invoices", () => {
  const actual = jest.requireActual("@/lib/api/invoices");
  const idle = () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
  });
  const hooks: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    if (/^use[A-Z]/.test(key)) hooks[key] = idle;
  }
  return {
    ...actual,
    ...hooks,
    useInvoice: () => ({
      data: {
        id: "inv-1",
        invoiceNumber: "INV-0021",
        status: "SENT",
        total: "4000.00",
        paidAmount: "3000.00",
        balanceDue: "1000.00",
        issueDate: "2026-10-01T00:00:00.000Z",
        customer: { id: "c1", businessName: "Acme Foods" },
        items: [],
        payments: [
          {
            id: "pay-chk",
            method: "CHECK",
            amount: "3000.00",
            status: "PAID",
            reference: "1001",
            imageKey: "k/1.jpg",
            paidAt: "2026-10-02T00:00:00.000Z",
            createdAt: "2026-10-02T00:00:00.000Z",
          },
          {
            id: "pay-adv",
            method: "ADVANCE",
            amount: "50.00",
            status: "PAID",
            paidAt: "2026-10-03T00:00:00.000Z",
            createdAt: "2026-10-03T00:00:00.000Z",
          },
        ],
        orderId: "o1",
      },
      isLoading: false,
      isError: false,
    }),
  };
});
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useUnapplyCreditNote: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomerAdvancePayments: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/lib/use-duplicate-invoice-action", () => ({
  useDuplicateInvoiceAction: () => ({ duplicate: jest.fn() }),
}));

describe("invoices/[id]: View receipt on a payment row (M1-03)", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => seedSession(null));

  it("links the check's row to its receipt, and only that row (a credit use is not a receipt)", async () => {
    seedSession("OPERATOR");
    renderWithProviders(<InvoiceDetailPage />);
    const links = await screen.findAllByRole("link", { name: "View receipt" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/finance/payments/pay-chk");
  });

  it("calls the attached photo 'View image', so 'View receipt' means one thing", async () => {
    seedSession("OPERATOR");
    renderWithProviders(<InvoiceDetailPage />);
    expect(await screen.findByRole("button", { name: /View image/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View receipt/ })).not.toBeInTheDocument();
  });
});
