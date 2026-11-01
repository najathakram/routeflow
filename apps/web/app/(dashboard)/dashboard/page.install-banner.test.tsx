import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

/**
 * SA-1069 A-2 P-1: the install banner no longer rides the staff shell (it covered the till's Complete buttons
 * on an iPhone); the staff home mounts it, so install is still offered. The shell side is pinned by
 * ../layout.install-banner.test.tsx. This is the REAL banner on the REAL page with an iPhone user agent.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR", tenantSlug: "acme" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ showButton: false }),
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

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const realUa = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");

beforeEach(() => {
  Object.defineProperty(window.navigator, "userAgent", { value: IPHONE_UA, configurable: true });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  sessionStorage.clear();
  if (realUa) Object.defineProperty(window.navigator, "userAgent", realUa);
  else delete (window.navigator as unknown as Record<string, unknown>).userAgent;
});

describe("staff home install banner (SA-1069 A-2 P-1)", () => {
  it("P1-3: the staff home still offers install on an iPhone", async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/Install RouteFlow/)).toBeInTheDocument();
    expect(screen.getByText("Add to Home Screen")).toBeInTheDocument();
  });

  it("P1-4: a dismissed banner stays dismissed for the session", async () => {
    sessionStorage.setItem("pwa-prompt-dismissed", "1");
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText("Today's revenue")).toBeInTheDocument();
    expect(screen.queryByText(/Install RouteFlow/)).toBeNull();
  });
});
