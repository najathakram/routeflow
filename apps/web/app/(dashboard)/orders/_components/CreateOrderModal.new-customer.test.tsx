import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { apiClient } from "@/lib/api-client";

/**
 * W-1041 (SA-1062 R2, MUSTs 5-7): the builder's customer search offers `Add "<typed>" as a new customer`. The new customer
 * is picked with `keepPath`: the order keeps the path the clerk chose (a new customer's record holds the form default,
 * not the clerk's choice). The window asks for an address on ROUTE or SHIP and not on a pickup path (POS mode).
 */
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createCustomer = jest.fn();
const NEW_CUSTOMER = {
  id: "c-new",
  businessName: "Acme Cafe",
  contactName: "Acme Cafe",
  pricingTier: 1,
  fulfillPath: "ROUTE",
};
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return {
    ...actual,
    useAuth: () => ({ ...actual.useAuth(), user: { id: "u1", role: "OPERATOR" } }),
  };
});
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: {
      capabilities: {
        fulfilment: {
          methods: ["ROUTE", "SHIP"],
          staffDefault: "ROUTE",
          portalMethods: [],
          portalDefault: null,
          counter: "always",
          fleet: true,
          staffOpensAs: "order",
          consistent: true,
        },
      },
    },
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
  useCreateCustomer: () => ({
    mutate: (payload: unknown, opts?: { onSuccess?: (d: unknown) => void }) => {
      createCustomer(payload);
      opts?.onSuccess?.({ customer: NEW_CUSTOMER, user: {}, tempPassword: "x" });
    },
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useUpdateCustomer: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
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
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/sales-agents", () => ({ useSalesAgents: () => ({ data: undefined }) }));
jest.mock("../../sales-agents/_components/AgentFormModal", () => ({ AgentFormModal: () => null }));
jest.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: (p: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="Street" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: true, resolved: true }),
  useScanV2: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("./scan/ScanOrderScreen", () => ({ ScanOrderScreen: () => null }));
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));

const SHIP_NOTE = /Ships via carrier/;
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const openDoor = async () => {
  fireEvent.change(await screen.findByPlaceholderText("Search by business name…"), {
    target: { value: "Acme Cafe" },
  });
  const addName = { name: 'Add "Acme Cafe" as a new customer' };
  await waitFor(() => expect(screen.queryByRole("button", addName)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", addName));
};

beforeEach(() => {
  jest.clearAllMocks();
  (apiClient.get as jest.Mock).mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/users/me/preferences" ? {} : { taxRate: 0 } }),
  );
});

describe("CreateOrderModal: a new customer in the builder (W-1041)", () => {
  it("R2: the picked customer does not reset the path the clerk chose (Ship via carrier stays)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} initialFulfillPath="SHIP" />);
    expect(await screen.findByText(SHIP_NOTE)).toBeInTheDocument();
    await openDoor();
    type("Business Name", "Acme Cafe");
    type("Street", "1 Main St");
    type("City", "Austin");
    type("ZIP Code", "78701");
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(createCustomer).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Change customer")).toBeInTheDocument();
    expect(screen.getByText(SHIP_NOTE)).toBeInTheDocument();
  });

  it("MUST 6: a delivery path asks for the address before it saves", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} initialFulfillPath="SHIP" />);
    await openDoor();
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(screen.getAllByText("Required").length).toBeGreaterThan(0));
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("MUST 6: a pickup path (POS mode) saves on the name alone", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole("switch", { name: /store pickup/i }));
    await openDoor();
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await waitFor(() => expect(createCustomer).toHaveBeenCalledTimes(1));
    expect(createCustomer.mock.calls[0][0].addresses).toBeUndefined();
  });
});
