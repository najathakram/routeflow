import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// A ship-only account that submits BEFORE /tenants/me/features answers must never send ROUTE: the submit
// waits for staffFulfilment.known (CustomerFormModal's rule).
window.HTMLElement.prototype.scrollIntoView = jest.fn();
// `caps` = capabilities.fulfilment (undefined = UNSET: loading, an older API, no fulfilment mode set).
let caps: Record<string, unknown> | undefined;
const createOrderMutate = jest.fn();
let featuresError = false;
const refetchFeatures = jest.fn();
const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 1 };
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
  useTenantFeatures: () => ({
    data: caps ? { capabilities: { fulfilment: caps } } : undefined,
    isError: featuresError,
    refetch: refetchFeatures,
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [cust] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
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

const pickCustomer = async () => {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
};

describe("CreateOrderModal — submit waits for the fulfilment answer", () => {
  beforeEach(() => {
    createOrderMutate.mockClear();
    refetchFeatures.mockClear();
    featuresError = false;
  });

  it("features FAILED: inline notice + Retry, submit stays disabled, nothing is sent; Retry then ship-only sends SHIP", async () => {
    caps = undefined;
    featuresError = true;
    const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    expect(screen.getByText("Couldn't load your delivery settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create order/i })).toBeDisabled();
    const draft = screen.getByRole("button", { name: /save as draft/i });
    expect(draft).toBeDisabled();
    fireEvent.click(draft);
    expect(createOrderMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchFeatures).toHaveBeenCalledTimes(1);
    featuresError = false;
    caps = account({});
    view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    expect(screen.queryByText("Couldn't load your delivery settings.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[0][0].fulfillPath).toBe("SHIP");
  });

  it("features pending: Create Order and Save as Draft are disabled and nothing is sent", async () => {
    caps = undefined;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    expect(screen.getByRole("button", { name: /create order/i })).toBeDisabled();
    const draft = screen.getByRole("button", { name: /save as draft/i });
    expect(draft).toBeDisabled();
    fireEvent.click(draft);
    expect(createOrderMutate).not.toHaveBeenCalled();
  });

  it("once known (ship-only), the submit sends SHIP", async () => {
    caps = undefined;
    const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    caps = account({});
    view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const draft = screen.getByRole("button", { name: /save as draft/i });
    await waitFor(() => expect(draft).toBeEnabled());
    fireEvent.click(draft);
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0].fulfillPath).toBe("SHIP");
  });
});
