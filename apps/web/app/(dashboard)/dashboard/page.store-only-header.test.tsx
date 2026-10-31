import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * Row 344, replaced by W-854 (SA-940 verdict 1, one rule for every business): a store-only business carries the same one
 * filled New order as any other, its menu lists Counter sale first, New invoice stays secondary, and its actions are
 * 44 px targets below `sm`.
 */
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));
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

beforeEach(() => {
  authRole = "OPERATOR";
  routesOn = false;
  fulfilment = STORE_ONLY;
});

describe("Dashboard header — the store-only rule (row 344, follows row 331)", () => {
  it("a store-only tenant: New order is the filled primary and trails, New invoice stays secondary", () => {
    fulfilment = STORE_ONLY;
    renderWithProviders(<DashboardPage />);
    const newOrder = screen.getByTestId("new-order-open");
    expect(newOrder).toHaveClass("bg-accent-strong");
    expect(screen.getByRole("link", { name: /new invoice/i })).toHaveClass("bg-paper");
    expect(screen.queryByRole("link", { name: "Counter sale" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Invoice a customer" })).toBeNull();
    expect(
      screen.getByRole("link", { name: /new invoice/i }).compareDocumentPosition(newOrder) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a store-only tenant: both actions are 44 px targets below sm", () => {
    fulfilment = STORE_ONLY;
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole("link", { name: /new invoice/i }).className).toMatch(/max-sm:h-11/);
    expect(screen.getByTestId("new-order-open").className).toMatch(/max-sm:h-11/);
  });

  it("a store-only tenant: every other shortcut stays (New invoice, New route)", () => {
    fulfilment = STORE_ONLY;
    routesOn = true;
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole("link", { name: "New invoice" })).toHaveAttribute(
      "href",
      "/invoices/new",
    );
    expect(screen.getByRole("link", { name: "New route" })).toBeInTheDocument();
  });

  it("a delivery tenant: New order is the filled primary, no 44 px override on New invoice", () => {
    fulfilment = DELIVERY;
    renderWithProviders(<DashboardPage />);
    expect(screen.getByTestId("new-order-open")).toHaveClass("bg-accent-strong");
    expect(screen.queryByRole("link", { name: "Counter sale" })).toBeNull();
    expect(screen.getByRole("link", { name: /new invoice/i }).className).not.toMatch(/max-sm:h-11/);
    expect(screen.queryByRole("link", { name: "Invoice a customer" })).toBeNull();
  });
});
