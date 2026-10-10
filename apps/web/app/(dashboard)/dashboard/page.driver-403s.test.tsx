import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import DashboardPage from "./page";

jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));

let authUser: { role: string } = { role: "DRIVER" };
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: authUser }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

let access = { routes: false, delivery: false };
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: access.routes, resolved: true }),
  useDeliveryAccess: () => ({ enabled: access.delivery, resolved: true }),
}));

jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
const idle = { data: undefined, isLoading: false, isError: false };
/** Every options object the dashboard passed to an operator/customer-only read. */
const reads: {
  hook: string;
  params?: { fulfillPath?: string };
  options: { enabled?: boolean } | undefined;
}[] = [];
/** Served `GET /tenants/me/features` body: undefined = an unset account (today's behaviour). */
let features: unknown = undefined;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ data: features }),
}));
const SHIPPING_CAPS = {
  capabilities: {
    fulfilment: {
      methods: ["SHIP"],
      staffDefault: "SHIP",
      portalMethods: [],
      portalDefault: null,
      counter: "off",
      fleet: false,
    },
  },
};
const isShipTile = (r: (typeof reads)[number]) =>
  r.hook === "useOrders" && r.params?.fulfillPath === "SHIP";
jest.mock("@/lib/api/orders", () => ({
  useOrders: (params: { fulfillPath?: string }, options?: { enabled?: boolean }) => {
    reads.push({ hook: "useOrders", params, options });
    return idle;
  },
}));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: (options?: { enabled?: boolean }) => {
    reads.push({ hook: "useFinanceDashboard", options });
    return idle;
  },
}));
jest.mock("@/lib/api/invoices", () => ({
  useInvoices: (_p: unknown, options?: { enabled?: boolean }) => {
    reads.push({ hook: "useInvoices", options });
    return idle;
  },
}));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => idle }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => idle }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => idle }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: { timezone: "America/New_York" } }) },
}));

/**
 * #2254 — a DRIVER (no routes add-on) on /dashboard fired six 403s: /orders ×3
 * (OPERATOR+CUSTOMER only), /invoices and /bookkeeping/finance-dashboard (OPERATOR
 * only), plus the layout's /authorizations/expiring-soon (OPERATOR only), and
 * rendered "Could not load recent orders."
 */
describe("DashboardPage — #2254 a DRIVER fires no operator-only reads", () => {
  beforeEach(() => {
    reads.length = 0;
    features = undefined;
    authUser = { role: "DRIVER" };
    access = { routes: false, delivery: false };
  });

  it("disables every orders/invoices/finance read for a DRIVER", () => {
    renderWithProviders(<DashboardPage />);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads)
      expect({ hook: r.hook, enabled: r.options?.enabled }).toEqual({
        hook: r.hook,
        enabled: false,
      });
  });

  it("shows no Recent Orders card, and tells a driver with no add-on why", () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByText("Recent Orders")).not.toBeInTheDocument();
    expect(screen.getByText(/plan doesn't include routes or deliveries/i)).toBeInTheDocument();
  });

  it("an OPERATOR's reads stay enabled and the Recent Orders card still renders", () => {
    authUser = { role: "OPERATOR" };
    renderWithProviders(<DashboardPage />);
    // Unset account: the ONLY disabled reads are the three SHIP-filtered shipping-tile reads.
    const disabled = reads.filter((r) => r.options?.enabled === false);
    expect(disabled.length).toBe(3);
    expect(disabled.every(isShipTile)).toBe(true);
    expect(reads.filter(isShipTile).length).toBe(3);
    expect(screen.getByText("Recent Orders")).toBeInTheDocument();
    expect(
      screen.queryByText(/plan doesn't include routes or deliveries/i),
    ).not.toBeInTheDocument();
  });

  it("a shipping account's OPERATOR enables both tile reads; a DRIVER keeps them disabled", async () => {
    features = SHIPPING_CAPS;
    authUser = { role: "OPERATOR" };
    renderWithProviders(<DashboardPage />);
    // The week tile also waits for the business timezone (/settings), so it enables a render later.
    await waitFor(() => {
      const last = reads.slice(-reads.filter((r) => r.hook === "useOrders").length);
      expect(last.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      const week = reads.filter(isShipTile).slice(-3);
      expect(week.every((r) => r.options?.enabled !== false)).toBe(true);
    });
    expect(reads.filter(isShipTile).length).toBeGreaterThanOrEqual(3);

    reads.length = 0;
    authUser = { role: "DRIVER" };
    renderWithProviders(<DashboardPage />);
    const tiles = reads.filter(isShipTile);
    expect(tiles.length).toBe(3);
    for (const r of reads) expect(r.options?.enabled).toBe(false);
  });
});

describe("dashboard layout — #2254 expiring authorizations are read by staff only", () => {
  it("gates useExpiringAuthorizations on the staff role", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "layout.tsx"), "utf8");
    expect(src).toMatch(/useExpiringAuthorizations\(\{\s*enabled:\s*isStaffRole\s*\}\)/);
  });
});
