import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * SA-1078 U5 / U6: on AR aging and Customer Balance Summary the customer's figure opens the statement sheet, and tapping the
 * rest of the row still opens the report it opened before. Staff without FINANCE or CUSTOMERS keep the plain figure (U7).
 */
let mockSearch = "report=ar-aging";
let mockMay = true;
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
jest.mock("@/lib/api/account-statement", () => ({
  ...jest.requireActual("@/lib/api/account-statement"),
  useMayOpenStatement: () => mockMay,
}));
jest.mock("@/lib/api/finance", () => ({
  ...jest.requireActual("@/lib/api/finance"),
  useArAgingInvoices: () => ({
    data: {
      buckets: {
        current: [
          {
            id: "i1",
            invoiceNumber: "i1",
            customer: { id: "c1", businessName: "Acme Co" },
            total: 1000,
            balance: 1000,
            status: "SENT",
          },
        ],
      },
      totals: { current: 1000, total: 1000 },
      toCollectByCustomer: [],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCustomerBalanceSummary: () => ({
    data: {
      data: [
        { customerId: "c1", businessName: "Acme Co", invoiceCount: 2, balance: 1000, overdue: 250 },
      ],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

beforeEach(() => {
  mockSearch = "report=ar-aging";
  mockMay = true;
  mockPush.mockReset();
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) =>
    url === "/customers/c1/account-statement"
      ? Promise.resolve({
          data: {
            asOf: "2026-10-31T15:00:00.000Z",
            customer: { id: "c1", businessName: "Acme Co" },
            openBalance: 1000,
            overdue: 250,
            creditAvailable: 0,
            afterCredit: 0,
            waitingToClear: 0,
            openInvoices: [],
            recentPayments: [],
            recentPaymentsTruncated: false,
            credits: [],
          },
        })
      : Promise.resolve({ data: [] }),
  );
});

describe("U5: AR aging", () => {
  it("tapping the customer's total opens the sheet and leaves the report alone", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinanceReportsPage />);
    const row = (await screen.findByText("Acme Co")).closest("tr")!;
    await user.click(within(row).getByTestId("open-balance-button"));
    expect(await screen.findByRole("dialog", { name: "Statement" })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("tapping the rest of the row still opens AR details", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinanceReportsPage />);
    await user.click(await screen.findByText("Acme Co"));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("ar-aging-details"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("U7: without permission the total is plain text", async () => {
    mockMay = false;
    renderWithProviders(<FinanceReportsPage />);
    const row = (await screen.findByText("Acme Co")).closest("tr")!;
    expect(within(row).queryByTestId("open-balance-button")).toBeNull();
    expect(row).toHaveTextContent("$1,000.00");
  });
});

describe("U6: Customer Balance Summary", () => {
  beforeEach(() => {
    mockSearch = "report=customer-balance";
  });

  it("tapping the balance opens the sheet and leaves the report alone", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinanceReportsPage />);
    const row = (await screen.findByText("Acme Co")).closest("tr")!;
    await user.click(within(row).getByTestId("open-balance-button"));
    expect(await screen.findByRole("dialog", { name: "Statement" })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("tapping the rest of the row still opens Invoice Details", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinanceReportsPage />);
    await user.click(await screen.findByText("Acme Co"));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("invoice-details"));
  });
});
