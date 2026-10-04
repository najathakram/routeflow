import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// SHIP fulfilment mode: the order's fulfilment toggle is hidden (every order ships by carrier). Every
// other account, including one with no fleet modules, keeps the "Delivery route / Ship via carrier"
// toggle exactly as before.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
let ship = false;
jest.mock("@/lib/ship-mode", () => ({ useShipMode: () => ship }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

describe("CreateOrderModal — fulfilment toggle (SHIP mode)", () => {
  it("ship mode: no Fulfillment toggle", () => {
    ship = true;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Delivery route" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ship via carrier" })).not.toBeInTheDocument();
    expect(screen.queryByText("Fulfillment")).not.toBeInTheDocument();
  });

  it("not ship mode (today's UI, unchanged): the toggle is there", () => {
    ship = false;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Delivery route" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ship via carrier" })).toBeInTheDocument();
  });
});
