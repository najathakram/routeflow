import * as React from "react";
import { act, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * BO-07: the dashboard header follows the till permission. The REAL useCounterSaleGate runs over the mocked API
 * (the capability and GET /users/me/permissions): an operator whose admin turned ORDERS off sees no Counter sale
 * sale, and no "Invoice a customer" either: the builder's PICKUP path is the same till, and the server refuses it
 * for a denied operator (order-lifecycle), so both headers drop it together.
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
  useOptionalAuth: () => ({ user: { id: "u1", role: authRole, tenantSlug: "acme" } }),
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
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    isLoading: false,
    data: { capabilities: { fulfilment: STORE_ONLY } },
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
let mockGroups = ["PRICING", "ORDERS", "FINANCE"];
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));

beforeEach(() => {
  authRole = "OPERATOR";
  mockGroups = ["PRICING", "ORDERS", "FINANCE"];
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/users/me/permissions"
          ? {
              role: authRole,
              isAccountAdmin: false,
              groups: mockGroups,
              version: 1,
              mode: "shadow",
            }
          : {},
    }),
  );
});

describe("Dashboard header and the operator's till permission", () => {
  it("an operator without ORDERS: neither Counter sale nor Invoice a customer", async () => {
    mockGroups = ["PRICING", "FINANCE"];
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    await act(async () => {}); // the answer has landed: the entries must still be absent
    expect(screen.queryByText("Counter sale")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Invoice a customer" })).toBeNull(),
    );
  });

  it("an operator with ORDERS: both are offered", async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText("Counter sale")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invoice a customer" })).toBeInTheDocument();
  });

  it("a tenant admin: Counter sale shows and permissions are never asked for", async () => {
    authRole = "TENANT_ADMIN";
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText("Counter sale")).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
  });
});
