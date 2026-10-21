import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K12 O1 (A4 lost input): on a Case product with no pack size, Details -> Edit shows "How many pieces in a box?". A count
 * typed there and saved with the header Save (never "Set pack size") was dropped while the page said "Saved". The REAL
 * page and the REAL PackSizePrompt run; the network is the same tiny in-memory server as page.k11-20c.test.tsx.
 */
let flagOn = true;
const patch = jest.fn();
const getProduct = jest.fn();
const GRID = {
  productId: "p1",
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 1,
      kind: "pack",
      editable: true,
      code: null,
      cells: [
        { tier: 1, value: 30, source: "set" },
        { tier: 2, value: 28, source: "set" },
        { tier: 3, value: 26, source: "auto" },
        { tier: 4, value: 24, source: "auto" },
        { tier: 5, value: 22, source: "auto" },
      ],
    },
  ],
};

// Deliberately stale against the served grid: the Details figures must come from the grid.
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
const PRICE_KEYS = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"];

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
    post: jest.fn(),
    get: (url: string) =>
      url === "/products/p1"
        ? getProduct()
        : url === "/products/p1/price-grid"
          ? Promise.resolve({ data: GRID })
          : Promise.reject(new Error("unmocked read")),
  },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Enabled: () => flagOn,
  usePricesV2Pending: () => false,
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
jest.mock("./ProductPricingV2", () => ({
  ProductPricingV2: () => <div data-testid="pricing-v2" />,
  PriceSaveStatus: () => null,
}));
jest.mock("./units-v2/nav/ProductJumpLinks", () => ({ ProductJumpLinks: () => null }));
jest.mock("./ProductUnitsCard", () => ({
  ProductUnitsCard: () => <div data-testid="units-card" />,
}));
for (const m of [
  "./DeleteProductConfirm",
  "./DemandCard",
  "./SalesHistoryCard",
  "./ProductInsightsExport",
  "./ProductLabelsCard",
  "./ProductPortalVisibilityCard",
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

async function renderPage() {
  const view = renderWithProviders(<ProductDetailPage />);
  await screen.findByTitle("Edit product");
  return view;
}
const edit = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByTitle("Edit product"));
const rename = async (user: ReturnType<typeof userEvent.setup>) => {
  const name = screen.getByDisplayValue("Acme Widget");
  await user.clear(name);
  await user.type(name, "Acme Widget 2");
};
const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  return patch.mock.calls[0][1] as Record<string, unknown>;
};

beforeEach(() => {
  jest.clearAllMocks();
  flagOn = true;
  getProduct.mockImplementation(() => Promise.resolve({ data: { ...PRODUCT } }));
  patch.mockResolvedValue({ data: { id: "p1" } });
});

describe("K12 O1: a pack size typed into the prompt is saved with the header Save", () => {
  it.each([true, false])(
    "flag %s: type 12, press Save, the PATCH carries unitsPerBox 12",
    async (on) => {
      flagOn = on;
      const user = userEvent.setup();
      await renderPage();
      await edit(user);
      const box = await screen.findByRole("spinbutton", { name: /per (box|case)/i });
      await user.type(box, "12");
      const body = await save(user);
      expect(body.unitsPerBox).toBe(12);
    },
  );

  it("an untouched prompt (nothing typed) never sets a pack size", async () => {
    const user = userEvent.setup();
    await renderPage();
    await edit(user);
    await screen.findByRole("spinbutton", { name: /per (box|case)/i });
    await rename(user);
    const body = await save(user);
    expect(body.unitsPerBox).toBeNull();
  });
});
