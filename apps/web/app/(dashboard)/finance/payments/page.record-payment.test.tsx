import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

// REG-B1002: the finance/payments "Record Payment" modal is one of three record-payment UIs and
// the only one missing the B313 over-allocation guards the others have — it stored whatever was
// typed in a row (past the invoice's balance), never compared the rows with the amount received,
// and showed the server's raw `message` in its failure toast. These pin all three.

const recordMutateAsync = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(),
}));

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
  fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
  fireEvent.change(screen.getByDisplayValue("Select customer..."), {
    target: { value: "cust-1" },
  });
}

// The allocation row's input is the only number input carrying a `max` attribute.
const rowInput = () =>
  document.querySelector<HTMLInputElement>('input[type="number"][max]') as HTMLInputElement;

describe("finance/payments RecordPaymentModal — over-allocation guards (REG-B1002)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clamps an allocation typed past the invoice's balance down to the balance", () => {
    openModalWithCustomer();
    fireEvent.change(rowInput(), { target: { value: "500" } });
    // Before the fix the raw "500" was stored (invoice balance is 100).
    expect(rowInput().value).toBe("100");
  });

  it("blocks Save when the allocations add up to more than the amount received", async () => {
    openModalWithCustomer();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.change(rowInput(), { target: { value: "80" } });

    expect(screen.getByText(/Allocated more than received/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save as Paid" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(recordMutateAsync).not.toHaveBeenCalled();
  });

  it("shows fixed copy, never the server's raw message, when recording fails", async () => {
    recordMutateAsync.mockRejectedValue({
      response: { status: 500, data: { message: "RAW-SERVER-TEXT prisma blew up" } },
    });
    openModalWithCustomer();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));

    await waitFor(() => expect(screen.getByText("Failed to record payment")).toBeInTheDocument());
    expect(screen.queryByText(/RAW-SERVER-TEXT/)).not.toBeInTheDocument();
  });
});
