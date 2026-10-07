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
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: ship
      ? {
          capabilities: {
            fulfilment: {
              methods: ["SHIP"],
              staffDefault: "SHIP",
              portalMethods: [],
              portalDefault: null,
              counter: "off",
              fleet: false,
              staffOpensAs: "order",
              consistent: true,
            },
          },
        }
      : undefined,
  }),
}));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: fleet, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: { timezone: "America/New_York" } }) },
}));
const shippedFromSeen: string[] = [];
const page = (total: number, rows: unknown[] = []) => ({
  data: { data: rows, meta: { total, page: 1, limit: 1, totalPages: 1 } },
  isLoading: false,
  isError: false,
});
jest.mock("@/lib/api/orders", () => ({
  // Exact server totals (limit 1): hasTracking=false and shippedFrom are SERVER filters.
  useOrders: (p: {
    status?: string;
    fulfillPath?: string;
    hasTracking?: boolean;
    shippedFrom?: string;
  }) => {
    if (p?.hasTracking === false) return page(2);
    if (p?.shippedFrom) {
      shippedFromSeen.push(p.shippedFrom);
      return page(9);
    }
    if (p?.fulfillPath === "SHIP" && p?.status === "CONFIRMED") return page(7);
    return page(3);
  },
}));
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

  it("shipping account: Ready to ship and Shipped, no tracking cards with exact counts, linking to the filtered list", async () => {
    fleet = false;
    ship = true;
    renderWithProviders(<DashboardPage />);
    await screen.findByText("9"); // the week card waits for the business timezone

    expect(tileLabels()).toEqual(
      expect.arrayContaining(["Ready to ship", "Shipped, no tracking", "Shipped this week"]),
    );
    const tile = (label: string) =>
      screen
        .getAllByText(label)
        .find((el) => el.tagName === "P")!
        .closest("a") as HTMLAnchorElement;
    expect(tile("Ready to ship")).toHaveTextContent("7");
    expect(tile("Ready to ship").getAttribute("href")).toBe(
      "/orders?status=CONFIRMED&fulfillPath=SHIP",
    );
    expect(tile("Shipped, no tracking")).toHaveTextContent("2");
    expect(tile("Shipped, no tracking").getAttribute("href")).toBe(
      "/orders?status=OUT_FOR_DELIVERY&fulfillPath=SHIP&shipView=no-tracking",
    );
    expect(tile("Shipped this week")).toHaveTextContent("9");
    expect(tile("Shipped this week").getAttribute("href")).toBe(
      "/orders?fulfillPath=SHIP&shipView=week",
    );
  });

  it("Shipped this week asks for Sunday 00:00 in the tenant's zone (same instant as the list)", async () => {
    fleet = false;
    ship = true;
    shippedFromSeen.length = 0;
    renderWithProviders(<DashboardPage />);
    await screen.findByText("9");
    const sent = shippedFromSeen.pop()!;
    const { startOfTenantWeek } = jest.requireActual("@/lib/tenant-week");
    expect(sent).toBe(startOfTenantWeek(new Date(), "America/New_York").toISOString());
  });

  it("Shipped this week keeps its placeholder until the timezone is known", async () => {
    fleet = false;
    ship = true;
    const { apiClient } = jest.requireMock("@/lib/api-client");
    apiClient.get.mockResolvedValueOnce({ data: {} });
    renderWithProviders(<DashboardPage />);
    await screen.findByText("Shipped this week");
    const card = screen.getAllByText("Shipped this week").find((el) => el.tagName === "P")!;
    expect(card.closest("a")).toHaveTextContent("—");
    expect(card.closest("a")).not.toHaveTextContent("9");
  });

  it("Shipped this week shows — when the timezone read fails", async () => {
    fleet = false;
    ship = true;
    const { apiClient } = jest.requireMock("@/lib/api-client");
    apiClient.get.mockRejectedValueOnce(new Error("403"));
    renderWithProviders(<DashboardPage />);
    const card = (await screen.findAllByText("Shipped this week")).find(
      (el) => el.tagName === "P",
    )!;
    expect(card.closest("a")).toHaveTextContent("—");
    expect(card.closest("a")).not.toHaveTextContent("9");
  });

  it.each([
    ["an unset account", false],
    ["a fleet account", true],
  ])("no shipping cards for %s", (_name, fleetOn) => {
    fleet = fleetOn;
    ship = false;
    renderWithProviders(<DashboardPage />);
    expect(tileLabels()).not.toContain("Ready to ship");
    expect(tileLabels()).not.toContain("Shipped, no tracking");
    expect(tileLabels()).not.toContain("Shipped this week");
  });

  it("fleet-OFF with a ship-mode account: Out for Delivery reads Shipped", () => {
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
