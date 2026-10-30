import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, within } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * Orders list Filters panel across a resize and a close (row 730, orders apple-ux r4 Q01 review):
 *  - the panel's open state is reset when the viewport leaves phone width, so coming back down to a phone does not
 *    pop a dialog nobody asked for
 *  - the header X returns focus to the Filters button, like Done and Escape
 *  - the Filters button is a 44 px target, and the clear-dates X is named
 * jsdom has no layout: sizes are pinned on the class tokens; the measured boxes are the host-run capture's job.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(query),
}));
let query = "";

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
const rows = [order({ id: "o1" })];
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

// ── a viewport whose width can change while mounted ───────────────────────────────────────────────────────────────
let width = 390;
const listeners = new Set<() => void>();
const realMatchMedia = window.matchMedia;
function installViewport() {
  window.matchMedia = ((q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    return {
      get matches() {
        return max ? width <= Number(max[1]) : false;
      },
      media: q,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
      onchange: null,
    };
  }) as unknown as typeof window.matchMedia;
}
const resize = (w: number) =>
  act(() => {
    width = w;
    listeners.forEach((l) => l());
  });

beforeEach(() => {
  query = "";
  width = 390;
  listeners.clear();
  installViewport();
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const filtersButton = () => screen.queryByRole("button", { name: /^filters/i });
const panel = () => screen.queryByRole("dialog", { name: "Filters" });
const tokens = (el: Element | null) =>
  (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("Filters panel and the viewport", () => {
  it("widening past md closes the panel and shows the inline filters", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    expect(panel()).not.toBeNull();
    resize(1024);
    expect(panel()).toBeNull();
    expect(filtersButton()).toBeNull();
    expect(screen.getByRole("combobox", { name: "Fulfillment" })).toBeVisible();
  });

  it("narrowing again later does NOT bring the panel back (the open state was reset)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    resize(1024);
    resize(390);
    expect(panel()).toBeNull();
    expect(filtersButton()).not.toBeNull();
  });
});

describe("Filters panel focus and touch size", () => {
  it("the header X returns focus to the Filters button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    await user.click(within(panel()!).getByRole("button", { name: "Close" }));
    expect(panel()).toBeNull();
    expect(filtersButton()).toHaveFocus();
  });

  it("the Filters button is a 44 px target", () => {
    renderWithProviders(<OrdersPage />);
    expect(tokens(filtersButton())).toContain("h-11");
    expect(tokens(filtersButton())).not.toContain("h-10");
  });

  it("the clear-dates X has an accessible name", async () => {
    query = "dateFrom=2026-10-01";
    const user = userEvent.setup();
    renderWithProviders(<OrdersPage />);
    await user.click(filtersButton()!);
    expect(within(panel()!).getByRole("button", { name: "Clear dates" })).toHaveAttribute(
      "aria-label",
      "Clear dates",
    );
  });
});
