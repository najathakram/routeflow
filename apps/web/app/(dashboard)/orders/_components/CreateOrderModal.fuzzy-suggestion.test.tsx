/** B1219: a single FUZZY scan match (no exact code) asks "Did you mean ...?" before adding. */
import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

window.HTMLElement.prototype.scrollIntoView = jest.fn();

const PLAIN = {
  id: "p-plain",
  name: "Sample Cola",
  sku: "100200300",
  unit: "each",
  pricePerUnit: "2.50",
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PLAIN] } }),
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
  useOrderUiV2: () => ({ enabled: true, resolved: true }), // step 10's typed-Qty path is what races
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

const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

const search = () => screen.getByPlaceholderText(/search by name, sku or scan barcode/i);

const FUZZY = { ...PLAIN, id: "p-fuzzy", name: "Cola Zero 12345", sku: "CZ-1" };
const suggestion = {
  product: FUZZY,
  source: "search",
  ambiguous: true,
  suggestion: true,
  matches: [FUZZY],
};

function typeScan(code: string) {
  fireEvent.change(search(), { target: { value: code } });
  fireEvent.keyDown(search(), { key: "Enter" });
}
const lines = () => screen.queryAllByTitle("Remove");

beforeEach(() => jest.clearAllMocks());

describe("Create Order scan - fuzzy single match (B1219)", () => {
  it("asks 'Did you mean ...?' and adds no line until Add", async () => {
    mockResolveProductByCode.mockResolvedValue(suggestion);
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => typeScan("12345"));

    const picker = await screen.findByRole("group", { name: /did you mean/i });
    expect(picker).toHaveTextContent("Did you mean Cola Zero 12345?");
    expect(lines()).toHaveLength(0);

    fireEvent.click(within(picker).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });

  it("Cancel adds nothing and closes the picker", async () => {
    mockResolveProductByCode.mockResolvedValue(suggestion);
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => typeScan("12345"));
    const picker = await screen.findByRole("group", { name: /did you mean/i });

    // The modal footer has its own Cancel - scope to the picker's.
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull());
    expect(lines()).toHaveLength(0);
  });

  it("an exact code still auto-adds with no picker", async () => {
    mockResolveProductByCode.mockResolvedValue({ product: PLAIN, source: "sku" });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await act(async () => typeScan(PLAIN.sku));

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
  });
});
