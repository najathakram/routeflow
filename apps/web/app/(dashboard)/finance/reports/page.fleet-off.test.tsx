import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import FinanceReportsPage from "./page";

// Fleet-off clean UI: no drivers means no "Sales by Driver" report in the list. Fleet-on keeps it.
let fleet = true;
let search = "";
const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => "/finance/reports",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet, loading: false }),
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

describe("Reports — fleet-off clean UI", () => {
  beforeEach(() => {
    search = "";
    replace.mockClear();
  });

  it("M2: fleet-OFF direct URL ?report=sales-by-driver falls back to the default report and replaces the URL", async () => {
    fleet = false;
    search = "report=sales-by-driver&from=2026-01-01";
    renderWithProviders(<FinanceReportsPage />);
    expect((await screen.findAllByText("Sales by Customer")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Sales by Driver")).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("report=sales-by-customer"));
    expect(replace.mock.calls[0][0]).toContain("from=2026-01-01");
  });

  it("M2: fleet-ON keeps ?report=sales-by-driver and never replaces the URL", async () => {
    fleet = true;
    search = "report=sales-by-driver";
    renderWithProviders(<FinanceReportsPage />);
    expect(await screen.findAllByText("Sales by Driver")).not.toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it("fleet-OFF: no Sales by Driver, the other sales reports stay", async () => {
    fleet = false;
    renderWithProviders(<FinanceReportsPage />);
    expect((await screen.findAllByText("Sales by Customer")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sales by Item").length).toBeGreaterThan(0);
    expect(screen.queryByText("Sales by Driver")).not.toBeInTheDocument();
  });

  it("fleet-ON (today's UI, unchanged): Sales by Driver is listed", async () => {
    fleet = true;
    renderWithProviders(<FinanceReportsPage />);
    expect(await screen.findByText("Sales by Driver")).toBeInTheDocument();
  });
});
