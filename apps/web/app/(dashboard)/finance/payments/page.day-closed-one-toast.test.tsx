import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import { COUNTER_SALE_DAY_CLOSED_COPY } from "@/lib/day-closed-copy";
import FinancePaymentsPage from "./page";

/**
 * Row 348: a payment refused with 409 COUNTER_SALE_DAY_CLOSED raised TWO toasts on this page: the app-wide
 * error toast ("This day has been closed...") AND the page's own "Failed to ..." toast. The code is mapped
 * globally, so the global one is the only one. The REAL mutation hooks and the REAL global handler run
 * here; one spy sees every toast.
 */
const mockToast = jest.fn();
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
    queryClient: queryClientWithGlobalErrorToast(mockToast),
  });

describe("finance/payments: a closed-day refusal raises exactly one toast (row 348)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("Record Payment: one toast, the app-wide fixed copy, no page-local 'Failed to record payment'", async () => {
    mockPost.mockRejectedValue(DAY_CLOSED);
    render();
    fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
    fireEvent.change(screen.getByDisplayValue("Select customer..."), {
      target: { value: "cust-1" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: COUNTER_SALE_DAY_CLOSED_COPY, variant: "error" }),
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("Void: one toast, the app-wide fixed copy, no page-local 'Failed to void payment'", async () => {
    mockPatch.mockRejectedValue(DAY_CLOSED);
    render();
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.click(await screen.findByRole("button", { name: "Void Payment" }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: COUNTER_SALE_DAY_CLOSED_COPY, variant: "error" }),
    );
  });

  it("any other failure keeps the page's own toast (the change is for the closed-day codes only)", async () => {
    mockPatch.mockRejectedValue(refusal(500, { message: "boom" }));
    render();
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.click(await screen.findByRole("button", { name: "Void Payment" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to void payment" }),
      ),
    );
  });
});
