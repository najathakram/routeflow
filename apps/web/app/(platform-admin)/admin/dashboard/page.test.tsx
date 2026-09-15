import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import AdminDashboardPage from "./page";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: jest.fn(),
  },
}));

const { superAdminClient } = require("@/lib/admin-api");

function baseStats(overrides: Record<string, unknown>) {
  return {
    tenants: { total: 0, active: 0, trial: 0, suspended: 0 },
    totalUsers: 0,
    newTenantsThisMonth: 0,
    planBreakdown: {},
    recentTenants: [],
    trialsExpiringSoon: [],
    atRiskTenants: [],
    ...overrides,
  };
}

function mockStatsAndGrowth(stats: Record<string, unknown>) {
  (superAdminClient.get as jest.Mock).mockImplementation((url: string) => {
    if (url.includes("/stats/growth")) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: stats });
  });
}

describe("AdminDashboardPage — MRR card (T14-5/6/7, R27)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("T14-5: renders MRR + ledger reconciliation with a diff badge when the figures differ by >= 1c", async () => {
    mockStatsAndGrowth(baseStats({ mrr: 499, ledgerMrr: 430 }));

    render(<AdminDashboardPage />);

    const mrrEl = await screen.findByTestId("dashboard-mrr");
    expect(mrrEl).toHaveTextContent("$499.00");

    const ledgerEl = await screen.findByTestId("dashboard-ledger-mrr");
    expect(ledgerEl).toHaveTextContent("Reconciled to ledger: $430.00");
    expect(ledgerEl).toHaveTextContent("differs by $69.00");

    expect(screen.queryByText(/est\. mrr/i)).not.toBeInTheDocument();
  });

  it("T14-6: renders no diff badge when mrr and ledgerMrr are equal", async () => {
    mockStatsAndGrowth(baseStats({ mrr: 499, ledgerMrr: 499 }));

    render(<AdminDashboardPage />);

    const ledgerEl = await screen.findByTestId("dashboard-ledger-mrr");
    expect(ledgerEl).toHaveTextContent("Reconciled to ledger: $499.00");
    expect(ledgerEl).not.toHaveTextContent(/differs/i);
  });

  it("T14-7: renders '—' and never 'NaN' when mrr/ledgerMrr are missing", async () => {
    mockStatsAndGrowth(baseStats({ mrr: undefined, ledgerMrr: undefined }));

    render(<AdminDashboardPage />);

    const mrrEl = await screen.findByTestId("dashboard-mrr");
    expect(mrrEl).toHaveTextContent("—");

    await waitFor(() => {
      expect(document.body.textContent).not.toMatch(/NaN/);
    });
  });
});
