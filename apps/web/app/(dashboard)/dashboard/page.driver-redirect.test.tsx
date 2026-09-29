import * as React from "react";
import { renderWithProviders } from "@/test-utils/render";
import DashboardPage from "./page";

const replace = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace, prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));

let authUser: { role: string } = { role: "DRIVER" };
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: authUser }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

let access = { routes: true, delivery: false };
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: access.routes }),
  useDeliveryAccess: () => ({ enabled: access.delivery }),
}));

jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
const idle = { data: undefined, isLoading: false };
jest.mock("@/lib/api/orders", () => ({ useOrders: () => idle }));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => idle }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => idle }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => idle }));
jest.mock("@/lib/api/finance", () => ({ useFinanceDashboard: () => idle }));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => idle }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

/** PHASE 1a: a DRIVER lands on my-runs, but only with an add-on (else a redirect loop). */
describe("DashboardPage driver redirect (PHASE 1a)", () => {
  beforeEach(() => {
    replace.mockClear();
    authUser = { role: "DRIVER" };
    access = { routes: true, delivery: false };
  });

  it("redirects a DRIVER with the routes add-on to /routes/my-runs", () => {
    renderWithProviders(<DashboardPage />);
    expect(replace).toHaveBeenCalledWith("/routes/my-runs");
  });

  it("redirects a DRIVER with only the delivery add-on", () => {
    access = { routes: false, delivery: true };
    renderWithProviders(<DashboardPage />);
    expect(replace).toHaveBeenCalledWith("/routes/my-runs");
  });

  it("does NOT redirect a DRIVER with neither add-on (RouteGuard would bounce it back)", () => {
    access = { routes: false, delivery: false };
    renderWithProviders(<DashboardPage />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does NOT redirect an OPERATOR", () => {
    authUser = { role: "OPERATOR" };
    renderWithProviders(<DashboardPage />);
    expect(replace).not.toHaveBeenCalled();
  });
});
