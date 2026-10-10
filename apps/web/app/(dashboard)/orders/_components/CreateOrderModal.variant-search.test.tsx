import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

/**
 * B1215 C6/C7: a search term that matches ONLY a variant's flavor used to show "No products found"
 * (the variant row was dropped and its parent was never attached), and a FAMILY could be picked as
 * a line. The picker re-attaches the parent, opens it, and never adds a family itself.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const VARIANT = {
  id: "v-straw",
  name: "Strawberry",
  variantName: "Strawberry",
  kind: "VARIANT",
  parentProductId: "f-pod",
  parent: { id: "f-pod", name: "Sample Pod" },
  unit: "each",
  pricePerUnit: "4.00",
  isActive: true,
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  unit: "each",
  pricePerUnit: "0",
  isActive: true,
  variants: [
    { ...VARIANT, parent: undefined },
    {
      id: "v-mint",
      name: "Mint",
      variantName: "Mint",
      kind: "VARIANT",
      parentProductId: "f-pod",
      unit: "each",
      pricePerUnit: "4.00",
      isActive: true,
    },
  ],
};
let mockRows: unknown[] = [];

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockRows } }),
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
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: true, resolved: true }),
  useScanV2: () => false,
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);
const type = (term: string) => fireEvent.change(search(), { target: { value: term } });

beforeEach(() => {
  mockRows = [];
});

describe("CreateOrderModal product search - variant hits and families (B1215)", () => {
  it("C6: a flavor-only hit shows its parent, opened, with the variant selectable", async () => {
    mockRows = [VARIANT];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    type("strawberry");
    expect(await screen.findByText("Sample Pod")).toBeInTheDocument();
    expect(screen.queryByText("No products found.")).not.toBeInTheDocument();
    const row = await screen.findByRole("button", { name: /Sample Pod - Strawberry/ });
    fireEvent.click(row);
    // the order line is named "<Parent> - <Variant>"
    await waitFor(() => expect(screen.getAllByTitle("Remove")).toHaveLength(1));
    expect(screen.getAllByText("Sample Pod - Strawberry").length).toBeGreaterThan(0);
  });

  it("C7: clicking a FAMILY header only opens it; it is never added as a line", async () => {
    mockRows = [FAMILY];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    type("pod");
    const header = await screen.findByRole("button", { name: /Sample Pod/ });
    fireEvent.click(header);
    expect(await screen.findByRole("button", { name: /Sample Pod - Mint/ })).toBeInTheDocument();
    expect(screen.queryAllByTitle("Remove")).toHaveLength(0);
  });

  it("C7: a FAMILY with no variants under it is not offered at all", async () => {
    mockRows = [{ ...FAMILY, variants: [] }];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    type("pod");
    expect(await screen.findByText("No products found.")).toBeInTheDocument();
  });
});
