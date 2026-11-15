import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import FinanceReportsPage from "./page";

/**
 * UX guide B7: the Receivable Summary footer says what its balance figure is made of: open invoices, unused credit
 * notes, and the total (today's figure, unchanged).
 */
let mockRows: Record<string, unknown>[] = [];
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("report=receivable-summary"),
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
  useReceivableSummary: () => ({
    data: { data: mockRows },
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

const row = (type: string, balance: number, total = balance) => ({
  customerName: "Acme Co",
  date: "2026-09-10T00:00:00.000Z",
  transactionNumber: `${type}-1`,
  type,
  status: type === "CREDIT_NOTE" ? "ISSUED" : "SENT",
  total,
  balance,
});

describe("Receivable Summary footer (UX guide B7)", () => {
  beforeEach(() => {
    mockRows = [row("INVOICE", 100), row("INVOICE", -30), row("CREDIT_NOTE", 12.5)];
  });

  it("names the three lines and keeps today's total as the bottom line", async () => {
    renderWithProviders(<FinanceReportsPage />);
    expect(await screen.findByText("Open invoices (overpayments not netted)")).toBeInTheDocument();
    expect(screen.getByText("Unused credit notes")).toBeInTheDocument();
    expect(screen.getByText("Total (owed plus unused credit)")).toBeInTheDocument();
    expect(screen.getAllByText("$112.50").length).toBeGreaterThan(0);
  });
});
