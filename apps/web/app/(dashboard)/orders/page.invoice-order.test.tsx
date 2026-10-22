import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * Row 331: a store-only business (capabilities.fulfilment: PICKUP only, counter always) gets an "Invoice order"
 * entry beside New Order and the counter. New Order still opens the counter; the entry opens the builder, which
 * runs in POS mode for such a tenant. `?action=new&builder=1` (also the target of /orders/new) opens the builder
 * even when the counter is the default, with no ship option involved.
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
  opensAsCounter: true,
  offerShipInstead: false,
  offerInvoiceOrder: true,
};
beforeEach(() => {
  jest.clearAllMocks();
  search = "";
  mockRole = "OPERATOR";
  gate = {
    showButton: false,
    opensAsCounter: false,
    offerShipInstead: false,
    offerInvoiceOrder: false,
  };
});

describe("Orders page — Invoice order entry (row 331)", () => {
  it("a store-only tenant: Counter sale is the filled primary, Invoice a customer is secondary, no New Order", () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    // New Order went to the same place as Counter sale, so it is gone (UX G7).
    expect(screen.queryByRole("button", { name: "New Order" })).toBeNull();
    const counter = screen.getByRole("button", { name: "Counter sale" });
    const invoice = screen.getByRole("button", { name: "Invoice a customer" });
    expect(counter).toHaveClass("bg-accent-strong");
    expect(invoice).toHaveClass("bg-paper");
    fireEvent.click(counter);
    expect(push).toHaveBeenCalledWith("/orders/counter-sale");
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
    fireEvent.click(invoice);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("a store-only tenant: the two actions are 44 px targets below sm, and Export + Select move into a More menu", async () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    for (const name of ["Counter sale", "Invoice a customer"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/max-sm:h-11/);
    }
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

  it("a store-only tenant's primary trails: [Export][Select][More][Invoice a customer][Counter sale]", () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    const order = ["Export", "Select", "More actions", "Invoice a customer", "Counter sale"];
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    const positions = order.map((n) => names.findIndex((x) => x === n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Below sm Export and Select are hidden, which leaves [More][Invoice a customer][Counter sale].
    // From sm up the More menu is hidden, which leaves [Export][Select][Invoice a customer][Counter sale].
  });

  it("a delivery tenant is unchanged: New Order is the primary, Export and Select stay inline, no More menu", () => {
    gate = {
      showButton: true,
      opensAsCounter: false,
      offerShipInstead: false,
      offerInvoiceOrder: false,
    };
    renderWithProviders(<OrdersPage />);
    expect(screen.getByRole("button", { name: "New Order" })).toHaveClass("bg-accent-strong");
    expect(screen.getByRole("button", { name: "Counter sale" })).toHaveClass("bg-paper");
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    for (const name of ["Export", "Select"]) {
      expect(screen.getByRole("button", { name }).className).not.toMatch(/max-sm:hidden/);
    }
  });

  it("any other tenant has no Invoice order button", () => {
    gate = {
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: true,
      offerInvoiceOrder: false,
    };
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("button", { name: "Invoice a customer" })).toBeNull();
  });

  it("a role that cannot use POS mode does not get the entry", () => {
    gate = STORE_ONLY;
    mockRole = "SUPER_ADMIN";
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("button", { name: "Invoice a customer" })).toBeNull();
  });

  it("?action=new&builder=1 opens the builder even when the counter is the default", () => {
    gate = STORE_ONLY;
    search = "action=new&builder=1";
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalledWith("/orders/counter-sale");
  });

  it("?action=new alone still redirects a counter-default tenant to the counter", () => {
    gate = STORE_ONLY;
    search = "action=new";
    renderWithProviders(<OrdersPage />);
    expect(replace).toHaveBeenCalledWith("/orders/counter-sale");
  });
});
