import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import DashboardPage from "./page";

// SA-1049 R1 (L-072): the staff pipeline strip and "Active orders" were built from five hand-typed
// status counts, so a PARTIALLY_DELIVERED order (live, non-terminal, counted as active on the buyer
// dashboard) vanished from both. The strip now has one tile per placed-order status, in lifecycle
// order, and Active orders adds the partly delivered count. A DRAFT is not a placed order: it is
// neither a tile nor part of Active orders (G-5).

jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: true, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }) },
}));

const TOTALS: Record<string, number> = {
  PENDING: 2,
  CONFIRMED: 3,
  OUT_FOR_DELIVERY: 4,
  PARTIALLY_DELIVERED: 5,
  DELIVERED: 6,
  CANCELLED: 1,
};
const page = (total: number, rows: unknown[] = []) => ({
  data: { data: rows, meta: { total, page: 1, limit: rows.length || 1, totalPages: 1 } },
  isLoading: false,
  isError: false,
});

const orderCalls: { status?: string; options?: { refetchInterval?: number } }[] = [];
jest.mock("@/lib/api/orders", () => ({
  useOrders: (p: { status?: string; limit?: number }, options?: { refetchInterval?: number }) => {
    orderCalls.push({ status: p?.status, options });
    if (p?.status) return page(TOTALS[p.status] ?? 0);
    return page(0, []);
  },
}));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () => ({
    data: { summaryTable: { today: { sales: 10 } }, arAging: null },
    isLoading: false,
    isError: false,
  }),
}));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => page(0, []) }));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => page(0, []) }));
jest.mock("@/lib/api/drivers", () => ({ useDrivers: () => page(0, []) }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => page(0, []) }));

const tile = (label: string) =>
  screen
    .getAllByText(label)
    .find((el) => el.tagName === "P" && el.className.includes("uppercase"))!
    .closest("[class*='rounded-card']") as HTMLElement;

describe("Dashboard pipeline strip — partly delivered (SA-1049 R1)", () => {
  beforeEach(() => {
    orderCalls.length = 0;
  });

  it("R-2: the strip is one tile per placed-order status in lifecycle order, and the PD tile links to its orders", () => {
    renderWithProviders(<DashboardPage />);
    const strip = screen.getByTestId("pipeline-strip");
    const links = within(strip).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/orders?status=PENDING",
      "/orders?status=CONFIRMED",
      "/orders?status=OUT_FOR_DELIVERY",
      "/orders?status=PARTIALLY_DELIVERED",
      "/orders?status=DELIVERED",
      "/orders?status=CANCELLED",
    ]);
    const pd = links[3];
    expect(pd).toHaveTextContent("5");
    expect(pd).toHaveTextContent("Partly delivered");
  });

  it("R-2: Active orders adds the partly delivered count (2 + 3 + 4 + 5 = 14)", () => {
    renderWithProviders(<DashboardPage />);
    expect(tile("Active orders")).toHaveTextContent("14");
  });

  it("the partly delivered count is polled like Out for delivery (it is not terminal)", () => {
    renderWithProviders(<DashboardPage />);
    const pd = orderCalls.find((c) => c.status === "PARTIALLY_DELIVERED");
    expect(pd?.options?.refetchInterval).toBe(30_000);
  });

  it("W-1016: on a phone the six tiles wrap three by two; the strip never scrolls inside itself", () => {
    // jsdom has no layout, so the contract is the class list: a phone grid of 3 columns (6 tiles = 2 rows), 6 across
    // from sm up, and no fixed minimum width or inner scroller that would hide the Partly delivered tile on first paint
    renderWithProviders(<DashboardPage />);
    const strip = screen.getByTestId("pipeline-strip");
    expect(strip.className).not.toContain("overflow-x-auto");
    const grid = strip.firstElementChild as HTMLElement;
    expect(grid.className).toContain("grid-cols-3");
    expect(grid.className).toContain("sm:grid-cols-6");
    expect(grid.className).not.toMatch(/min-w-\[/);
  });

  it("G-5: a DRAFT is never counted: no DRAFT query, no DRAFT tile, Active orders stays 14", () => {
    renderWithProviders(<DashboardPage />);
    expect(orderCalls.some((c) => c.status === "DRAFT")).toBe(false);
    const hrefs = within(screen.getByTestId("pipeline-strip"))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/orders?status=DRAFT");
    expect(tile("Active orders")).toHaveTextContent("14");
  });
});
