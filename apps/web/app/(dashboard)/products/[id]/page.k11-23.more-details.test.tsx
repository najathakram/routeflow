import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, fireEvent, within } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K11-23 (phone): the secondary Details fields sit behind a "More details" disclosure. CSS only (max-sm:hidden), always
 * mounted, so a typed value survives collapse; edit mode opens it.
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
  usePricesV2Enabled: () => false,
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

const panel = () => screen.getByTestId("details-more-panel");
const toggle = () => screen.getByRole("button", { name: /more details/i });

describe("K11-23 More details disclosure (below sm)", () => {
  beforeEach(() => {
    role = "OPERATOR";
  });

  it("is a real button: aria-expanded, aria-controls, a 44 px target, hidden from sm up", () => {
    renderWithProviders(<ProductDetailPage />);
    const t = toggle();
    expect(t.tagName).toBe("BUTTON");
    expect(t).toHaveAttribute("aria-expanded", "false");
    expect(t).toHaveAttribute("aria-controls", panel().id);
    expect(t.className).toMatch(/min-h-\[44px\]/);
    expect(t.className).toMatch(/\bsm:hidden\b/);
  });

  it("holds MSRP, Description and Buyer merchandising, collapsed by a CSS class, still mounted", () => {
    renderWithProviders(<ProductDetailPage />);
    const p = panel();
    expect(p.className).toMatch(/max-sm:hidden/);
    expect(p).toHaveTextContent("MSRP (Suggested Retail)");
    expect(p).toHaveTextContent("Description");
    expect(p).toContainElement(screen.getByRole("heading", { name: "Buyer merchandising" }));
    // the primary facts stay outside it
    expect(p).not.toContainElement(screen.getByText("SKU (box code)"));
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(panel().className).not.toMatch(/max-sm:hidden/);
    fireEvent.click(toggle());
    expect(panel().className).toMatch(/max-sm:hidden/);
  });

  it("edit mode opens it, and a typed value survives collapse and expand", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductDetailPage />);
    await user.click(screen.getByTitle("Edit product"));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(panel().className).not.toMatch(/max-sm:hidden/);
    const box = within(panel()).getByRole("textbox");
    await user.type(box, "typed note");
    await user.click(toggle());
    expect(panel().className).toMatch(/max-sm:hidden/);
    expect(screen.getByDisplayValue("typed note")).toBeInTheDocument();
    await user.click(toggle());
    expect(screen.getByDisplayValue("typed note")).toBeInTheDocument();
  });

  it("uses no breakpoint hook: matchMedia is never called", () => {
    const mm = jest.fn();
    const orig = window.matchMedia;
    window.matchMedia = mm as unknown as typeof window.matchMedia;
    renderWithProviders(<ProductDetailPage />);
    window.matchMedia = orig;
    expect(mm).not.toHaveBeenCalled();
  });
});
