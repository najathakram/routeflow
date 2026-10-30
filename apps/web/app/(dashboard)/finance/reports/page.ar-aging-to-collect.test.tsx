import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * SA-1026 A-G11: the AR aging summary gets a To collect column (staff only): per customer, the summed balance of its To collect
 * invoices, as the server computed it with the one rule. The buckets and totals are unchanged.
 */
let mockAging: Record<string, unknown>;
let mockSearch = "report=ar-aging";
let mockDetails: Record<string, unknown>[] = [];
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
jest.mock("@/lib/api/finance", () => ({
  ...jest.requireActual("@/lib/api/finance"),
  useArAgingDetails: () => ({
    data: { data: mockDetails },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useArAgingInvoices: () => ({
    data: mockAging,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: [] }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const bucketRow = (id: string, customerId: string, name: string, balance: number) => ({
  id,
  invoiceNumber: id,
  customer: { id: customerId, businessName: name },
  total: balance,
  balance,
  status: "SENT",
});

beforeEach(() => {
  mockSearch = "report=ar-aging";
  mockDetails = [];
  mockAging = {
    buckets: {
      current: [bucketRow("i1", "c1", "Acme Co", 1000), bucketRow("i2", "c2", "Beta Co", 500)],
    },
    totals: { current: 1500, total: 1500 },
    toCollectByCustomer: [{ customerId: "c1", businessName: "Acme Co", count: 1, balance: 1000 }],
  };
});

describe("AR aging: To collect column (SA-1026 A-G11)", () => {
  it("has a To collect column header", async () => {
    renderWithProviders(<FinanceReportsPage />);
    expect(await screen.findByRole("columnheader", { name: "To collect" })).toBeInTheDocument();
  });

  it("shows the customer's To collect balance, and a dash for a customer with none", async () => {
    renderWithProviders(<FinanceReportsPage />);
    const acme = (await screen.findByText("Acme Co")).closest("tr")!;
    const beta = screen.getByText("Beta Co").closest("tr")!;
    expect(within(acme).getByTestId("ar-to-collect")).toHaveTextContent("$1,000.00");
    expect(within(beta).getByTestId("ar-to-collect")).toHaveTextContent("\u2014");
  });

  it("an older server without the list shows dashes, not a crash", async () => {
    delete mockAging.toCollectByCustomer;
    renderWithProviders(<FinanceReportsPage />);
    const acme = (await screen.findByText("Acme Co")).closest("tr")!;
    expect(within(acme).getByTestId("ar-to-collect")).toHaveTextContent("\u2014");
  });
});

describe("AR aging details: the state on each invoice row (SA-1026)", () => {
  const detail = (id: string, toCollect?: string) => ({
    id,
    date: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-10-31T00:00:00.000Z",
    invoiceNumber: `INV-${id}`,
    status: "SENT",
    customerName: "Acme Co",
    ageDays: 5,
    amount: 100,
    balance: 100,
    ...(toCollect ? { toCollect } : {}),
  });

  it("a To collect invoice carries the chip; an ordinary one does not", async () => {
    mockSearch = "report=ar-aging-details";
    mockDetails = [detail("a", "TO_COLLECT"), detail("b", "NONE")];
    renderWithProviders(<FinanceReportsPage />);
    const a = (await screen.findByText("INV-a")).closest("tr")!;
    const b = screen.getByText("INV-b").closest("tr")!;
    expect(within(a).getByTestId("to-collect-chip")).toHaveTextContent("To collect");
    expect(within(b).queryByTestId("to-collect-chip")).toBeNull();
  });
});
