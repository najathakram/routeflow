import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * W20 fold: the dashboard's Counter sale entry uses the SAME staff-only predicate as the shell and the palette.
 * The REAL useCounterSaleGate runs over a CACHED "always" answer: only `enabled` can hide it for non-staff.
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
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: {
      capabilities: {
        fulfilment: {
          methods: ["ROUTE"],
          staffDefault: "ROUTE",
          portalMethods: [],
          portalDefault: null,
          counter: "always",
          fleet: true,
          staffOpensAs: "order",
          consistent: true,
        },
      },
    },
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

describe("Dashboard counter entry by role (cached always capability)", () => {
  it.each(["CUSTOMER", "DRIVER"])("%s: no Counter sale entry", (role) => {
    authRole = role;
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByText("Counter sale")).not.toBeInTheDocument();
  });

  it("OPERATOR: Counter sale entry is shown", () => {
    authRole = "OPERATOR";
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText("Counter sale")).toBeInTheDocument();
  });
});
