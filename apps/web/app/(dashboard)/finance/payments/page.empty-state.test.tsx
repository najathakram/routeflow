import * as React from "react";
import { fireEvent, screen, renderWithProviders } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

/**
 * UX guide B-11 part 1 (payments walk F06, P28, P22, P23): a list with no payments at all is one calm
 * message and one action; a list filtered down to nothing keeps its filters and says so.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }), post: jest.fn() },
}));

const mockUsePayments = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoicePayments: (...a: unknown[]) => mockUsePayments(...a),
  useInvoices: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Foods" }] } }),
}));

const EMPTY = {
  data: {
    data: [],
    meta: { total: 0, page: 1, limit: 25, totalPages: 1 },
    summary: { totalReceived: 0, count: 0, advanceBalance: 0 },
  },
  isLoading: false,
};

const ONE = {
  data: {
    data: [
      {
        id: "pay-a",
        paymentNumber: "PAY-A",
        amount: 40,
        method: "CASH",
        status: "PAID",
        createdAt: "2026-10-01T10:00:00.000Z",
        paidAt: "2026-10-01T10:00:00.000Z",
        settledAt: null,
        reference: null,
        invoice: {
          id: "inv-1",
          invoiceNumber: "INV-1",
          customerId: "cust-1",
          customer: { id: "cust-1", businessName: "Acme Foods" },
        },
      },
    ],
    meta: { total: 1, page: 1, limit: 25, totalPages: 1 },
    summary: { totalReceived: 40, count: 1, advanceBalance: 0 },
  },
  isLoading: false,
};

beforeEach(() => {
  mockUsePayments.mockReset();
});

describe("Payments received: no payments at all", () => {
  beforeEach(() => mockUsePayments.mockReturnValue(EMPTY));

  it("says what to do, in the fixed words, with no 'receipts'", () => {
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByText("No payments yet")).toBeInTheDocument();
    expect(screen.getByText("Record a payment to mark invoices as paid.")).toBeInTheDocument();
    expect(screen.queryByText(/receipts/i)).toBeNull();
  });

  it("has exactly one Record payment action (the header one is hidden)", () => {
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getAllByRole("button", { name: /Record payment/i })).toHaveLength(1);
  });

  it("hides the filter bar, the sort, Export CSV and the Filtered Count card", () => {
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.queryByLabelText("Search payments")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Filters/ })).toBeNull();
    expect(screen.queryByLabelText("Sort payments by")).toBeNull();
    expect(screen.queryByRole("button", { name: /Export CSV/i })).toBeNull();
    expect(screen.queryByText(/Filtered Count/i)).toBeNull();
  });

  it("renders the message outside the ten-column table, so it cannot sit off-screen at 390 (P28)", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getByText("No payments yet")).toBeInTheDocument();
  });
});

describe("Payments received: filtered down to nothing", () => {
  // A method filter that matches nothing: the hook answers an empty list for it, the full list otherwise.
  beforeEach(() =>
    mockUsePayments.mockImplementation((p: { method?: string }) => (p.method ? EMPTY : ONE)),
  );

  it("keeps the filters, the header action and the count card, and says no payments match", () => {
    renderWithProviders(<FinancePaymentsPage />);
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "CHECK" } });
    expect(screen.getByText("No matching payments")).toBeInTheDocument();
    expect(screen.getByLabelText("Search payments")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Filters/ })).toBeInTheDocument();
    expect(screen.getByText(/Filtered Count/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Record payment/i })).toHaveLength(1);
    expect(screen.queryByText("No payments yet")).toBeNull();
  });

  it("Clear filters brings the list back", () => {
    renderWithProviders(<FinancePaymentsPage />);
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "CHECK" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByText("PAY-A").length).toBeGreaterThan(0);
    expect(screen.queryByText("No matching payments")).toBeNull();
  });

  it("with payments, the page is unchanged: filter bar and the header Record payment", () => {
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByLabelText("Search payments")).toBeInTheDocument();
    expect(screen.getByText(/Filtered Count/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Record payment/i })).toHaveLength(1);
  });
});
