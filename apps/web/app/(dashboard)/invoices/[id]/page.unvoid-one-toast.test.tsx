import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import {
  expectOnlyThePageToasted,
  queryClientWithGlobalErrorToast,
  refusal,
} from "@/test-utils/global-error-toast";
import { API_ERROR_CODES, UNVOID_BILLING_COPY } from "@routeflow/types";
import InvoiceDetailPage from "./page";

/**
 * SA-814 / SA-814d: an unvoid the server refuses (409 ORDER_BILLING_CHANGED) raises ONE toast, the page's own
 * "Failed to unvoid", and its copy is picked from the body's `reason`, never from the message. `useUnvoidInvoice`'s
 * `meta.localErrorToast` keeps the app-wide "...Refresh and try again." toast quiet.
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
    useUnvoidInvoice: actual.useUnvoidInvoice, // the REAL hook: its meta is what is under test
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

const CASES = [
  ["OTHER_INVOICE", UNVOID_BILLING_COPY.OTHER_INVOICE],
  ["LINE_REDUCED", UNVOID_BILLING_COPY.LINE_REDUCED],
] as const;

describe("invoices/[id]: a refused unvoid raises exactly one toast (SA-814)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedSession("OPERATOR");
  });
  afterEach(() => seedSession(null));

  it.each(CASES)("%s: the page's one toast carries the reason's copy", async (reason, copy) => {
    // the message is deliberately NOT the copy: the page must read `reason`
    mockPost.mockRejectedValue(
      refusal(409, { code: API_ERROR_CODES.ORDER_BILLING_CHANGED, reason, message: "RAW" }),
    );
    renderWithProviders(<InvoiceDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(screen.getByRole("button", { name: "Unvoid" }));
    const buttons = screen.getAllByRole("button", { name: "Unvoid" });
    fireEvent.click(buttons[buttons.length - 1]);
    await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
      title: "Failed to unvoid",
      description: copy,
    });
  });

  it("a refusal with no reason keeps the server's message on the page's one toast", async () => {
    mockPost.mockRejectedValue(
      refusal(409, { code: API_ERROR_CODES.ORDER_BILLING_CHANGED, message: "SERVER_MSG" }),
    );
    renderWithProviders(<InvoiceDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(screen.getByRole("button", { name: "Unvoid" }));
    const buttons = screen.getAllByRole("button", { name: "Unvoid" });
    fireEvent.click(buttons[buttons.length - 1]);
    await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
      title: "Failed to unvoid",
      description: "SERVER_MSG",
    });
  });
});
