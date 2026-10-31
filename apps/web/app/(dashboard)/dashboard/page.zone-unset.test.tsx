import * as React from "react";
import { act, renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * SA-1067 Z4 (rows Z-9, Z-10, Z-11): a business whose time zone was never picked (UTC) has its evening sales dated
 * tomorrow. Only the tenant admin can change the zone, so only they are asked; the link lands on the field.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
let authRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: authRole, tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: authRole, tenantSlug: "acme" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ isLoading: false, data: { capabilities: {} } }),
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
let zone: string | undefined = "UTC";
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));

const PROMPT =
  "Set your business time zone. Until then, invoices and reports use UTC, so evening sales can show tomorrow's date.";

beforeEach(() => {
  authRole = "TENANT_ADMIN";
  zone = "UTC";
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/settings"
          ? { businessName: "Acme Foods", ownerName: "Jane", timezone: zone }
          : url === "/users/me/permissions"
            ? { role: authRole, isAccountAdmin: false, groups: [], version: 1, mode: "shadow" }
            : {},
    }),
  );
});

describe("Dashboard: the business time zone was never picked", () => {
  it("Z-9: a tenant admin on UTC is asked, and the link reaches the Time zone field", async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set time zone" })).toHaveAttribute(
      "href",
      "/settings?tab=profile#settings-timezone",
    );
  });

  it("Z-10: an operator on UTC is not asked (only the tenant admin can change it)", async () => {
    authRole = "OPERATOR";
    renderWithProviders(<DashboardPage />);
    await screen.findByText(/Here's what's happening at Acme Foods/);
    await act(async () => {});
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(screen.queryByRole("link", { name: "Set time zone" })).toBeNull();
  });

  it("Z-11: a tenant admin whose zone is Chicago is not asked", async () => {
    zone = "America/Chicago";
    renderWithProviders(<DashboardPage />);
    await screen.findByText(/Here's what's happening at Acme Foods/);
    await act(async () => {});
    expect(screen.queryByText(PROMPT)).toBeNull();
  });
});
