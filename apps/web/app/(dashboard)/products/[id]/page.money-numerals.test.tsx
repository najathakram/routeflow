import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K11-21 (P04): one numeral style on the product page. Every money figure in Details is a
 * `formatMoney` string (`$1,800.00`, thousands separators, two decimals, `$0.00` never a dash)
 * set in tabular figures, so the columns of the tier grid line up and no figure reads as raw.
 */
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
  useAuth: () => ({ user: { role: "OPERATOR" } }),
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

const MONEY = /^\$\d{1,3}(,\d{3})*\.\d{2}$/;

/** Leaf elements inside the Details card whose text carries a dollar amount. */
function priceNodes(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>("*")).filter(
    (el) => el.children.length === 0 && /\$\s*\d/.test(el.textContent ?? ""),
  );
}

describe("K11-21: one numeral style in Details", () => {
  it("every price figure in Details is formatMoney text in tabular figures", async () => {
    renderWithProviders(<ProductDetailPage />);
    const card = (await screen.findByText("Details")).closest("div.overflow-hidden") as HTMLElement;
    const nodes = priceNodes(card);
    // price + Tier 2..5 + the per-piece hint + the MSRP + the wholesale warning
    expect(nodes.length).toBeGreaterThanOrEqual(7);
    for (const el of nodes) {
      const text = (el.textContent ?? "").trim();
      expect({ text, ok: MONEY.test(text) }).toEqual({ text, ok: true });
      expect({ text, tabular: !!el.closest(".tabular-nums") }).toEqual({ text, tabular: true });
    }
    // thousands separators, not the raw 4-digit form
    expect(nodes.some((n) => n.textContent === "$1,800.00")).toBe(true);
  });

  it("a tier left at 0 follows the list price and reads $1,800.00 with the list tag, never a dash", async () => {
    renderWithProviders(<ProductDetailPage />);
    const card = (await screen.findByText("Details")).closest("div.overflow-hidden") as HTMLElement;
    expect(card.textContent).toContain("list");
    expect(card.textContent).not.toMatch(/\$\s*[—-]/);
  });

  it("edit mode keeps the money inputs (no figure is lost)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductDetailPage />);
    await user.click(await screen.findByTitle("Edit product"));
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(3);
  });
});
