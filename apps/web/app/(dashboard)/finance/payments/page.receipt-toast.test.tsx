import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

/**
 * SA-1208 D1 / M1-03 (SA-1211 BF-6): "What did it pay for?" has one place, the receipt. The success toast of the
 * Payments page's Record payment dialog links to it ("View receipt"), and the link opens the receipt of the payment the
 * server just wrote. A failure toast carries no such link, and the "Unallocated" line uses the word Credit (A1.4).
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(),
}));
const recordMutateAsync = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoicePayments: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } },
    isLoading: false,
  }),
  useVoidPayment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useExportPayments: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRecordPaymentStandalone: () => ({ mutateAsync: recordMutateAsync, isPending: false }),
  useUploadPaymentImage: () => ({ mutateAsync: jest.fn(), isPending: false }),
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

function openModalWithCustomer() {
  renderWithProviders(<FinancePaymentsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /Record payment/i })[0]);
  fireEvent.change(screen.getByDisplayValue("Select customer…"), { target: { value: "cust-1" } });
}

describe("Payments page Record payment: the success toast links to the receipt", () => {
  beforeEach(() => jest.clearAllMocks());

  it("carries View receipt, which opens the receipt of the payment just written", async () => {
    recordMutateAsync.mockResolvedValue({
      payments: [{ id: "pay-new" }, { id: "pay-other" }],
      paymentGroupId: "grp-1",
      excess: 0,
    });
    openModalWithCustomer();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as paid" }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" })),
    );
    const toast = mockToast.mock.calls.find((c) => c[0].variant === "success")![0];
    expect(toast.title).toBe("Payment recorded");
    expect(toast.action?.label).toBe("View receipt");
    toast.action.onClick();
    expect(mockPush).toHaveBeenCalledWith("/finance/payments/pay-new");
  });

  it("a failed save has no View receipt link", async () => {
    recordMutateAsync.mockRejectedValue({ response: { status: 500, data: {} } });
    openModalWithCustomer();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as paid" }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to record payment" }),
      ),
    );
    expect(mockToast.mock.calls.some((c) => c[0].action?.label === "View receipt")).toBe(false);
  });

  it("calls the part of a payment no invoice took credit, not 'Unallocated (→ advance)'", () => {
    openModalWithCustomer();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "500" } });
    expect(screen.getByText(/Kept as credit/)).toBeInTheDocument();
    expect(screen.queryByText(/Unallocated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/advance/i)).not.toBeInTheDocument();
  });
});
