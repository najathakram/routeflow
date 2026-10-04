import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import OrdersPage from "./page";

/**
 * The counter-sale gate on the Orders page (capabilities.fulfilment.counter, via useCounterSaleGate only):
 *  - always   -> "New Order" OPENS AS the counter sale; ?action=new redirects there unless the operator chose ?ship=1
 *  - optional -> a "Counter sale" button beside the unchanged "New Order"
 *  - off      -> neither (nothing changes)
 */
const push = jest.fn();
const replace = jest.fn();
let search = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(search),
}));
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

const OFF = { showButton: false, opensAsCounter: false, offerShipInstead: false };
beforeEach(() => {
  jest.clearAllMocks();
  search = "";
  gate = OFF;
});

describe("Orders page — counter sale gate", () => {
  it("off: no Counter sale button; New Order opens the normal builder", () => {
    renderWithProviders(<OrdersPage />);
    expect(screen.queryByRole("button", { name: "Counter sale" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New Order" }));
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("optional: a Counter sale button; New Order is unchanged", () => {
    gate = { showButton: true, opensAsCounter: false, offerShipInstead: false };
    renderWithProviders(<OrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: "Counter sale" }));
    expect(push).toHaveBeenCalledWith("/orders/counter-sale");
    fireEvent.click(screen.getByRole("button", { name: "New Order" }));
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
  });

  it("always: New Order OPENS AS the counter sale (no builder)", () => {
    gate = { showButton: true, opensAsCounter: true, offerShipInstead: true };
    renderWithProviders(<OrdersPage />);
    fireEvent.click(screen.getByRole("button", { name: "New Order" }));
    expect(push).toHaveBeenCalledWith("/orders/counter-sale");
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
  });

  it("always: ?action=new (a dashboard link) redirects to the counter sale", () => {
    gate = { showButton: true, opensAsCounter: true, offerShipInstead: true };
    search = "action=new";
    renderWithProviders(<OrdersPage />);
    expect(replace).toHaveBeenCalledWith("/orders/counter-sale");
    expect(screen.queryByTestId("order-builder-open")).toBeNull();
  });

  it("always + 'Ship this order instead' (?action=new&ship=1): the normal builder opens", () => {
    gate = { showButton: true, opensAsCounter: true, offerShipInstead: true };
    search = "action=new&ship=1";
    renderWithProviders(<OrdersPage />);
    expect(screen.getByTestId("order-builder-open")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalledWith("/orders/counter-sale");
  });
});
