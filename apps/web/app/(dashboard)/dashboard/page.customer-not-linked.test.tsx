import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "CUSTOMER" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: false, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));

const idle = { data: undefined, isLoading: false, isError: false };
let recentError: unknown = undefined;
jest.mock("@/lib/api/orders", () => ({
  useOrders: (p: { limit?: number }) =>
    p?.limit === 5 && recentError !== undefined
      ? { data: undefined, isLoading: false, isError: true, error: recentError }
      : idle,
}));
jest.mock("@/lib/api/finance", () => ({ useFinanceDashboard: () => idle }));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => idle }));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => idle }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => idle }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => idle }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

const forbidden = (data: Record<string, unknown>) => ({
  message: "Request failed with status code 403",
  response: { status: 403, data },
});

/**
 * B917 — the e2e customer's dashboard said "Could not load recent orders." because GET /orders answered
 * 403 "Customer record not found" (a login with no linked Customer). The 403 now carries
 * CUSTOMER_NOT_LINKED and the dashboard maps it to a sentence that tells the customer what to do.
 */
describe("Customer dashboard — account not linked to a business (B917)", () => {
  beforeEach(() => {
    recentError = undefined;
  });

  it("maps the CUSTOMER_NOT_LINKED 403 to a fixed sentence, never the generic failure or server text", () => {
    recentError = forbidden({ code: "CUSTOMER_NOT_LINKED", message: "Customer record not found" });
    renderWithProviders(<DashboardPage />);
    expect(
      screen.getByText("Your account isn't linked to a business yet. Contact your supplier."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Could not load recent orders.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Customer record not found/)).not.toBeInTheDocument();
  });

  it("any other failure keeps the generic sentence", () => {
    recentError = forbidden({ code: "SOMETHING_ELSE" });
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText("Could not load recent orders.")).toBeInTheDocument();
    expect(screen.queryByText(/isn't linked to a business/i)).not.toBeInTheDocument();
  });

  it("a network error keeps the generic sentence", () => {
    recentError = new Error("Network Error");
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText("Could not load recent orders.")).toBeInTheDocument();
  });
});
