import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  // B536: the card's subtitle must state what totalUsers counts (staff only, not
  // every buyer-portal customer login) — the owner's core complaint was a number
  // with no stated meaning. Pins the label so it can't silently regress to the old,
  // ambiguous "Across all workspaces" text.
  it("B536: Total Users card states it counts staff accounts", async () => {
    mockStatsAndGrowth(baseStats({ totalUsers: 7 }));

    render(<AdminDashboardPage />);

    expect(await screen.findByText("Total Users")).toBeInTheDocument();
    expect(screen.getByText("Staff accounts across all workspaces")).toBeInTheDocument();
    expect(screen.queryByText("Across all workspaces")).not.toBeInTheDocument();
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

// W3 / M1: the weekly funnel sits under the stat cards. The API sends five numbers per week;
// the sixth (answered) joins after the first-question change, and the card says so.
describe("AdminDashboardPage — weekly funnel (W3 M1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const weeks = [
    {
      weekStart: "2026-10-19",
      signups: 3,
      verified: 2,
      firstOrder: 1,
      firstRoute: 0,
      demoBookings: 4,
    },
    {
      weekStart: "2026-10-26",
      signups: 5,
      verified: 4,
      firstOrder: 2,
      firstRoute: 1,
      demoBookings: 0,
    },
  ];

  it("shows each week's five numbers under their labels, with the week named by its Monday", async () => {
    mockStatsAndGrowth(baseStats({ weeklyFunnel: { weeks } }));

    render(<AdminDashboardPage />);

    const region = await screen.findByRole("region", { name: "Sign-ups by week" });
    const headers = within(region)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Week of",
      "Sign-ups",
      "Verified",
      "First order",
      "First route",
      "Demo bookings",
    ]);
    const rows = within(region).getAllByRole("row").slice(1);
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ["Oct 19", "3", "2", "1", "0", "4"],
      ["Oct 26", "5", "4", "2", "1", "0"],
    ]);
  });

  it("says the answered count is not there yet, rather than showing a zero for it", async () => {
    mockStatsAndGrowth(baseStats({ weeklyFunnel: { weeks } }));

    render(<AdminDashboardPage />);

    await screen.findByRole("region", { name: "Sign-ups by week" });
    expect(
      screen.getByText("Answered is not counted yet. It starts with the first-question change."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /answered/i })).not.toBeInTheDocument();
  });

  it("says the numbers can't be shown when the funnel read failed, and the page still loads", async () => {
    mockStatsAndGrowth(baseStats({ weeklyFunnel: { unavailable: true } }));

    render(<AdminDashboardPage />);

    expect(await screen.findByText("These numbers can't be shown right now.")).toBeInTheDocument();
    expect(screen.getByText("Sign-ups by week")).toBeInTheDocument();
    expect(screen.getByText("Platform Dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sign-ups by week" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Sign-ups" })).not.toBeInTheDocument();
  });

  it("leaves the card out when the API sends no funnel, instead of showing zeros", async () => {
    mockStatsAndGrowth(baseStats({}));

    render(<AdminDashboardPage />);

    await screen.findByText("Platform Dashboard");
    expect(screen.queryByRole("region", { name: "Sign-ups by week" })).not.toBeInTheDocument();
  });
});
