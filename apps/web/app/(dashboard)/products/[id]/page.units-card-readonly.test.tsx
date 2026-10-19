import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * Page wiring for the read-only Units & prices card (owner ruling D-2026-10-18): the card is read-only only where the v2 grid
 * has mounted the controls that replace it (v2 flag + a role and plan that may edit the ladder + an editable product).
 * Everywhere else it is passed no readOnly and keeps today's controls. (Network and mocks as page.k12-o1.test.tsx.)
 * Origin text of the template: K12 O1 (A4 lost input): on a Case product with no pack size, Details -> Edit shows "How many pieces in a box?". A count
 * typed there and saved with the header Save (never "Set pack size") was dropped while the page said "Saved". The REAL
 * page and the REAL PackSizePrompt run; the network is the same tiny in-memory server as page.k11-20c.test.tsx.
 */
let flagOn = true;
let role = "OPERATOR";
let unitsOn = true;
let kind = "STANDALONE";
const cardProps = jest.fn();
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
  useAuth: () => ({ user: { role } }),
  useOptionalAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/api/product-units", () => ({
  ...jest.requireActual("@/lib/api/product-units"),
  useUnitsEnabled: () => unitsOn,
}));
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Enabled: () => flagOn,
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
  ProductUnitsCard: (p: Record<string, unknown>) => {
    cardProps(p);
    return <div data-testid="units-card" />;
  },
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
  await screen.findByTestId("units-card");
  return view;
}
const lastProps = () => cardProps.mock.calls[cardProps.mock.calls.length - 1][0];

beforeEach(() => {
  jest.clearAllMocks();
  flagOn = true;
  role = "OPERATOR";
  unitsOn = true;
  kind = "STANDALONE";
  getProduct.mockImplementation(() => Promise.resolve({ data: { ...PRODUCT, kind } }));
});

describe("page wiring: the Units & prices card reads only where the grid owns the controls", () => {
  it("v2 on, an operator with the units plan on an editable product: readOnly", async () => {
    await renderPage();
    expect(lastProps()).toMatchObject({ hideAddForm: true, readOnly: true });
  });

  it("v2 on but the units plan is off: the card keeps its controls", async () => {
    unitsOn = false;
    await renderPage();
    expect(lastProps().readOnly).toBeFalsy();
  });

  it("v2 on but the product is a variant (governed by its family): the card keeps its controls", async () => {
    getProduct.mockImplementation(() =>
      Promise.resolve({ data: { ...PRODUCT, parentProductId: "fam-1" } }),
    );
    await renderPage();
    expect(lastProps().readOnly).toBeFalsy();
  });

  it("v2 off: the card is the old editable one", async () => {
    flagOn = false;
    await renderPage();
    expect(lastProps()).toMatchObject({ hideAddForm: false });
    expect(lastProps().readOnly).toBeFalsy();
  });
});
