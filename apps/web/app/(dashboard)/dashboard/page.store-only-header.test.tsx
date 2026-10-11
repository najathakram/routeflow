import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * Row 344a: the dashboard header applies the SAME store-only rule as the Orders page (isStoreOnlyHeader): Counter sale
 * is the filled primary, Invoice a customer sits beside it, and there is NO duplicate "New Order" (it would open the
 * counter too). Every other shortcut (New Invoice, New Route) stays.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
let authRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: authRole, tenantSlug: "acme" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
let fulfilment: Record<string, unknown> = {};
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment } },
  }),
}));
let routesOn = false;
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: routesOn, resolved: true }),
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

const base = {
  staffDefault: "PICKUP",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: false,
  staffOpensAs: "counter",
  consistent: true,
};
const STORE_ONLY = { ...base, methods: ["PICKUP"] };
const DELIVERY = { ...base, methods: ["ROUTE"], staffDefault: "ROUTE", staffOpensAs: "order" };

beforeEach(() => {
  authRole = "OPERATOR";
  routesOn = false;
  fulfilment = DELIVERY;
});

describe("Dashboard header: store-only rule (same predicate as the Orders page)", () => {
  it("store-only: Counter sale (primary) + Invoice a customer, and no New Order", () => {
    fulfilment = STORE_ONLY;
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByRole("link", { name: "New Order" })).toBeNull();
    const counter = screen.getByRole("link", { name: "Counter sale" });
    const invoice = screen.getByRole("link", { name: "Invoice a customer" });
    expect(counter).toHaveAttribute("href", "/orders/counter-sale");
    expect(counter).toHaveClass("bg-accent-strong");
    // builder=1: ?action=new alone would redirect this tenant straight back to the counter.
    expect(invoice).toHaveAttribute("href", "/orders?action=new&builder=1");
    expect(invoice).toHaveClass("bg-paper");
  });

  it("store-only: every other shortcut stays (New Invoice, New Route)", () => {
    fulfilment = STORE_ONLY;
    routesOn = true;
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole("link", { name: "New Invoice" })).toHaveAttribute(
      "href",
      "/invoices/new",
    );
    expect(screen.getByRole("link", { name: "New Route" })).toBeInTheDocument();
  });

  it("a delivery tenant is unchanged: New Order stays, no Invoice a customer", () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole("link", { name: "New Order" })).toHaveAttribute(
      "href",
      "/orders?action=new",
    );
    expect(screen.queryByRole("link", { name: "Invoice a customer" })).toBeNull();
    expect(screen.getByRole("link", { name: "Counter sale" })).toHaveClass("bg-paper");
  });

  it("a store-only tenant's role that cannot use POS mode gets no Invoice a customer", () => {
    fulfilment = STORE_ONLY;
    authRole = "SUPER_ADMIN";
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByRole("link", { name: "Invoice a customer" })).toBeNull();
    expect(screen.queryByRole("link", { name: "New Order" })).toBeNull();
  });
});
