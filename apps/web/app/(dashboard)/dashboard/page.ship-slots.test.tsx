import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

// Fleet-off clean UI: a tenant with neither recurring_routes nor order_delivery has no route / driver
// surfaces on the dashboard. The "Shipped" wording is a SEPARATE switch (fulfilment_model = "ship"), so an
// existing fleet-off tenant keeps "Out for Delivery". A fleet-ON tenant sees exactly the dashboard it
// always did (the invariant half of this file).

let authRole = "OPERATOR";
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: authRole, canActAsDriver: true } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
let fleet = true;
let ship = false;
let capsLoading = false;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: capsLoading,
    data:
      ship && !capsLoading
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

const SHIP_LABELS = ["Ready to ship", "Shipped, no tracking", "Shipped this week"];
const minH = (n: Element | null | undefined) => n?.className.match(/min-h-\[[^\]]+\]/)?.[0];

beforeEach(() => {
  capsLoading = false;
  authRole = "OPERATOR";
});

describe("Dashboard W19-1 shipping slots", () => {
  it("while capabilities load, three shipping skeleton slots carry the stat min-height; no cards yet", () => {
    fleet = false;
    ship = true;
    capsLoading = true;
    renderWithProviders(<DashboardPage />);
    const slots = screen.getAllByTestId("ship-stat-skeleton");
    expect(slots).toHaveLength(3);
    slots.forEach((s) => expect(minH(s)).toBe("min-h-[104px]"));
    SHIP_LABELS.forEach((l) => expect(screen.queryByText(l)).not.toBeInTheDocument());
  });

  it("once loaded, the SHIP cards render with the same min-height and no skeleton slots", async () => {
    fleet = false;
    ship = true;
    renderWithProviders(<DashboardPage />);
    await screen.findByText("9");
    expect(screen.queryAllByTestId("ship-stat-skeleton")).toHaveLength(0);
    SHIP_LABELS.forEach((l) => {
      const a = screen.getByText(l).closest("a");
      expect(minH(a?.firstElementChild)).toBe("min-h-[104px]");
    });
  });

  it("non-SHIP account once loaded: no shipping cards, no skeleton slots", () => {
    fleet = false;
    ship = false;
    renderWithProviders(<DashboardPage />);
    expect(screen.queryAllByTestId("ship-stat-skeleton")).toHaveLength(0);
    SHIP_LABELS.forEach((l) => expect(screen.queryByText(l)).not.toBeInTheDocument());
  });

  it("non-operator while capabilities load: no shipping slots", () => {
    fleet = false;
    ship = true;
    capsLoading = true;
    authRole = "CUSTOMER";
    renderWithProviders(<DashboardPage />);
    expect(screen.queryAllByTestId("ship-stat-skeleton")).toHaveLength(0);
  });
});
