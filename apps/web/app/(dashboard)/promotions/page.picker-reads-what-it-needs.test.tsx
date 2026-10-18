import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import PromotionsPage from "./page";

/**
 * The "Specific products" picker no longer downloads the whole catalog to filter it in the browser:
 * it asks the server for a small page (and searches the server as the operator types), and names the
 * chips of previously chosen products with one by-id read each. (The page-level $0.00 guard still reads
 * the active catalog, so a `limit: 0` call from the PAGE is expected; the PICKER's calls are asserted.)
 */
const mockUseProducts = jest.fn();
const mockApiGet = jest.fn();
let mockPromotions: unknown[] = [];

const FAMILY = { id: "f-pod", name: "Sample Pod", kind: "FAMILY", isActive: true };
const MINT = {
  id: "v-mint",
  name: "Mint",
  kind: "VARIANT",
  variantName: "Mint",
  parentProductId: "f-pod",
  parent: { id: "f-pod", name: "Sample Pod" },
  isActive: true,
  pricePerUnit: "4.00",
};
const COLA = {
  id: "p-cola",
  name: "Sample Cola",
  kind: "STANDARD",
  isActive: true,
  pricePerUnit: "2.00",
};
const LIME = {
  id: "p-lime",
  name: "Sample Lime",
  kind: "STANDARD",
  isActive: true,
  pricePerUnit: "3.00",
};
const ALL = [FAMILY, MINT, COLA, LIME];

jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockApiGet(...args) },
}));
jest.mock("@/lib/api/promotions", () => ({
  ...jest.requireActual("@/lib/api/promotions"),
  usePromotions: () => ({ data: mockPromotions, isLoading: false, isError: false }),
  useCreatePromotion: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useUpdatePromotion: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useSetPromotionActive: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useDeletePromotion: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: (...args: unknown[]) => mockUseProducts(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPromotions = [];
  // limit 0 = the whole catalog; otherwise a server page: the first 2 rows, or the rows matching `search`.
  mockUseProducts.mockImplementation((params?: { search?: string; limit?: number }) => {
    if (params?.limit === 0) return { data: { data: ALL } };
    const term = params?.search?.toLowerCase();
    return {
      data: {
        data: term ? ALL.filter((p) => p.name.toLowerCase().includes(term)) : ALL.slice(0, 2),
      },
    };
  });
  mockApiGet.mockImplementation((url: string) => {
    const hit = ALL.find((p) => url === `/products/${p.id}`);
    return hit ? Promise.resolve({ data: hit }) : Promise.reject(new Error(`unexpected ${url}`));
  });
});

/** Every useProducts call the PICKER made: the page itself is the only caller using the limit-0 sentinel. */
const pickerCalls = () =>
  mockUseProducts.mock.calls
    .map(([params]) => params as { search?: string; limit?: number } | undefined)
    .filter((params) => params?.limit !== 0);

async function openPicker() {
  renderWithProviders(<PromotionsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: "New promotion" })[0]);
  const dialog = await screen.findByRole("dialog");
  const scope = within(dialog)
    .getAllByRole("combobox")
    .find((el) => (el as HTMLSelectElement).querySelector('option[value="PRODUCTS"]'))!;
  fireEvent.change(scope, { target: { value: "PRODUCTS" } });
  return {
    dialog,
    box: within(dialog).getByPlaceholderText(/search products by name or sku/i),
  };
}

describe("promotion product picker reads what it needs", () => {
  it("asks the server for one small page when it opens, not the whole catalog", async () => {
    await openPicker();
    expect(pickerCalls()).toContainEqual({ search: undefined, limit: 20 });
  });

  it("searches the server as the operator types, with a small limit", async () => {
    const { dialog, box } = await openPicker();
    fireEvent.change(box, { target: { value: "lime" } });
    await waitFor(() => expect(pickerCalls()).toContainEqual({ search: "lime", limit: 20 }));
    for (const params of pickerCalls()) expect(params?.limit).toBeLessThanOrEqual(20);
    expect(await within(dialog).findByRole("button", { name: /Sample Lime/ })).toBeInTheDocument();
  });

  it("sends the variant part of a composed 'Parent - Variant' term to the server", async () => {
    const { dialog, box } = await openPicker();
    fireEvent.change(box, { target: { value: "sample pod - mint" } });
    await waitFor(() => expect(pickerCalls()).toContainEqual({ search: "mint", limit: 20 }));
    expect(
      await within(dialog).findByRole("button", { name: /Sample Pod - Mint/ }),
    ).toBeInTheDocument();
  });

  it("keeps a chosen product's chip name after the search moves on", async () => {
    const { dialog, box } = await openPicker();
    fireEvent.change(box, { target: { value: "lime" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Sample Lime/ }));
    fireEvent.change(box, { target: { value: "mint" } });
    await waitFor(() => expect(pickerCalls()).toContainEqual({ search: "mint", limit: 20 }));
    expect(within(dialog).getByText("Sample Lime")).toBeInTheDocument();
    // the row was already in hand: no by-id read was needed for it
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it("names the chips of a saved promotion with one by-id read each", async () => {
    mockPromotions = [
      {
        id: "promo-1",
        name: "Restock deal",
        type: "PERCENT",
        value: 10,
        scope: "PRODUCTS",
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-12-31T00:00:00.000Z",
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        products: [{ productId: "p-cola" }],
      },
    ];
    renderWithProviders(<PromotionsPage />);
    fireEvent.click(screen.getByTitle("Edit"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Sample Cola")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/products/p-cola");
  });
});
