import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * Orders list at phone width (orders apple-ux r4, Q01/Q05/Q06/Q07). Below md the secondary filters (sort, fulfilment,
 * urgent only, product, delivery range) stacked above the list and pushed the first order to y~750 of 844. They now live
 * behind ONE "Filters" button (count badge of the active ones) while the search box and the status chips stay put.
 * jsdom has no layout, so these pin the behaviour (what renders, what the button says, where focus goes); the pixel
 * claims (first order on screen at 390x844, one right edge, no overflow) are proven in the browser.
 */

// ── URL state: a tiny store so router.replace() really changes what useSearchParams() returns ─────────────────────
let currentQuery = "";
const listeners = new Set<() => void>();
const setQuery = (q: string) => {
  currentQuery = q;
  listeners.forEach((l) => l());
};
const replace = jest.fn((url: string) => setQuery(url.split("?")[1] ?? ""));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => "/orders",
  useSearchParams: () => {
    const q = React.useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => currentQuery,
      () => currentQuery,
    );
    return React.useMemo(() => new URLSearchParams(q), [q]);
  },
}));

const order = (over: Record<string, unknown>) => ({
  id: "o1",
  orderNumber: "ORD-1",
  status: "CONFIRMED",
  fulfillPath: "ROUTE",
  total: 25,
  createdAt: "2026-10-08T12:00:00.000Z",
  deliveryDate: null,
  customer: { id: "c1", businessName: "Acme Co" },
  lineItems: [{ id: "li1" }],
  _count: { changeRequests: 0 },
  ...over,
});
const rows = [order({ id: "o1" }), order({ id: "o2", orderNumber: "ORD-2" })];
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateOrderStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useBulkDeleteOrders: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));

// ── viewport: jsdom has no matchMedia; "narrow" = below md (768px) ────────────────────────────────────────────────
const realMatchMedia = window.matchMedia;
function setViewport(width: number) {
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query) ? width >= 768 : false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  currentQuery = "";
  replace.mockClear();
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

// The five secondary controls, by role / name / placeholder / title.
const sortSelect = () => screen.queryByRole("combobox", { name: "Sort orders by" });
const urgentButton = () => screen.queryByRole("button", { name: /^urgent only/i });
const productPicker = () => screen.queryByPlaceholderText("Filter by product…");
const dateFrom = () => screen.queryByTitle("Delivery date from");
const dateTo = () => screen.queryByTitle("Delivery date to");
const filtersButton = () => screen.queryByRole("button", { name: /^filters/i });

describe("OrdersPage at phone width: secondary filters behind one Filters button", () => {
  beforeEach(() => setViewport(390));

  it("does not render the secondary filters inline; search and the status chips stay visible", () => {
    renderWithProviders(<OrdersPage />);
    expect(sortSelect()).toBeNull();
    expect(urgentButton()).toBeNull();
    expect(productPicker()).toBeNull();
    expect(dateFrom()).toBeNull();
    expect(dateTo()).toBeNull();
    expect(screen.getByRole("searchbox")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Draft/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Confirmed/ })).toBeVisible();
  });

  it("shows ONE Filters button, with no count badge while nothing is active", () => {
    renderWithProviders(<OrdersPage />);
    expect(screen.getAllByRole("button", { name: /^filters/i })).toHaveLength(1);
    expect(filtersButton()).toHaveAccessibleName("Filters");
    expect(filtersButton()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("opening it shows every secondary filter in a Filters dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    expect(within(dialog).getByRole("combobox", { name: "Sort orders by" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: /^urgent only/i })).toBeVisible();
    expect(within(dialog).getByPlaceholderText("Filter by product…")).toBeVisible();
    expect(within(dialog).getByTitle("Delivery date from")).toBeVisible();
    expect(within(dialog).getByTitle("Delivery date to")).toBeVisible();
    expect(within(dialog).getByRole("combobox", { name: "Fulfillment" })).toBeVisible();
  });

  it("applying a filter updates the count on the button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    await user.click(
      within(screen.getByRole("dialog", { name: "Filters" })).getByRole("button", {
        name: /^urgent only/i,
      }),
    );
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("urgent=1"), expect.anything());
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(filtersButton()).toHaveAccessibleName("Filters, 1 active");
    expect(filtersButton()).toHaveTextContent("1");
  });

  it("counts each active filter once (a date range is one)", () => {
    currentQuery = "urgent=1&fulfillPath=SHIP&dateFrom=2026-10-01&dateTo=2026-10-09&productId=p1";
    renderWithProviders(<OrdersPage />);
    expect(filtersButton()).toHaveAccessibleName("Filters, 4 active");
  });

  it("Clear resets every secondary filter in ONE write and removes the badge", async () => {
    currentQuery = "urgent=1&fulfillPath=SHIP&dateFrom=2026-10-01&dateTo=2026-10-09&status=DRAFT";
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    expect(filtersButton()).toHaveAccessibleName("Filters, 3 active");
    await user.click(filtersButton()!);
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    await user.click(within(dialog).getByRole("button", { name: "Clear filters" }));
    expect(replace).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(String(replace.mock.calls[0][0]).split("?")[1]);
    expect(params.get("urgent")).toBeNull();
    expect(params.get("fulfillPath")).toBeNull();
    expect(params.get("dateFrom")).toBeNull();
    expect(params.get("dateTo")).toBeNull();
    // the status chips are not secondary filters: Clear leaves the chosen status alone
    expect(params.get("status")).toBe("DRAFT");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(filtersButton()).toHaveAccessibleName("Filters");
  });

  it("returns focus to the Filters button when the panel closes (Done and Escape)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(filtersButton()).toHaveFocus();

    await user.click(filtersButton()!);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(filtersButton()).toHaveFocus();
  });

  it("an active product filter stays a removable chip inside the panel", async () => {
    currentQuery = "productId=p1";
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    await user.click(within(dialog).getByTitle("Remove product filter"));
    expect(replace).toHaveBeenCalled();
    expect(String(replace.mock.calls.at(-1)![0])).not.toContain("productId");
  });

  it("lays the delivery range out as one unit: From, 'to', To in one row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    const from = within(dialog).getByTitle("Delivery date from");
    const to = within(dialog).getByTitle("Delivery date to");
    const row = from.parentElement!;
    expect(to.parentElement).toBe(row);
    const kids = Array.from(row.children);
    const iFrom = kids.indexOf(from);
    const iTo = kids.indexOf(to);
    expect(iTo).toBeGreaterThan(iFrom);
    expect(kids.slice(iFrom + 1, iTo).map((k) => k.textContent)).toEqual(["to"]);
  });

  it("keeps the skip link right after the search box, before the rows, targeting #orders-list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    const link = screen.getByRole("link", { name: "Skip to orders (2)" });
    await user.click(screen.getByRole("searchbox"));
    await user.tab();
    expect(link).toHaveFocus();
    const target = document.getElementById(link.getAttribute("href")!.replace(/^#/, ""));
    expect(target).not.toBeNull();
    expect(target).toHaveTextContent("ORD-1");
    const firstRow = document.querySelector("[data-order-row]")!;
    expect(link.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the status chip row shows an edge fade while it overflows (it reads as scrollable)", () => {
    const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => 900,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 342,
    });
    try {
      renderWithProviders(<OrdersPage />);
      const chip = screen.getByRole("button", { name: /^Draft/ });
      let el = chip.parentElement;
      while (el && !el.querySelector('[data-scroll-hint="right"]')) el = el.parentElement;
      const hint = el?.querySelector('[data-scroll-hint="right"]') ?? null;
      expect(hint).not.toBeNull();
      expect(hint).toHaveAttribute("data-visible", "true");
      // the fade belongs to the scroller that holds the chips
      expect(hint!.parentElement!.firstElementChild).toContainElement(chip);
    } finally {
      if (sw) Object.defineProperty(HTMLElement.prototype, "scrollWidth", sw);
      if (cw) Object.defineProperty(HTMLElement.prototype, "clientWidth", cw);
    }
  });
});

describe("OrdersPage at md and up: today's inline layout", () => {
  beforeEach(() => setViewport(1024));

  it("keeps every secondary filter inline and has no Filters button", () => {
    renderWithProviders(<OrdersPage />);
    expect(filtersButton()).toBeNull();
    expect(urgentButton()).not.toBeNull();
    expect(productPicker()).not.toBeNull();
    expect(dateFrom()).not.toBeNull();
    expect(dateTo()).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Fulfillment" })).toBeVisible();
  });
});
