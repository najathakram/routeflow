import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

// B1385: a draft payment cannot carry a leftover (it would become spendable credit), so "Save as draft" is
// disabled while an excess exists, with a hint; "Save as paid" stays enabled.

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
  useRecordPaymentStandalone: () => ({ mutateAsync: jest.fn(), isPending: false }),
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

function open() {
  renderWithProviders(<FinancePaymentsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /Record payment/i })[0]);
  fireEvent.change(screen.getByDisplayValue("Select customer…"), { target: { value: "cust-1" } });
}
const rowInput = () =>
  document.querySelector<HTMLInputElement>('input[type="number"][max]') as HTMLInputElement;

describe("finance/payments modal: no draft with a leftover (B1385)", () => {
  it("a $150 payment against a $100 invoice (a $50 leftover) disables Save as draft (with the hint); Save as paid stays enabled", () => {
    open();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "150" } });
    const draft = screen.getByRole("button", { name: "Save as draft" });
    expect(draft).toBeDisabled();
    expect(draft).toHaveAttribute("title", "Allocate the full amount to save as a draft");
    expect(screen.getByRole("button", { name: "Save as paid" })).toBeEnabled();
  });

  it("control: allocating the full $50 leaves no excess and Save as draft is enabled", () => {
    open();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    fireEvent.change(rowInput(), { target: { value: "50" } });
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeEnabled();
  });
});
