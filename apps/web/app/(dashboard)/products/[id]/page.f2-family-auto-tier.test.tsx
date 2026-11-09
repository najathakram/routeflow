import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * W-1170 F2: on a FAMILY page a tier stored as 0 is Auto (it follows Retail). Editing must not compare tier 3
 * against an Auto tier 2 ("Higher tier prices should be ≤ the tier above" was false) and the Auto box must be empty with
 * an "Auto" placeholder, not "0.00".
 */
let role = "OPERATOR";
const BASE_PRODUCT = {
  id: "p1",
  name: "Acme Widget",
  sku: "SKU-1",
  barcode: null,
  unitSku: null,
  unit: "CASE",
  pricePerUnit: "1800",
  priceTier2: "1500.5",
  priceTier3: null,
  priceTier4: "1200",
  priceTier5: "0",
  msrp: "0.5",
  category: "Misc",
  description: null,
  isActive: true,
  kind: "STANDALONE",
  currentStock: 5,
  images: [],
  imageKeys: [],
  unitsPerBox: 24,
  parentProductId: null,
  packTenantUnitId: "tu-case",
};

const FAMILY = {
  ...BASE_PRODUCT,
  kind: "FAMILY",
  name: "UX Family",
  unit: "box",
  pricePerUnit: "1.25",
  priceTier2: "0",
  priceTier3: "1.1",
  priceTier4: "0",
  priceTier5: "0",
  unitsPerBox: null,
  variants: [],
};
let current: Record<string, unknown> = FAMILY;
let flagOn = true;
let sales: {
  data?: { summary: { count: number }; lines: unknown[] };
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} = {
  data: { summary: { count: 0 }, lines: [] },
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
};

jest.mock("@/lib/api/product-sales", () => ({ useProductSales: () => sales }));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  useRouter: () => ({ push: jest.fn() }),
  // CustomerPriceView (K11-06) reads ?customer= through these
  usePathname: () => "/products/p1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/api/products", () => ({
  useProduct: () => ({ data: current, isLoading: false }),
  useProducts: () => ({ data: { data: [] } }),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUploadProductImages: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteProductImage: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateProduct: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Enabled: () => flagOn,
  usePricesV2Pending: () => false,
}));
jest.mock("@/lib/api/cost-history", () => ({ useCostHistory: () => ({ data: [] }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false, TOBACCO_ADDON: "tobacco" }));
jest.mock("./useReactivateFlow", () => ({ useReactivateFlow: () => ({}) }));
jest.mock("./useDeleteProductFlow", () => ({ useDeleteProductFlow: () => ({}) }));
jest.mock("./ProductStockCostCard", () => ({
  ProductStockCostCard: () => <div data-testid="stock-card" />,
}));
jest.mock("./ProductLabelsCard", () => ({
  ProductLabelsCard: () => <div data-testid="labels-card" />,
}));
jest.mock("./ProductPortalVisibilityCard", () => ({
  ProductPortalVisibilityCard: () => <div data-testid="portal-card" />,
}));
jest.mock("./ProductUnitsCard", () => ({
  ProductUnitsCard: () => <div data-testid="units-card" />,
}));
jest.mock("./DemandCard", () => ({ DemandCard: () => <div data-testid="demand-card" /> }));
for (const m of [
  "./DeleteProductConfirm",
  "./ProductInsightsExport",
  "./ProductHeaderControls",
  "./LegacyVariantsActions",
  "./ImageLightbox",
  "./CropModal",
]) {
  jest.mock(m, () => new Proxy({}, { get: () => () => null }));
}
jest.mock("@/components/family/FamilyVariantsEditor", () => ({
  FamilyVariantsEditor: () => <div data-testid="family-variants" />,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/CategoryCombobox", () => ({ CategoryCombobox: () => null }));
jest.mock("@/components/SubcategoryCombobox", () => ({ SubcategoryCombobox: () => null }));
jest.mock("@/components/SetCostModal", () => ({ SetCostModal: () => null }));
jest.mock("@/components/VariantSplitModal", () => ({ VariantSplitModal: () => null }));
jest.mock("@/components/PackSizePrompt", () => ({ PackSizePrompt: () => null }));

beforeEach(() => {
  role = "OPERATOR";
  current = FAMILY;
  flagOn = true;
  sales = {
    data: { summary: { count: 0 }, lines: [] },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };
});

describe("F2: an Auto (0) family tier", () => {
  it("shows no false 'Higher tier prices' warning when tier 3 sits below Retail and tier 2 is Auto", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductDetailPage />);
    await user.click(screen.getByTitle("Edit product"));
    expect(screen.queryByText(/Higher tier prices should be/)).toBeNull();
  });

  it("the Auto tiers' boxes are empty with an 'Auto' placeholder, not 0", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductDetailPage />);
    await user.click(screen.getByTitle("Edit product"));
    const auto = screen.getAllByPlaceholderText("Auto") as HTMLInputElement[];
    // Tiers 2, 4 and 5 are Auto; tier 3 is a real price and shows it.
    expect(auto.map((b) => b.value)).toEqual(["", "", ""]);
  });

  it("a real violation still warns (tier 3 above Retail)", async () => {
    current = { ...FAMILY, priceTier3: "2.00" };
    const user = userEvent.setup();
    renderWithProviders(<ProductDetailPage />);
    await user.click(screen.getByTitle("Edit product"));
    expect(screen.getByText(/Higher tier prices should be/)).toBeTruthy();
  });
});
