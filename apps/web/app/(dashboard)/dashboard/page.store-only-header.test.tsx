import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * Row 344 (follow-up of row 331): the dashboard header follows the SAME store-only rule the Orders header does
 * (UX G7), read from the one capability gate and the one shared helper (`quickCreateRule`):
 *  - a store-only business (capabilities.fulfilment: PICKUP only, counter always): Counter sale is the FILLED
 *    primary and trails, New Order is gone (it went to the same place as Counter sale), New Invoice stays secondary,
 *    and the two actions are 44 px targets below `sm`;
 *  - a delivery business is unchanged: Counter sale secondary, New Order the filled primary, no 44 px override.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR", tenantSlug: "acme" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

const STORE_ONLY = {
  methods: ["PICKUP"],
  staffDefault: "PICKUP",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: false,
  staffOpensAs: "counter",
  consistent: true,
};
const DELIVERY = {
  methods: ["ROUTE"],
  staffDefault: "ROUTE",
  portalMethods: [],
  portalDefault: null,
  counter: "optional",
  fleet: true,
  staffOpensAs: "order",
  consistent: true,
};
let fulfilment: Record<string, unknown> = STORE_ONLY;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment } },
  }),
}));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: false, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
const q = () => ({ data: { data: [], meta: { total: 0 } }, isLoading: false, isError: false });
jest.mock("@/lib/api/orders", () => ({ useOrders: () => q() }));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () => ({
    data: { summaryTable: { today: { sales: 0 } }, arAging: null },
    isLoading: false,
    isError: false,
  }),
}));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => q() }));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => q() }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => q() }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => q() }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

describe("Dashboard header — the store-only rule (row 344, follows row 331)", () => {
  it("a store-only tenant: Counter sale is the filled primary, there is no New Order, New Invoice stays secondary", () => {
    fulfilment = STORE_ONLY;
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByRole("link", { name: /new order/i })).toBeNull();
    const counter = screen.getByRole("link", { name: "Counter sale" });
    const invoice = screen.getByRole("link", { name: /new invoice/i });
    expect(counter).toHaveClass("bg-accent-strong");
    expect(invoice).toHaveClass("bg-paper");
    expect(counter).toHaveAttribute("href", "/orders/counter-sale");
    // The primary trails: [New Invoice][Counter sale].
    const order = screen
      .getAllByRole("link")
      .map((l) => l.textContent?.trim())
      .filter((t) => t === "New Invoice" || t === "Counter sale");
    expect(order).toEqual(["New Invoice", "Counter sale"]);
  });

  it("a store-only tenant: both actions are 44 px targets below sm", () => {
    fulfilment = STORE_ONLY;
    renderWithProviders(<DashboardPage />);
    for (const name of [/new invoice/i, "Counter sale"]) {
      expect(screen.getByRole("link", { name }).className).toMatch(/max-sm:h-11/);
    }
  });

  it("a delivery tenant is unchanged: New Order is the filled primary, Counter sale secondary, no 44 px override", () => {
    fulfilment = DELIVERY;
    renderWithProviders(<DashboardPage />);
    const newOrder = screen.getByRole("link", { name: /new order/i });
    expect(newOrder).toHaveClass("bg-accent-strong");
    expect(screen.getByRole("link", { name: "Counter sale" })).toHaveClass("bg-paper");
    expect(screen.getByRole("link", { name: /new invoice/i }).className).not.toMatch(/max-sm:h-11/);
  });
});
