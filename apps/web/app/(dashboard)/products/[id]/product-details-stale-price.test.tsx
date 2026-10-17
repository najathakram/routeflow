import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act } from "@/test-utils/render";
import { useSavePrices } from "@/lib/api/usePriceWrites";
import ProductDetailPage from "./page";

/**
 * REG (units v2, money): a v2 price save (POST /products/:id/prices) wrote only the price-grid cache. The product the
 * Details form reads stayed stale, and every Details save re-sent the case price and tier prices it opened with, so a
 * plain rename silently restored the OLD price. The REAL `useProduct`, `useUpdateProduct` and `useSavePrices` run;
 * only the network (a tiny in-memory "server") and the page's heavy neighbours are mocked.
 */
const patch = jest.fn();
const post = jest.fn();
const getProduct = jest.fn();
let server: Record<string, unknown>;

const PRODUCT = {
  id: "p1",
  name: "Acme Widget",
  sku: "SKU-1",
  barcode: null,
  unitSku: null,
  unit: "CASE",
  pricePerUnit: "10.00",
  priceTier2: "9.00",
  priceTier3: "8.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  msrp: null,
  category: "Misc",
  description: null,
  isActive: true,
  kind: "STANDALONE",
  currentStock: 5,
  images: [],
  imageKeys: [],
  unitsPerBox: null,
  parentProductId: null,
  packTenantUnitId: "tu-case",
};

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
    // Every other read errors (as the sibling product-edit-save test's bare jest.fn() does): its card just stays empty.
    get: (url: string) =>
      url === "/products/p1" ? getProduct() : Promise.reject(new Error("unmocked read")),
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/products", () => {
  const idle = () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false });
  return {
    ...jest.requireActual("@/lib/api/products"),
    useProducts: () => ({ data: { data: [] } }),
    useUploadProductImages: idle,
    useDeleteProductImage: idle,
    useCreateProduct: idle,
  };
});
jest.mock("@/lib/api/cost-history", () => ({ useCostHistory: () => ({ data: [] }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false, TOBACCO_ADDON: "tobacco" }));
jest.mock("./useReactivateFlow", () => ({ useReactivateFlow: () => ({}) }));
jest.mock("./useDeleteProductFlow", () => ({ useDeleteProductFlow: () => ({}) }));
for (const m of [
  "./DeleteProductConfirm",
  "./DemandCard",
  "./SalesHistoryCard",
  "./ProductInsightsExport",
  "./ProductLabelsCard",
  "./ProductPortalVisibilityCard",
  "./ProductUnitsCard",
  "./ProductStockCostCard",
  "./ProductHeaderControls",
  "./LegacyVariantsActions",
  "./ImageLightbox",
  "./CropModal",
]) {
  jest.mock(m, () => new Proxy({}, { get: () => () => null }));
}
jest.mock("@/components/family/FamilyVariantsEditor", () => ({ FamilyVariantsEditor: () => null }));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/CategoryCombobox", () => ({ CategoryCombobox: () => null }));
jest.mock("@/components/SubcategoryCombobox", () => ({ SubcategoryCombobox: () => null }));
jest.mock("@/components/SetCostModal", () => ({ SetCostModal: () => null }));
jest.mock("@/components/VariantSplitModal", () => ({ VariantSplitModal: () => null }));
jest.mock("@/components/PackSizePrompt", () => ({ PackSizePrompt: () => null }));

/** The v2 grid's save, as the page's real mutation hook runs it (no grid UI needed). */
function V2Saver() {
  const save = useSavePrices("p1");
  return (
    <button type="button" onClick={() => save.mutate({ ops: [] } as never)}>
      price write v2
    </button>
  );
}

const PRICE_KEYS = [
  "pricePerUnit",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
] as const;

async function renderPage() {
  const view = renderWithProviders(
    <>
      <V2Saver />
      <ProductDetailPage />
    </>,
  );
  await screen.findByTitle("Edit product");
  return view;
}

/** A v2 save that moves the case price 10 -> 12 on the server; the response carries the fresh grid. */
async function v2SaveToTwelve(user: ReturnType<typeof userEvent.setup>) {
  post.mockImplementationOnce(async () => {
    server = { ...server, pricePerUnit: "12.00" };
    return { data: { grid: { revision: 2 } } };
  });
  await user.click(screen.getByRole("button", { name: "price write v2" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
}

async function renameAndSave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTitle("Edit product"));
  const name = screen.getByDisplayValue("Acme Widget");
  await user.clear(name);
  await user.type(name, "Acme Widget 2");
  await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  return patch.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  server = { ...PRODUCT };
  getProduct.mockImplementation(() => Promise.resolve({ data: { ...server } }));
  patch.mockResolvedValue({ data: { id: "p1" } });
});

describe("a Details save never restores a stale price", () => {
  it("REG: after a v2 price save, renaming in Details sends no price key (the old case price is not restored)", async () => {
    const user = userEvent.setup();
    await renderPage();
    await v2SaveToTwelve(user);
    const body = await renameAndSave(user);
    expect(body.name).toBe("Acme Widget 2");
    for (const k of PRICE_KEYS) expect(body[k]).toBeUndefined();
  });

  it("REG: a Details form opened BEFORE the v2 save also sends no price key on a rename", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(await screen.findByTitle("Edit product"));
    await v2SaveToTwelve(user);
    const name = screen.getByDisplayValue("Acme Widget");
    await user.clear(name);
    await user.type(name, "Acme Widget 2");
    await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    for (const k of PRICE_KEYS) expect(body[k]).toBeUndefined();
  });

  it("a v2 save invalidates the product query the Details form reads", async () => {
    const user = userEvent.setup();
    await renderPage();
    const before = getProduct.mock.calls.length;
    await v2SaveToTwelve(user);
    await waitFor(() => expect(getProduct.mock.calls.length).toBeGreaterThan(before));
  });

  it("editing the case price in Details still sends it (a dirty field), and only it", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(await screen.findByTitle("Edit product"));
    const price = screen.getAllByDisplayValue("10.00")[0];
    await user.clear(price);
    await user.type(price, "11");
    await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect(body.pricePerUnit).toBe("11");
    // Tiers the operator did not touch keep their existing behaviour: they follow or hold exactly as before.
    expect(body.priceTier2).toBe("9");
    expect(body.priceTier4).toBe("0");
  });

  it("editing one tier in Details sends that tier, and not the untouched case price", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(await screen.findByTitle("Edit product"));
    const t2 = screen.getAllByDisplayValue("9.00")[0];
    await user.clear(t2);
    await user.type(t2, "7");
    await act(async () => {});
    await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const body = patch.mock.calls[0][1] as Record<string, unknown>;
    expect(body.priceTier2).toBe("7");
    // The lower tiers move only through the draft's own ladder rule (their edit commit), which is the operator's change.
    expect(body.priceTier3).toBe("7");
    // The case price was never touched: it is not written back.
    expect(body.pricePerUnit).toBeUndefined();
  });
});
