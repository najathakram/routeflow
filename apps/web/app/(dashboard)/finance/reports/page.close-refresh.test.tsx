import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * SA-1078 U9 / U17 (T2 review of PR-2): closing the statement sheet refreshes every ["reports"] query, and that refresh must
 * not blank the report. The real report hooks and query client run; the second report GET is held open, the way a slow read is.
 * While it is held, the clerk's row is still on screen with the figure showing the old amount, and focus is back on the
 * figure they tapped (a skeleton would unmount it and drop focus on body).
 */
let mockSearch = "report=ar-aging";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet: true, loading: false }),
}));
jest.mock("@/lib/api/account-statement", () => ({
  ...jest.requireActual("@/lib/api/account-statement"),
  useMayOpenStatement: () => true,
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

const STATEMENT = {
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
};
const AR_AGING = {
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
};
const BALANCES = {
  data: [
    { customerId: "c1", businessName: "Acme Co", invoiceCount: 2, balance: 1000, overdue: 250 },
  ],
};

/** The report URL answers once at once, then every later read is held until `release()`. */
function holdSecondReportRead(reportUrl: string, body: unknown) {
  let reads = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  mockGet.mockImplementation((url: string) => {
    if (url === "/customers/c1/account-statement") return Promise.resolve({ data: STATEMENT });
    if (url === reportUrl) {
      reads += 1;
      return reads === 1 ? Promise.resolve({ data: body }) : held.then(() => ({ data: body }));
    }
    return Promise.resolve({ data: [] });
  });
  return { reads: () => reads, release };
}

beforeEach(() => {
  mockGet.mockReset();
});

describe.each([
  ["AR aging", "report=ar-aging", "/bookkeeping/reports/ar-aging-invoices", AR_AGING],
  [
    "Customer Balance Summary",
    "report=customer-balance",
    "/bookkeeping/reports/customer-balance",
    BALANCES,
  ],
])("%s: closing the statement sheet", (_name, search, url, body) => {
  it("keeps the rows on screen while the refresh is in flight, and focus on the tapped figure", async () => {
    mockSearch = search;
    const user = userEvent.setup();
    const probe = holdSecondReportRead(url, body);
    renderWithProviders(<FinanceReportsPage />);

    const row = (await screen.findByText("Acme Co")).closest("tr")!;
    const figure = within(row).getByTestId("open-balance-button");
    await user.click(figure);
    await screen.findByRole("dialog", { name: "Statement" });

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The close asked the report for a fresh read, and that read has not answered.
    await waitFor(() => expect(probe.reads()).toBe(2));

    const rowAfter = screen.getByText("Acme Co").closest("tr");
    expect(rowAfter).not.toBeNull();
    expect(rowAfter).toBe(row);
    expect(document.activeElement).toBe(figure);

    probe.release();
    await waitFor(() => expect(screen.getByText("Acme Co")).toBeInTheDocument());
  });
});

describe("U9: the next open reads the statement again", () => {
  it("a reopened sheet shows Loading, not the figure it held when it closed", async () => {
    mockSearch = "report=ar-aging";
    const user = userEvent.setup();
    let statementReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === "/customers/c1/account-statement") {
        statementReads += 1;
        return statementReads === 1
          ? Promise.resolve({ data: STATEMENT })
          : new Promise(() => undefined);
      }
      if (url === "/bookkeeping/reports/ar-aging-invoices")
        return Promise.resolve({ data: AR_AGING });
      return Promise.resolve({ data: [] });
    });
    renderWithProviders(<FinanceReportsPage />);

    const row = (await screen.findByText("Acme Co")).closest("tr")!;
    await user.click(within(row).getByTestId("open-balance-button"));
    const first = await screen.findByRole("dialog", { name: "Statement" });
    await waitFor(() => expect(within(first).queryByText("Loading…")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(row).getByTestId("open-balance-button"));
    const second = await screen.findByRole("dialog", { name: "Statement" });
    expect(statementReads).toBe(2);
    expect(within(second).getByText("Loading…")).toBeInTheDocument();
  });
});
