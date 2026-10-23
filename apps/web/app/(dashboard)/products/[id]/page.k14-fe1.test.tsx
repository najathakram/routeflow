import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/** K14 FE1: until the flag is KNOWN the flag-off layout is never mounted (mounting it and swapping shifted the page ~740 px at 390). */
let role = "OPERATOR";
let pending = true;
const PRODUCT = {
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

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/api/products", () => ({
  useProduct: () => ({ data: PRODUCT, isLoading: false }),
  useProducts: () => ({ data: { data: [] } }),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUploadProductImages: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteProductImage: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateProduct: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Enabled: () => false,
  usePricesV2Pending: () => pending,
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
jest.mock("./ProductPricingV2", () => ({
  ProductPricingV2: () => <div data-testid="pricing-v2" />,
}));
jest.mock("./DemandCard", () => ({ DemandCard: () => <div data-testid="demand-card" /> }));
jest.mock("./SalesHistoryCard", () => ({
  SalesHistoryCard: () => <div data-testid="sales-card" />,
}));
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
jest.mock("@/components/family/FamilyVariantsEditor", () => ({ FamilyVariantsEditor: () => null }));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/CategoryCombobox", () => ({ CategoryCombobox: () => null }));
jest.mock("@/components/SubcategoryCombobox", () => ({ SubcategoryCombobox: () => null }));
jest.mock("@/components/SetCostModal", () => ({ SetCostModal: () => null }));
jest.mock("@/components/VariantSplitModal", () => ({ VariantSplitModal: () => null }));
jest.mock("@/components/PackSizePrompt", () => ({ PackSizePrompt: () => null }));

describe("K14 FE1: nothing mounts until the units v2 flag is known", () => {
  beforeEach(() => {
    pending = true;
  });

  it("while the flag query is pending, no legacy sections are mounted", () => {
    renderWithProviders(<ProductDetailPage />);
    expect(screen.queryByTestId("product-details-card")).toBeNull();
    expect(screen.queryByTestId("units-card")).toBeNull();
    expect(screen.queryByTestId("product-image-card")).toBeNull();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("once the flag is known (off) the flag-off layout mounts as before", () => {
    pending = false;
    renderWithProviders(<ProductDetailPage />);
    expect(screen.getByTestId("product-details-card")).toBeInTheDocument();
    expect(screen.getByTestId("units-card")).toBeInTheDocument();
  });
});
