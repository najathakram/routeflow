import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import userEvent from "@testing-library/user-event";
import { seedSession } from "@/test-utils/session";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES, type RestrictionWarningError } from "@routeflow/types";
import InvoiceDetailPage from "./page";

/**
 * Row 460 (SA-272) on the invoice page: an unvoid re-sells the whole invoice, so a staff unvoid the API answers with
 * 409 RESTRICTION_WARNING opens the warning dialog (no toast), and "Sell anyway" re-sends the SAME unvoid with the ack
 * as its body. Without the client half the API's PASS verdict dead-ends: nobody could send the ack.
 */
const mockToast = jest.fn(); // the page-local toast (useToast)
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
const mockPost = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
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
    post: (...a: unknown[]) => mockPost(...a),
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
    useUnvoidInvoice: actual.useUnvoidInvoice, // the REAL hook: its body is what is under test
    useInvoice: () => ({
      data: {
        id: "inv-1",
        invoiceNumber: "INV-0014",
        status: "VOID",
        total: "35.00",
        paidAmount: "0.00",
        balanceDue: "0.00",
        issueDate: "2026-09-01T00:00:00.000Z",
        customer: { id: "c1", businessName: "Acme Foods" },
        items: [],
        payments: [],
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

const warning: RestrictionWarningError = {
  code: API_ERROR_CODES.RESTRICTION_WARNING,
  message: "Some items are restricted.",
  warningHash: "rw1:abc",
  lines: [
    {
      lineKey: "l:item-1",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK",
      rules: [
        { id: "r1", states: ["CA"], legal: true, reasonText: "Restricted in CA: State ban." },
      ],
    },
  ],
};
const ack = {
  restrictionOverrides: [{ lineKey: "l:item-1", reason: "Owner approved" }],
  warningHash: "rw1:abc",
};

function openUnvoidAndConfirm() {
  fireEvent.click(screen.getByRole("button", { name: "Unvoid" }));
  const buttons = screen.getAllByRole("button", { name: "Unvoid" });
  fireEvent.click(buttons[buttons.length - 1]);
}

describe("invoices/[id]: a warned unvoid (row 460)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedSession("OPERATOR");
  });
  afterEach(() => seedSession(null));

  it("warns with no toast, then re-sends the same unvoid with the ack as its body", async () => {
    mockPost.mockRejectedValueOnce(refusal(409, { ...warning })).mockResolvedValue({ data: {} });
    renderWithProviders(<InvoiceDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    openUnvoidAndConfirm();
    const user = userEvent.setup();
    expect(await screen.findByText("Acme Gummies")).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockGlobalToast).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[0]).toEqual(["/invoices/inv-1/unvoid"]);
    expect(mockPost.mock.calls[1]).toEqual(["/invoices/inv-1/unvoid", ack]);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Invoice unvoided — now a draft", variant: "success" }),
      ),
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "error" }));
  });

  it("an unvoid with nothing to warn about still posts with no body", async () => {
    mockPost.mockResolvedValue({ data: {} });
    renderWithProviders(<InvoiceDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    openUnvoidAndConfirm();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0]).toEqual(["/invoices/inv-1/unvoid"]);
  });
});
