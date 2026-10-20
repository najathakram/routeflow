import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K11-23 (prices v2): the prices region follows Details in the DOM (the reading and tab order on a phone), above Image,
 * Stock and cost, Labels and Portal visibility; at lg the grid lines keep it under Portal visibility. Rendered once,
 * no `order-*` classes, no `display: contents`.
 */
let role = "OPERATOR";
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
  usePricesV2Enabled: () => true,
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

const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("K11-23 prices v2: the prices region follows Details", () => {
  it("DOM order: Details, prices region, Image, Stock and cost, Labels, Portal visibility, Units", () => {
    renderWithProviders(<ProductDetailPage />);
    const details = screen.getByTestId("product-details-card");
    const region = screen.getByTestId("units-v2-region");
    const image = screen.getByTestId("product-image-card");
    const chain = [
      details,
      region,
      image,
      screen.getByTestId("stock-card"),
      screen.getByTestId("labels-card"),
      screen.getByTestId("portal-card"),
      screen.getByTestId("units-card"),
    ];
    for (let i = 0; i < chain.length - 1; i++) expect(follows(chain[i], chain[i + 1])).toBe(true);
  });

  it("renders the prices region exactly once, with no order-* classes and no display: contents", () => {
    renderWithProviders(<ProductDetailPage />);
    expect(screen.getAllByTestId("units-v2-region")).toHaveLength(1);
    expect(screen.getAllByTestId("pricing-v2")).toHaveLength(1);
    const grid = screen.getByTestId("product-details-card").closest(".grid") as HTMLElement;
    expect(grid.outerHTML).not.toMatch(/(^|[\s"])(sm:|md:|lg:)?order-/);
    expect(grid.outerHTML).not.toMatch(/\bcontents\b/);
  });

  it("at lg the grid lines keep Details, Labels and Portal, then the prices region, then the rest", () => {
    renderWithProviders(<ProductDetailPage />);
    const details = screen.getByTestId("product-details-card");
    const grid = details.closest(".grid") as HTMLElement;
    expect(grid.className).toMatch(/lg:grid-cols-3/);
    expect(grid.className).toMatch(/lg:gap-y-5/);
    expect(grid.className).toMatch(/lg:grid-rows-\[auto_auto_auto_1fr\]/);
    const items = Array.from(grid.children) as HTMLElement[];
    expect(items).toHaveLength(5);
    const at = (el: Element) => items.findIndex((i) => i.contains(el));
    expect(items[at(details)].className).toMatch(/lg:col-start-2 lg:row-start-1/);
    expect(items[at(screen.getByTestId("units-v2-region"))].className).toMatch(
      /lg:col-start-2 lg:row-start-3/,
    );
    expect(items[at(screen.getByTestId("product-image-card"))].className).toMatch(
      /lg:col-start-1 lg:row-start-1 lg:row-span-4/,
    );
    expect(items[at(screen.getByTestId("labels-card"))].className).toMatch(/lg:row-start-2/);
    expect(items[at(screen.getByTestId("portal-card"))]).toBe(
      items[at(screen.getByTestId("labels-card"))],
    );
    expect(items[at(screen.getByTestId("units-card"))].className).toMatch(/lg:row-start-4/);
  });
});
