import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * W-769 (owner 7b = A, SA-910 Part 2 step 4, SA-922 answer 4): a payment row the api marks `noLongerFits` (an unconfirmed row
 * that real money displaced) shows the ONE flag sentence on the invoice page, with a Void action (Edit and Delete keep their
 * existing rules: never-lose-a-feature). Void goes through the EXISTING payment PATCH with `status: "VOID"`. A row that still fits shows
 * nothing new. Master: no sentence, and the invoice page has no Void action (the RED).
 */
const mockPatch = jest.fn();
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
    patch: (...a: unknown[]) => mockPatch(...a),
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
    useUpdateInvoicePayment: actual.useUpdateInvoicePayment, // the REAL hook: the Void PATCH goes through it
    useInvoice: () => ({
      data: {
        id: "inv-1",
        invoiceNumber: "INV-0021",
        status: "PAID",
        total: "100.00",
        paidAmount: "100.00",
        balanceDue: "0.00",
        issueDate: "2026-10-01T00:00:00.000Z",
        customer: { id: "c1", businessName: "Acme Foods" },
        items: [],
        payments: [
          {
            id: "pay-d",
            method: "CHECK",
            amount: "100.00",
            status: "DRAFT",
            reference: "2207",
            paidAt: "2026-10-01T00:00:00.000Z",
            createdAt: "2026-10-01T00:00:00.000Z",
            noLongerFits: true,
          },
          {
            id: "pay-cash",
            method: "CASH",
            amount: "100.00",
            status: "PAID",
            paidAt: "2026-10-02T00:00:00.000Z",
            createdAt: "2026-10-02T00:00:00.000Z",
            noLongerFits: false,
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

const FLAG = "No longer fits this invoice: void it or move it to the customer's credit.";

describe("invoices/[id]: an unconfirmed payment that no longer fits (W-769)", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => seedSession(null));

  it("positive control (green on master): the page renders the flagged DRAFT row (its check reference)", async () => {
    seedSession("OPERATOR");
    renderWithProviders(<InvoiceDetailPage />);
    expect(await screen.findByText(/2207/)).toBeInTheDocument();
  });

  it("the flagged DRAFT shows the ONE sentence once; the PAID row that displaced it shows nothing new", async () => {
    seedSession("OPERATOR");
    renderWithProviders(<InvoiceDetailPage />);
    expect(await screen.findAllByText(FLAG)).toHaveLength(1);
  });

  // The invoice is PAID (real money filled it), where master hides every row action: the flagged row still needs Void.
  it("Void is offered on the flagged row of a PAID invoice, and sends the existing payment PATCH with status VOID", async () => {
    seedSession("OPERATOR");
    mockPatch.mockResolvedValue({ data: { id: "inv-1" } });
    renderWithProviders(<InvoiceDetailPage />);
    await screen.findAllByText(FLAG);
    fireEvent.click(screen.getByTitle("Void payment"));
    const dialog = screen.queryByRole("dialog");
    if (dialog) fireEvent.click(within(dialog).getByRole("button", { name: /^void/i }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    const [url, body] = mockPatch.mock.calls[0];
    expect(url).toBe("/invoices/inv-1/payments/pay-d");
    expect(body).toMatchObject({ status: "VOID", amount: 100, method: "CHECK" });
  });
});
