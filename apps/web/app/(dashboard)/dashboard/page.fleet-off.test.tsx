import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

// Fleet-off clean UI: a tenant with neither recurring_routes nor order_delivery has no route / driver
// surfaces on the dashboard. The "Shipped" wording is a SEPARATE switch (fulfilment_model = "ship"), so an
// existing fleet-off tenant keeps "Out for Delivery". A fleet-ON tenant sees exactly the dashboard it
// always did (the invariant half of this file).

jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR", canActAsDriver: true } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
let fleet = true;
let ship = false;
jest.mock("@/lib/ship-mode", () => ({ useShipMode: () => ship }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: fleet, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));
const page = (total: number, rows: unknown[] = []) => ({
  data: { data: rows, meta: { total, page: 1, limit: 1, totalPages: 1 } },
  isLoading: false,
  isError: false,
});
jest.mock("@/lib/api/orders", () => ({ useOrders: () => page(3) }));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () => ({
    data: { summaryTable: { today: { sales: 10 } }, arAging: null },
    isLoading: false,
    isError: false,
  }),
}));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => page(0) }));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => page(2) }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => page(4) }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => page(0) }));

const tileLabels = () =>
  screen
    .queryAllByText(/./)
    .filter((el) => el.tagName === "P" && el.className.includes("uppercase"))
    .map((el) => el.textContent);

describe("Dashboard — fleet-off clean UI", () => {
  it("fleet-OFF, mode unset (an existing tenant): no route / driver tiles or cards, but Out for Delivery is unchanged", () => {
    fleet = false;
    ship = false;
    renderWithProviders(<DashboardPage />);

    expect(tileLabels()).not.toContain("Scheduled Routes");
    expect(tileLabels()).not.toContain("Active Drivers");
    expect(screen.queryByText(/scheduled route runs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/driver status/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new route/i })).not.toBeInTheDocument();
    expect(screen.getByText("Out for Delivery")).toBeInTheDocument();
    expect(screen.queryByText("Shipped")).not.toBeInTheDocument();
    // everything else is still there
    expect(tileLabels()).toEqual(
      expect.arrayContaining(["Active Orders", "Overdue Invoices", "Low Stock Items"]),
    );
  });

  it("fleet-OFF with fulfilment_model = ship: Out for Delivery reads Shipped", () => {
    fleet = false;
    ship = true;
    renderWithProviders(<DashboardPage />);

    expect(screen.queryByText("Out for Delivery")).not.toBeInTheDocument();
    expect(screen.getByText("Shipped")).toBeInTheDocument();
  });

  it("fleet-ON (today's UI, unchanged): route / driver tiles, New Route and the Out for Delivery label", () => {
    fleet = true;
    ship = false;
    renderWithProviders(<DashboardPage />);

    expect(tileLabels()).toEqual(
      expect.arrayContaining(["Scheduled Routes", "Active Drivers", "Active Orders"]),
    );
    expect(screen.getByRole("link", { name: /new route/i })).toBeInTheDocument();
    expect(screen.getByText("Out for Delivery")).toBeInTheDocument();
    expect(screen.queryByText("Shipped")).not.toBeInTheDocument();
  });
});
