import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import DashboardPage from "./page";

// REG-B1015: a KPI whose query failed (or never answered) rendered as $0.00 / 0, indistinguishable from
// a real zero, and the order KPIs were counted from the newest 100 orders, so they stalled at 100.
// Like the customer page's CreditLimitPanel, an unknown figure is "—", never a zero; and the counts come
// from the server's own `meta.total` (exact), never from counting a capped list.

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

type Mode = "ok" | "loading" | "error" | "empty";
const mockRefetch = jest.fn();
let mode: Mode = "ok";
// A tenant with 250 PENDING, 30 CONFIRMED and 5 OUT_FOR_DELIVERY orders: far past the old 100 cap.
const TOTALS: Record<string, number> = {
  PENDING: 250,
  CONFIRMED: 30,
  OUT_FOR_DELIVERY: 5,
  DELIVERED: 400,
  CANCELLED: 12,
};
const state = () =>
  mode === "loading"
    ? { data: undefined, isLoading: true, isError: false }
    : mode === "error"
      ? { data: undefined, isLoading: false, isError: true, refetch: mockRefetch }
      : null;
const page = (total: number, rows: unknown[] = []) => ({
  data: { data: rows, meta: { total, page: 1, limit: rows.length || 1, totalPages: 1 } },
  isLoading: false,
  isError: false,
});

const orderCalls: { status?: string; options?: { refetchInterval?: number } }[] = [];
jest.mock("@/lib/api/orders", () => ({
  useOrders: (p: { status?: string; limit?: number }, options?: { refetchInterval?: number }) => {
    orderCalls.push({ status: p?.status, options });
    const s = state();
    if (s) return s;
    if (p?.status) return page(TOTALS[p.status]);
    // the list queries (recent / urgent / the old limit-100 fetch): a capped window of the PENDING rows
    const rows = Array.from({ length: p?.limit ?? 20 }, (_, i) => ({
      id: `o${i}`,
      orderNumber: `ORD-${i}`,
      status: "PENDING",
      urgent: false,
      total: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      customer: { businessName: "Acme" },
      lineItems: [],
    }));
    return page(250, rows);
  },
}));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () =>
    state() ?? {
      data: { summaryTable: { today: { sales: 1234.5 } }, arAging: null },
      isLoading: false,
      isError: false,
    },
}));
jest.mock("@/lib/api/invoices", () => ({
  useInvoices: () => state() ?? (mode === "empty" ? page(0, []) : page(7)),
}));
jest.mock("@/lib/api/routes", () => ({ useRouteRuns: () => state() ?? page(3) }));
jest.mock("@/lib/api/drivers", () => ({
  useDrivers: (p: { status?: string }) => state() ?? (p?.status === "ACTIVE" ? page(41) : page(60)),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => state() ?? (mode === "empty" ? page(0, []) : page(9)),
}));

// The StatCard label (the uppercase <p>), not a panel heading of the same words.
const tile = (label: string) =>
  screen
    .getAllByText(label)
    .find((el) => el.tagName === "P" && el.className.includes("uppercase"))!
    .closest("[class*='rounded-card']") as HTMLElement;

describe("Dashboard KPIs — unknown is never zero (REG-B1015)", () => {
  beforeEach(() => {
    mode = "ok";
  });

  it("counts orders exactly past 100: Active Orders is the server totals, not a capped list", () => {
    renderWithProviders(<DashboardPage />);
    // 250 + 30 + 5. The old code counted the newest 100 rows and read 100.
    expect(tile("Active Orders")).toHaveTextContent("285");
    // the pipeline strip uses the same exact counts
    expect(screen.getByText("Out for Delivery").previousSibling).toHaveTextContent("5");
    expect(screen.getByText("Delivered").previousSibling).toHaveTextContent("400");
  });

  it("Active Drivers is the server's ACTIVE total, not a count over the first 20 drivers", () => {
    renderWithProviders(<DashboardPage />);
    expect(tile("Active Drivers")).toHaveTextContent("41");
  });

  it("shows real figures when everything loads (control)", () => {
    renderWithProviders(<DashboardPage />);
    expect(tile("Today's Revenue")).toHaveTextContent("$1,234.50");
    expect(tile("Overdue Invoices")).toHaveTextContent("7");
    expect(tile("Scheduled Routes")).toHaveTextContent("3");
    expect(tile("Low Stock Items")).toHaveTextContent("9");
  });

  it("a failed query shows — on every KPI, never $0.00 or 0", () => {
    mode = "error";
    renderWithProviders(<DashboardPage />);
    for (const label of [
      "Today's Revenue",
      "Overdue Invoices",
      "Active Orders",
      "Scheduled Routes",
      "Active Drivers",
      "Low Stock Items",
    ]) {
      const t = tile(label);
      expect(t).toHaveTextContent("—");
      expect(t).not.toHaveTextContent("$0.00");
      expect(t.querySelector("p:nth-of-type(2)")?.textContent).toBe("—");
    }
  });

  it("while loading, no KPI tile claims a figure", () => {
    mode = "loading";
    renderWithProviders(<DashboardPage />);
    expect(screen.queryAllByText("Today's Revenue")).toHaveLength(0);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  // The panels below the tiles: a FAILED request must not read as the good-news empty state.
  it("a failed overdue / low-stock request says so with a retry, never the all-clear text", () => {
    mode = "error";
    renderWithProviders(<DashboardPage />);

    expect(screen.getByText("Couldn't load overdue invoices")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load low stock items")).toBeInTheDocument();
    expect(screen.queryByText("No overdue invoices")).not.toBeInTheDocument();
    expect(screen.queryByText("All stock levels healthy")).not.toBeInTheDocument();

    const retries = screen.getAllByRole("button", { name: /retry/i });
    expect(retries.length).toBeGreaterThanOrEqual(2);
    mockRefetch.mockClear();
    retries.forEach((b) => fireEvent.click(b));
    expect(mockRefetch).toHaveBeenCalledTimes(retries.length);
  });

  it("a SUCCESSFUL empty response keeps the all-clear text (and no error copy)", () => {
    mode = "empty";
    renderWithProviders(<DashboardPage />);

    expect(screen.getByText("No overdue invoices")).toBeInTheDocument();
    expect(screen.getByText("All stock levels healthy")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load overdue invoices")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load low stock items")).not.toBeInTheDocument();
  });

  // Each dashboard poll made 7 GET /orders; ~7 dashboards behind one shop IP hit the 100/min limit. The
  // all-time Delivered / Cancelled counts barely move, so they are fetched once, not polled.
  it("does not poll the all-time Delivered / Cancelled counts, and labels them all time", () => {
    orderCalls.length = 0;
    renderWithProviders(<DashboardPage />);

    const optionsFor = (status: string) => orderCalls.find((c) => c.status === status)?.options;
    expect(optionsFor("DELIVERED")?.refetchInterval).toBeUndefined();
    expect(optionsFor("CANCELLED")?.refetchInterval).toBeUndefined();
    // the live counts still poll
    expect(optionsFor("PENDING")?.refetchInterval).toBe(30_000);
    expect(optionsFor("OUT_FOR_DELIVERY")?.refetchInterval).toBe(30_000);

    expect(screen.getAllByText("all time")).toHaveLength(2);
  });

  // Layout (jsdom has no layout engine, so the DOM contract is what is pinned; the pixels are re-shot on
  // the PC): at 390 the strip's five cells clipped "Confirmed" / "Delivered" / "Cancelled", and a tile's
  // value ran under its icon with its label truncated.
  it("the pipeline strip scrolls INSIDE itself instead of clipping its cells, with all five cells and the all-time label", () => {
    renderWithProviders(<DashboardPage />);

    const strip = screen.getByTestId("pipeline-strip");
    expect(strip.className).toContain("overflow-x-auto");
    const cells = strip.querySelectorAll("a");
    expect(cells).toHaveLength(5);
    expect(Array.from(cells).map((a) => a.getAttribute("href"))).toEqual([
      "/orders?status=PENDING",
      "/orders?status=CONFIRMED",
      "/orders?status=OUT_FOR_DELIVERY",
      "/orders?status=DELIVERED",
      "/orders?status=CANCELLED",
    ]);
    // "all time" sits on its own small line inside its cell, not beside the label
    expect(screen.getAllByText("all time")).toHaveLength(2);
    cells.forEach((a) => expect(a.className).toContain("whitespace-nowrap"));
  });

  it("every KPI tile lets its label wrap and its value shrink so neither runs under the icon", () => {
    renderWithProviders(<DashboardPage />);

    for (const label of [
      "Today's Revenue",
      "Overdue Invoices",
      "Active Orders",
      "Scheduled Routes",
      "Active Drivers",
      "Low Stock Items",
    ]) {
      const t = tile(label);
      expect(t.className).toContain("[&_p:first-child]:whitespace-normal");
      expect(t.className).toContain("[&_p:nth-child(2)]:break-words");
    }
  });
});
