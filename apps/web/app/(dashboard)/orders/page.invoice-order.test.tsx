import * as React from "react";
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
jest.mock("@/lib/api/counter-sale", () => ({ useCounterSaleGate: () => gate }));
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
  it("a store-only tenant sees Invoice order; New Order still opens the counter", () => {
    gate = STORE_ONLY;
    renderWithProviders(<OrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: "New Order" }));
    expect(push).toHaveBeenCalledWith("/orders/counter-sale");
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Invoice order" }));
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("any other tenant has no Invoice order button", () => {
    gate = {
      showButton: true,
      opensAsCounter: true,
      offerShipInstead: true,
      offerInvoiceOrder: false,
    };
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("button", { name: "Invoice order" })).toBeNull();
  });

  it("a role that cannot use POS mode does not get the entry", () => {
    gate = STORE_ONLY;
    mockRole = "SUPER_ADMIN";
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("button", { name: "Invoice order" })).toBeNull();
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
