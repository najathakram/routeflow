import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * REG-B1 (owner ruling: New order is hidden for customers): the dashboard's "Quick create: New order" is a staff control.
 * Harness as page.layout-reserve.test.tsx.
 */
jest.mock("@/components/PwaInstallPrompt", () => ({ PwaInstallPrompt: () => null }));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
let authUser: { id: string; role: string; tenantSlug: string } = {
  id: "u1",
  role: "OPERATOR",
  tenantSlug: "acme",
};
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: authUser }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: false, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: false,
    mayUseTill: true,
    permsKnown: true,
    capability: undefined,
  }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
const q = (data: unknown) => ({ data, isLoading: false, isError: false });
const list = { data: [], meta: { total: 0 } };
jest.mock("@/lib/api/orders", () => ({ useOrders: () => q(list) }));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () =>
    q({ summaryTable: { today: { sales: 0 } }, arAging: { total: "0", current: "0" } }),
}));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => q(list) }));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => q(list) }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => q(list) }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => q(list) }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

const newOrderLinks = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("a[href]")).filter(
    (a) => a.getAttribute("href") === "/orders?action=new&builder=1",
  ).length;

beforeEach(() => {
  window.localStorage.clear();
  authUser = { id: "u1", role: "OPERATOR", tenantSlug: "acme" };
});

describe("REG-B1 dashboard Quick create by role", () => {
  it("REG-B1 a CUSTOMER sees no Quick create New order", () => {
    authUser = { id: "u1", role: "CUSTOMER", tenantSlug: "acme" };
    const { container } = renderWithProviders(<DashboardPage />);
    expect({ label: "New order link", count: newOrderLinks(container) }).toEqual({
      label: "New order link",
      count: 0,
    });
    expect({
      label: "Quick create label",
      count: screen.queryAllByText("Quick create:").length,
    }).toEqual({ label: "Quick create label", count: 0 });
  });

  it("REG-B1 an OPERATOR twin has New order", () => {
    const { container } = renderWithProviders(<DashboardPage />);
    expect(newOrderLinks(container)).toBeGreaterThanOrEqual(1);
  });
});
