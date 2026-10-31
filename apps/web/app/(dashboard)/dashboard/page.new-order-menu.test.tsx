import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * W-854 (SA-940 MUST 3, A-1.4): the dashboard carries the same one New order as the Orders header, and its menu opens in
 * place. New invoice and New route stay. The REAL `useCounterSaleGate` runs over a mocked capability.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
let authRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: authRole, tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: authRole, tenantSlug: "acme" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

const CAP = { portalMethods: [], portalDefault: null, fleet: true, consistent: true };
const PICKUP_SHIP = {
  ...CAP,
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  counter: "always",
  staffOpensAs: "counter",
};
const STORE_ONLY = { ...PICKUP_SHIP, methods: ["PICKUP"] };
const OPTIONAL = {
  ...CAP,
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  counter: "optional",
  staffOpensAs: "order",
};
let fulfilment: Record<string, unknown> = OPTIONAL;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ isLoading: false, data: { capabilities: { fulfilment } } }),
}));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true, resolved: true }),
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

const saleControls = () =>
  [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")]
    .map((c) => c.textContent?.trim())
    .filter((t) => t === "New order" || t === "Counter sale" || t === "Invoice a customer");

beforeEach(() => {
  jest.clearAllMocks();
  authRole = "TENANT_ADMIN";
  fulfilment = OPTIONAL;
});

describe("Dashboard header: one New order", () => {
  it.each([
    ["a pickup and ship business", PICKUP_SHIP, ["Counter sale", "Regular order"]],
    ["a store-only business", STORE_ONLY, ["Counter sale", "Regular order"]],
    ["an optional counter", OPTIONAL, ["Regular order", "Counter sale"]],
  ])("%s has one control and the menu in place", async (_name, cap, words) => {
    fulfilment = cap;
    renderWithProviders(<DashboardPage />);
    expect(saleControls()).toEqual(["New order"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "New order" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.querySelector("span")?.textContent)).toEqual(words);
  });

  it("Counter sale goes to the till and Regular order goes to the builder", async () => {
    renderWithProviders(<DashboardPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New order" }));
    await user.click(await screen.findByRole("menuitem", { name: /regular order/i }));
    expect(push).toHaveBeenLastCalledWith("/orders?action=new&builder=1");
    await user.click(screen.getByRole("button", { name: "New order" }));
    await user.click(await screen.findByRole("menuitem", { name: /counter sale/i }));
    expect(push).toHaveBeenLastCalledWith("/orders/counter-sale");
  });

  it("W54: a raw SUPER_ADMIN on a store-only business has no sale control", () => {
    authRole = "SUPER_ADMIN";
    fulfilment = STORE_ONLY;
    renderWithProviders(<DashboardPage />);
    expect(saleControls()).toEqual([]);
    expect(screen.queryByTestId("new-order-open")).toBeNull();
  });

  it("W56: a raw SUPER_ADMIN on a delivery business with a counter goes to the builder, no menu", () => {
    authRole = "SUPER_ADMIN";
    fulfilment = OPTIONAL;
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByTestId("new-order-open")).toBeNull();
    expect(screen.getByRole("link", { name: "New order" })).toHaveAttribute(
      "href",
      "/orders?action=new&builder=1",
    );
  });

  it("guard: New invoice and New route stay", () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole("link", { name: /new invoice/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new route/i })).toBeInTheDocument();
  });
});
