import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * BF-5 (SA-1211): overdue days count on the business's calendar day (daysPastDue + useTenantToday), not the browser's
 * 24-hour clock. Due Nov 10; it is 8 pm Nov 11 in Chicago (02:00Z Nov 12): 1 day overdue, not 2.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "TENANT_ADMIN", tenantSlug: "acme" } }),
  useOptionalAuth: () => ({ user: { id: "u1", role: "TENANT_ADMIN", tenantSlug: "acme" } }),
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
jest.mock("@/lib/api/app-links", () => ({
  ...jest.requireActual("@/lib/api/app-links"),
  useAppLinks: () => ({ data: { androidApkUrl: null, playStoreUrl: null, iosUrl: null } }),
}));
const q = () => ({ data: { data: [], meta: { total: 0 } }, isLoading: false, isError: false });
jest.mock("@/lib/api/orders", () => ({ useOrders: () => q() }));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () => ({
    data: { summaryTable: { today: { sales: 0 } }, arAging: null },
    isLoading: false,
    isError: false,
  }),
}));
jest.mock("@/lib/api/invoices", () => ({
  useInvoices: () => ({
    data: {
      data: [
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          dueDate: "2026-11-10T00:00:00.000Z",
          total: 100,
          balanceDue: 100,
          customer: { businessName: "Acme Foods" },
        },
      ],
      meta: { total: 1 },
    },
    isLoading: false,
    isError: false,
  }),
}));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => q() }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => q() }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => q() }));
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a) },
}));

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date("2026-11-12T02:00:00Z"),
    doNotFake: [
      "setTimeout",
      "setInterval",
      "queueMicrotask",
      "nextTick",
      "setImmediate",
      "clearTimeout",
      "clearInterval",
      "clearImmediate",
    ],
  });
  mockGet.mockImplementation((url: string) =>
    Promise.resolve({
      data:
        url === "/settings"
          ? { businessName: "Acme Foods", ownerName: "Jane", timezone: "America/Chicago" }
          : url === "/users/me/permissions"
            ? {
                role: "TENANT_ADMIN",
                isAccountAdmin: false,
                groups: [],
                version: 1,
                mode: "shadow",
              }
            : {},
    }),
  );
});
afterEach(() => jest.useRealTimers());

it("BF-5: due the 10th, 8 pm on the 11th in Chicago reads 1d overdue", async () => {
  renderWithProviders(<DashboardPage />);
  expect((await screen.findByText(/[0-9]+d overdue/)).textContent).toBe("1d overdue");
  expect(screen.queryByText("2d overdue")).toBeNull();
});
