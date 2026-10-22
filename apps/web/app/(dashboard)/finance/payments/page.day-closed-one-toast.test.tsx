import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import {
  expectOnlyThePageToasted,
  queryClientWithGlobalErrorToast,
  refusal,
} from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  COUNTER_SALE_DAY_CLOSED_COPY,
  DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
} from "@/lib/day-closed-copy";
import { clearPaymentKeyRegistry } from "@routeflow/types/payment-submit-key";
import FinancePaymentsPage from "./page";

/**
 * Row 348: a payment refused for a closed day raised TWO toasts on this page: the app-wide error toast AND the
 * page's own "Failed to ..." toast. The page owns the failure: the hooks' `meta.localErrorToast` keeps the global
 * one quiet, and the page's toast carries the closed-day copy. The REAL mutation hooks and the REAL global handler
 * run here; the page-local spy and the global spy are separate so a test says WHICH toast fired.
 */
const mockToast = jest.fn(); // the page-local toast (useToast)
const mockGlobalToast = jest.fn(); // the app-wide MutationCache handler
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(),
}));
const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: (...a: unknown[]) => mockPost(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoicePayments: () => ({
    data: {
      data: [
        {
          id: "pay-1",
          amount: 40,
          method: "CASH",
          status: "PAID",
          paymentNumber: "PAY-000001",
          createdAt: "2026-10-01T10:00:00.000Z",
          paidAt: "2026-10-01T10:00:00.000Z",
          invoice: {
            id: "inv-1",
            invoiceNumber: "INV-1",
            customerId: "cust-1",
            customer: { id: "cust-1", businessName: "Acme Foods" },
          },
        },
      ],
      meta: { total: 1, page: 1, limit: 25, totalPages: 1 },
    },
    isLoading: false,
  }),
  useInvoices: () => ({
    data: {
      data: [
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          status: "SENT",
          balanceDue: 100,
          issueDate: "2026-09-01",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Foods" }] } }),
}));

const DAY_CLOSED = refusal(409, {
  code: API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
  message: "RAW server sentence",
});
const render = () =>
  renderWithProviders(<FinancePaymentsPage />, {
    queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
  });

const CLOSED_DAY = [
  [
    "COUNTER_SALE_DAY_CLOSED",
    API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED,
    COUNTER_SALE_DAY_CLOSED_COPY,
  ],
  [
    "DAY_CLOSED_FOR_PAYMENT_DATE",
    API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE,
    DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
  ],
] as const;

const openRecordModal = () => {
  fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
  fireEvent.change(screen.getByDisplayValue("Select customer..."), { target: { value: "cust-1" } });
  fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
  fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));
};
const openVoidConfirm = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Void" }));
  fireEvent.click(await screen.findByRole("button", { name: "Void Payment" }));
};

describe("finance/payments: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry(); // SA-824: a refused attempt's key outlives the dialog; each test starts clean
  });

  it.each(CLOSED_DAY)(
    "Record Payment, %s: the page's one toast, the global one quiet",
    async (_n, code, copy) => {
      mockPost.mockRejectedValue(refusal(409, { code, message: "RAW server sentence" }));
      render();
      openRecordModal();

      await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
        title: "Failed to record payment",
        description: copy,
      });
      expect(mockPost).toHaveBeenCalledTimes(1);
    },
  );

  it.each(CLOSED_DAY)(
    "Void, %s: the page's one toast, the global one quiet",
    async (_n, code, copy) => {
      mockPatch.mockRejectedValue(refusal(409, { code, message: "RAW server sentence" }));
      render();
      await openVoidConfirm();

      await expectOnlyThePageToasted(mockToast, mockGlobalToast, {
        title: "Failed to void payment",
        description: copy,
      });
    },
  );

  it("any other failure keeps the page's own toast (the change is for the closed-day codes only)", async () => {
    mockPatch.mockRejectedValue(refusal(500, { message: "boom" }));
    render();
    await openVoidConfirm();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to void payment" }),
      ),
    );
  });
});
