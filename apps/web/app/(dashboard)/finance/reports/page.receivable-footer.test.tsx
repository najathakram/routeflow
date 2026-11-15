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

const cellOf = (label: string) => {
  const cells = screen.getByText(label).closest("tr")!.querySelectorAll("td");
  return cells[cells.length - 1].textContent;
};

describe("Receivable Summary footer (UX guide B7)", () => {
  beforeEach(() => {
    mockRows = [row("INVOICE", 100), row("INVOICE", -30), row("CREDIT_NOTE", 12.5)];
  });

  it("names the three lines, each figure in its own cell, and keeps today's total", async () => {
    renderWithProviders(<FinanceReportsPage />);
    await screen.findByText("Open invoices (overpayments not netted)");
    expect(cellOf("Open invoices (overpayments not netted)")).toBe("$100.00");
    expect(cellOf("Unused credit notes")).toBe("$12.50");
    expect(cellOf("Total (owed plus unused credit)")).toBe("$112.50");
    expect(screen.queryByText("Written-off invoices")).not.toBeInTheDocument();
  });

  it("shows Written-off invoices only when one exists, and keeps it out of the open line", async () => {
    mockRows = [
      row("INVOICE", 100),
      { ...row("INVOICE", 40), status: "WRITTEN_OFF", transactionNumber: "INV-WO" },
      row("CREDIT_NOTE", 12.5),
    ];
    renderWithProviders(<FinanceReportsPage />);
    await screen.findByText("Written-off invoices");
    expect(cellOf("Open invoices (overpayments not netted)")).toBe("$100.00");
    expect(cellOf("Written-off invoices")).toBe("$40.00");
    expect(cellOf("Unused credit notes")).toBe("$12.50");
    expect(cellOf("Total (owed plus unused credit)")).toBe("$152.50");
  });
});
