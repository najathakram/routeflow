import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * Row 331, replaced by W-854 (SA-940 verdict 1): a store-only business carries the one New order, whose Regular order
 * opens the builder (POS mode for such a tenant), and its phone header keeps Export and Select in a More menu.
 * `?action=new&builder=1` (also the target of /orders/new) opens the builder even when the counter is the default.
 */
const push = jest.fn();
const replace = jest.fn();
let search = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(search),
}));
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), user: { id: "u1", role: mockRole } }),
  };
});
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrders: () => ({
    data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
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
let gate: Record<string, unknown> = {};
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ permsKnown: true, ...gate }),
}));
jest.mock("./_components/CreateOrderModal", () => ({
  CreateOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="order-builder-open" /> : null,
}));

const STORE_ONLY = {
  showButton: true,
  offerShipInstead: false,
  mayUseTill: true,
  capability: { counter: "always", methods: ["PICKUP"], staffOpensAs: "counter" },
};
beforeEach(() => {
  jest.clearAllMocks();
  search = "";
  mockRole = "OPERATOR";
  gate = { showButton: false, offerShipInstead: false, mayUseTill: true };
});

describe("Orders page — Invoice order entry (row 331)", () => {
  it("a store-only tenant: New order is the filled primary, and its menu reaches both", async () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    const newOrder = screen.getByRole("button", { name: "New order" });
    expect(newOrder).toHaveClass("bg-accent-strong");
    expect(screen.queryByRole("button", { name: "Counter sale" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invoice a customer" })).toBeNull();
    const user = userEvent.setup();
    await user.click(newOrder);
    await user.click(await screen.findByRole("menuitem", { name: /regular order/i }));
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("a store-only tenant: New order is a 44 px target below sm, and Export + Select move into a More menu", async () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: "New order" }).className).toMatch(/max-sm:h-11/);
    // The menu trigger only exists below sm, where it is always 44 px.
    const more = screen.getByRole("button", { name: "More actions" });
    expect(more.className).toMatch(/\bh-11\b/);
    expect(more.className).toMatch(/\bw-11\b/);
    expect(more.className).toMatch(/\bsm:hidden\b/);
    // The inline Export and Select stay for sm and up; below sm they are hidden and live in the menu.
    for (const name of ["Export", "Select"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/max-sm:hidden/);
    }
    await userEvent.setup().click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Select" })).toBeInTheDocument();
  });

  it("a store-only tenant's primary trails: [Export][Select][More][New order]", () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    const order = ["Export", "Select", "More actions", "New order"];
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    const positions = order.map((n) => names.findIndex((x) => x === n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Below sm Export and Select are hidden, which leaves [More][New order].
    // From sm up the More menu is hidden, which leaves [Export][Select][New order].
  });

  it("a delivery tenant: New order is the primary, Export and Select stay inline, no More menu", () => {
    gate = {
      showButton: true,
      offerShipInstead: false,
      mayUseTill: true,
      capability: { counter: "optional", methods: ["ROUTE"], staffOpensAs: "order" },
    };
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: "New order" })).toHaveClass("bg-accent-strong");
    expect(screen.queryByRole("button", { name: "Counter sale" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    for (const name of ["Export", "Select"]) {
      expect(screen.getByRole("button", { name }).className).not.toMatch(/max-sm:hidden/);
    }
  });

  it("?action=new&builder=1 opens the builder even when the counter is the default", () => {
    gate = STORE_ONLY;
    search = "action=new&builder=1";
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("?action=new alone opens the menu on a counter-default tenant", async () => {
    gate = STORE_ONLY;
    search = "action=new";
    renderWithProviders(<OrdersPage />);
    expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
    expect(replace).not.toHaveBeenCalledWith("/orders/counter-sale");
  });
});
