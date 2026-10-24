import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// SHIP fulfilment mode: the order's fulfilment toggle is hidden (every order ships by carrier). Every
// other account, including one with no fleet modules, keeps the "Delivery route / Ship via carrier"
// toggle exactly as before.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
// `caps` = capabilities.fulfilment (undefined = UNSET: loading, an older API, no fulfilment mode set).
let caps: Record<string, unknown> | undefined;
const account = (over: Record<string, unknown>) => ({
  methods: ["SHIP"],
  staffDefault: "SHIP",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: false,
  consistent: true,
  ...over,
});
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ data: caps ? { capabilities: { fulfilment: caps } } : undefined }),
}));
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

const route = () => screen.queryByRole("button", { name: "Delivery route" });
const ship = () => screen.queryByRole("button", { name: "Ship via carrier" });

describe("CreateOrderModal — fulfilment toggle", () => {
  it("ship mode: no Fulfillment toggle", () => {
    caps = account({});
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(route()).not.toBeInTheDocument();
    expect(ship()).not.toBeInTheDocument();
    expect(screen.queryByText("Fulfillment")).not.toBeInTheDocument();
  });

  it("not set (today's UI, unchanged): the toggle is there", () => {
    caps = undefined;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(route()).toBeInTheDocument();
    expect(ship()).toBeInTheDocument();
  });

  it("F-c: pickup mode shows no toggle and offers no 'Delivery route'", () => {
    caps = account({ methods: ["PICKUP"], staffDefault: "PICKUP", counter: "always" });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(route()).not.toBeInTheDocument();
    expect(screen.queryByText("Fulfillment")).not.toBeInTheDocument();
  });

  it("F-c: pickup_ship has only the methods it has: no hard-coded 'Delivery route'", () => {
    caps = account({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP", counter: "always" });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(route()).not.toBeInTheDocument();
  });

  it("a delivery + ship account (both) keeps both choices", () => {
    caps = account({
      methods: ["ROUTE", "SHIP"],
      staffDefault: "ROUTE",
      portalMethods: ["ROUTE", "SHIP"],
      fleet: true,
    });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(route()).toBeInTheDocument();
    expect(ship()).toBeInTheDocument();
  });

  it("F-a: consistent=false (delivery mode whose fleet is gone) keeps today's ROUTE/SHIP toggle", () => {
    caps = account({ methods: ["ROUTE"], staffDefault: "ROUTE", fleet: false, consistent: false });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(route()).toBeInTheDocument();
    expect(ship()).toBeInTheDocument();
  });
});
