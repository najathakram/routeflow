import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { lastKnownRoutesKey } from "@/lib/last-known-routes-access";
import DashboardPage from "./page";

/**
 * PKG-8 (dashboard CLS). jsdom has no layout, so "same height" is pinned at the class level:
 * a skeleton and its loaded twin carry the same shared min-h constant. The measured CLS lives in
 * e2e/69-dashboard-cls.spec.ts.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/dashboard",
}));
let authUser: { id: string; role: string; tenantSlug: string; canActAsDriver?: boolean } = {
  id: "u1",
  role: "OPERATOR",
  tenantSlug: "acme",
};
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: authUser }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
let routes: { enabled: boolean; resolved: boolean; pending?: boolean } = {
  enabled: true,
  resolved: true,
};
let delivery = false;
jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => routes,
  useDeliveryAccess: () => ({ enabled: delivery, resolved: true }),
}));
let counterButton = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ showButton: counterButton }),
}));
jest.mock("@/lib/stock-label", () => ({ unitsLabel: () => "" }));
let loading = true;
const q = (data: unknown) => ({
  data: loading ? undefined : data,
  isLoading: loading,
  isError: false,
});
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

const KEY = lastKnownRoutesKey("acme", "u1");
const ALL_LABELS = [
  "Today's Revenue",
  "Overdue Invoices",
  "Active Orders",
  "Scheduled Routes",
  "Active Drivers",
  "Low Stock Items",
];
const labelsShown = () => ALL_LABELS.filter((l) => screen.queryAllByText(l).length > 0);
const hrefs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") as string);

beforeEach(() => {
  loading = true;
  routes = { enabled: true, resolved: true };
  delivery = false;
  counterButton = false;
  authUser = { id: "u1", role: "OPERATOR", tenantSlug: "acme" };
  window.localStorage.clear();
});

describe("D1 stat grid skeleton parity", () => {
  it("renders as many stat-skeletons as loaded cards, with the same shared min-h class", () => {
    const a = renderWithProviders(<DashboardPage />);
    const stats = screen.getByTestId("dashboard-stats");
    const sk = screen.getAllByTestId("stat-skeleton");
    const skMinH = sk.map((n) => n.className.match(/min-h-\[[^\]]+\]/)?.[0]);
    a.unmount();
    loading = false;
    const b = renderWithProviders(<DashboardPage />);
    const loadedCards = screen.getByTestId("dashboard-stats").children;
    expect(stats).toBeTruthy();
    expect(sk).toHaveLength(6);
    expect(loadedCards).toHaveLength(sk.length);
    const loadedMinH = Array.from(loadedCards).map(
      (c) => c.firstElementChild?.className.match(/min-h-\[[^\]]+\]/)?.[0],
    );
    expect(new Set([...skMinH, ...loadedMinH]).size).toBe(1);
    expect(skMinH[0]).toBeDefined();
    b.unmount();
  });
});

describe("D2 routes/drivers slot reservation (last-known access)", () => {
  it("known-no-routes tenant: no routes/drivers slot while unresolved", () => {
    window.localStorage.setItem(KEY, "0");
    routes = { enabled: false, resolved: false, pending: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(4);
  });
  it("known-routes tenant: slots reserved while unresolved", () => {
    window.localStorage.setItem(KEY, "1");
    routes = { enabled: false, resolved: false, pending: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(6);
  });
  it("known-routes tenant: the Route Runs and Driver Status panels are reserved too", () => {
    window.localStorage.setItem(KEY, "1");
    routes = { enabled: false, resolved: false, pending: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText("Scheduled Route Runs")).toBeTruthy();
    expect(screen.getByText("Driver Status")).toBeTruthy();
  });
  it("known-no-routes / first visit: no Route Runs or Driver Status panel while unresolved", () => {
    routes = { enabled: false, resolved: false, pending: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByText("Scheduled Route Runs")).toBeNull();
    expect(screen.queryByText("Driver Status")).toBeNull();
  });
  it("stored ON but the addons read ERRORED: no routes/drivers skeletons and no Route Runs panel", () => {
    window.localStorage.setItem(KEY, "1");
    routes = { enabled: false, resolved: false, pending: false };
    renderWithProviders(<DashboardPage />);
    expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(4);
    expect(screen.queryByText("Scheduled Route Runs")).toBeNull();
    expect(screen.queryByText("Driver Status")).toBeNull();
  });
  it("first visit (nothing stored): not reserved", () => {
    routes = { enabled: false, resolved: false, pending: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(4);
  });
  it("storage blocked (accessor throws): no crash, not reserved", () => {
    const real = Storage.prototype.getItem;
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      k: string,
    ) {
      if (k.startsWith("rf:dash:")) throw new Error("blocked");
      return real.call(this, k);
    });
    try {
      routes = { enabled: false, resolved: false, pending: true };
      renderWithProviders(<DashboardPage />);
      expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(4);
    } finally {
      get.mockRestore();
    }
  });
  it("writes the resolved value, and a resolved-no tenant never gets a slot", () => {
    routes = { enabled: false, resolved: true };
    window.localStorage.setItem(KEY, "1");
    renderWithProviders(<DashboardPage />);
    expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(4);
    expect(window.localStorage.getItem(KEY)).toBe("0");
  });
  it("a reserved slot resolves to the real card when routes turn out enabled", () => {
    loading = false;
    routes = { enabled: true, resolved: true };
    renderWithProviders(<DashboardPage />);
    expect(labelsShown()).toEqual(ALL_LABELS);
    expect(window.localStorage.getItem(KEY)).toBe("1");
  });
});

describe("skeleton and loaded twins share one min-h constant per region", () => {
  const minH = (el: Element | null | undefined) => el?.className.match(/min-h-\[[^\]]+\]/)?.[0];
  it("AR aging, overdue, urgent and low stock", () => {
    const a = renderWithProviders(<DashboardPage />);
    const [ar, overdue, urgent, low] = screen.getAllByTestId("list-skeleton").map((n) => minH(n));
    a.unmount();
    loading = false;
    renderWithProviders(<DashboardPage />);
    const up = (text: string, sel: string) =>
      screen.getByRole("heading", { name: text }).closest(sel);
    expect(ar).toBeDefined();
    expect(minH(up("AR Aging", "div.overflow-hidden"))).toBe(ar);
    expect(minH(up("Overdue Invoices", "div.overflow-hidden"))).toBe(overdue);
    expect(minH(screen.getByText("All clear").closest("div.flex.items-center"))).toBe(urgent);
    expect(minH(up("Low Stock", "div.overflow-hidden"))).toBe(low);
  });
  it("the pipeline skeleton is hidden from assistive tech and not focusable", () => {
    renderWithProviders(<DashboardPage />);
    const p = screen.getByTestId("pipeline-skeleton");
    expect(p.getAttribute("aria-hidden")).toBe("true");
    p.querySelectorAll("a").forEach((l) => expect(l.getAttribute("tabindex")).toBe("-1"));
  });
});

describe("D3 list regions reserve a fixed min-h", () => {
  it("overdue, AR aging, urgent and low-stock skeletons all carry min-h", () => {
    const { container } = renderWithProviders(<DashboardPage />);
    const regions = Array.from(container.querySelectorAll("[data-testid='list-skeleton']"));
    expect(regions.length).toBeGreaterThanOrEqual(4);
    regions.forEach((r) => expect(r.className).toMatch(/min-h-\[/));
    expect(screen.getByTestId("pipeline-skeleton")).toBeTruthy();
  });
});

describe("D5 no feature lost: per-role cards, links and gates (loaded)", () => {
  beforeEach(() => {
    loading = false;
  });
  it("operator with routes: every card, panel and link", () => {
    const { container } = renderWithProviders(<DashboardPage />);
    expect(labelsShown()).toEqual(ALL_LABELS);
    const h = hrefs(container);
    [
      "/invoices/new",
      "/routes/create",
      "/orders?action=new",
      "/finance",
      "/invoices?status=OVERDUE",
      "/orders",
      "/routes",
      "/drivers",
      "/products?lowStock=true",
      "/finance/reports/ar-aging",
      "/orders?status=PENDING",
      "/orders?status=CONFIRMED",
      "/orders?status=OUT_FOR_DELIVERY",
      "/orders?status=DELIVERED",
      "/orders?status=CANCELLED",
    ].forEach((href) => expect(h).toContain(href));
    ["Scheduled Route Runs", "Driver Status", "Recent Orders", "Low Stock", "AR Aging"].forEach(
      (t) => expect(screen.getAllByText(t).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("pipeline-strip")).toBeTruthy();
  });
  it("Counter sale link shows for operator and customer only when the gate says so", () => {
    counterButton = true;
    const a = renderWithProviders(<DashboardPage />);
    expect(hrefs(a.container)).toContain("/orders/counter-sale");
    a.unmount();
    authUser = { id: "u1", role: "CUSTOMER", tenantSlug: "acme" };
    const b = renderWithProviders(<DashboardPage />);
    expect(hrefs(b.container)).toContain("/orders/counter-sale");
    b.unmount();
    counterButton = false;
    const c = renderWithProviders(<DashboardPage />);
    expect(hrefs(c.container)).not.toContain("/orders/counter-sale");
  });
  it("tenant admin renders the same as operator", () => {
    authUser = { id: "u1", role: "TENANT_ADMIN", tenantSlug: "acme" };
    renderWithProviders(<DashboardPage />);
    expect(labelsShown()).toEqual(ALL_LABELS);
  });
  it("operator without routes: no routes/drivers cards, links or panels", () => {
    routes = { enabled: false, resolved: true };
    const { container } = renderWithProviders(<DashboardPage />);
    expect(labelsShown()).toEqual([
      "Today's Revenue",
      "Overdue Invoices",
      "Active Orders",
      "Low Stock Items",
    ]);
    const h = hrefs(container);
    expect(h).not.toContain("/routes/create");
    expect(h).not.toContain("/drivers");
    expect(screen.queryByText("Scheduled Route Runs")).toBeNull();
    expect(screen.queryByText("Driver Status")).toBeNull();
  });
  it("customer: quick create, overdue + active orders, recent orders", () => {
    authUser = { id: "u1", role: "CUSTOMER", tenantSlug: "acme" };
    routes = { enabled: false, resolved: true };
    const { container } = renderWithProviders(<DashboardPage />);
    expect(labelsShown()).toEqual(["Overdue Invoices", "Active Orders"]);
    const h = hrefs(container);
    expect(h).toContain("/orders?action=new");
    expect(h).toContain("/orders");
    expect(screen.getByText("Recent Orders")).toBeTruthy();
  });
  it("driver with routes: redirect (renders nothing)", () => {
    authUser = { id: "u1", role: "DRIVER", tenantSlug: "acme" };
    const { container } = renderWithProviders(<DashboardPage />);
    expect(container.textContent).toBe("");
  });
  it("driver with no add-on: the no-routes card, no business cards", () => {
    authUser = { id: "u1", role: "DRIVER", tenantSlug: "acme" };
    routes = { enabled: false, resolved: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText("No routes to show yet")).toBeTruthy();
    expect(screen.queryByText("Recent Orders")).toBeNull();
  });
  it("dual-role operator with routes: the Switch view mode control", () => {
    authUser = { id: "u1", role: "OPERATOR", tenantSlug: "acme", canActAsDriver: true };
    renderWithProviders(<DashboardPage />);
    expect(screen.getByLabelText("Switch view mode")).toBeTruthy();
  });
});
