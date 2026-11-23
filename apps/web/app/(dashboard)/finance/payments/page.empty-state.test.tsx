import * as React from "react";
import { fireEvent, screen, renderWithProviders } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

/**
 * UX guide B-11 part 1 (payments walk F06, P28, P22, P23): a list with no payments at all is one calm
 * message and one action; a list filtered down to nothing keeps its filters and says so.
 */

let mockUrlSearch = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(mockUrlSearch ? { search: mockUrlSearch } : {}),
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
  mockUrlSearch = "";
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

describe("Payments received: loading, error and a search from the URL", () => {
  it("loading: the spinner, no empty state, filters and the header action stay", () => {
    mockUsePayments.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.queryByText("No payments yet")).toBeNull();
    expect(screen.queryByText("No matching payments")).toBeNull();
    expect(screen.getByLabelText("Search payments")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Record payment/i })).toHaveLength(1);
  });

  it("error: an error line with Try again, filters stay, never 'No payments yet'", () => {
    const refetch = jest.fn();
    mockUsePayments.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByText("Couldn't load payments.")).toBeInTheDocument();
    expect(screen.queryByText("No payments yet")).toBeNull();
    expect(screen.getByLabelText("Search payments")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("the error line is an alert; Try again is disabled and says so while it refetches", () => {
    mockUsePayments.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: true,
      refetch: jest.fn(),
    });
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load payments.");
    const retry = screen.getByRole("button", { name: "Trying again…" });
    expect(retry).toBeDisabled();
  });

  it("a 403 is final: the error line alone, no Try again", () => {
    mockUsePayments.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { response: { status: 403 } },
      refetch: jest.fn(),
    });
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load payments.");
    expect(screen.queryByRole("button", { name: /try(ing)? again/i })).toBeNull();
  });

  it("a failed refetch with cached rows keeps the rows and shows no error line", () => {
    mockUsePayments.mockReturnValue({ ...ONE, isError: true, refetch: jest.fn() });
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getAllByText("PAY-A").length).toBeGreaterThan(0);
    expect(screen.queryByText("Couldn't load payments.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a ?search= that matches nothing: filters stay and it says no payments match", () => {
    mockUrlSearch = "zzz";
    mockUsePayments.mockReturnValue(EMPTY);
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByText("No matching payments")).toBeInTheDocument();
    expect(screen.getByLabelText("Search payments")).toHaveValue("zzz");
    expect(screen.queryByText("No payments yet")).toBeNull();
  });

  it("clearing a search that matched nothing never flashes the truly-empty state", () => {
    mockUrlSearch = "zzz";
    mockUsePayments.mockReturnValue(EMPTY);
    renderWithProviders(<FinancePaymentsPage />);
    fireEvent.change(screen.getByLabelText("Search payments"), { target: { value: "" } });
    // The query still carries "zzz" for the 300 ms debounce, so this is still a filtered list.
    expect(screen.queryByText("No payments yet")).toBeNull();
    expect(screen.getByLabelText("Search payments")).toBeInTheDocument();
  });

  it("a page past the end (rows empty, total above 0) is not 'No payments yet'", () => {
    mockUsePayments.mockReturnValue({
      data: {
        data: [],
        meta: { total: 5, page: 3, limit: 25, totalPages: 1 },
        summary: { totalReceived: 200, count: 5, advanceBalance: 0 },
      },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.queryByText("No payments yet")).toBeNull();
    expect(screen.getByLabelText("Search payments")).toBeInTheDocument();
  });
});

describe("Payments received: the totals row with no payments", () => {
  const withAdvance = (advanceBalance: number) => ({
    ...EMPTY,
    data: { ...EMPTY.data, summary: { totalReceived: 0, count: 0, advanceBalance } },
  });

  it("hides Total received (it only repeats the empty state) and Advance balance at 0", () => {
    mockUsePayments.mockReturnValue(withAdvance(0));
    renderWithProviders(<FinancePaymentsPage />);
    expect(screen.queryByText("Total received")).toBeNull();
    expect(screen.queryByText("Advance Balance")).toBeNull();
  });

  it("shows Advance balance alone when it is above 0, in a one-card row", () => {
    mockUsePayments.mockReturnValue(withAdvance(25));
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    expect(screen.queryByText("Total received")).toBeNull();
    expect(screen.getByText("Advance Balance")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-kpi-cell]")).toHaveLength(1);
    expect(container.querySelector("[data-kpi-row]")!.className).not.toContain("md:grid-cols-3");
  });

  it("with payments, all three cards stay", () => {
    mockUsePayments.mockReturnValue(ONE);
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    expect(screen.getByText("Total received")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-kpi-cell]")).toHaveLength(3);
  });
});
