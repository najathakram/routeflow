import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";
import { UNITS_V2_TESTIDS } from "./units-v2-testids";
import { unitStructureGoverned } from "./units-v2/structure/unit-structure";

/**
 * SA-984 §4 E3 (web half), as amended by SA-987 §1.3: the EXPECTED differences of the units fold-in on the product page,
 * pinned per shape so they never read as failures. Each cell renders the page with the v2 flag ON (the new value) and
 * then with it OFF (master's value) and asserts both, so a pin that passes on both values cannot exist.
 *
 *   tiers row   ruling K12 P06 (and the 10-18 ruling item 1): the prices grid owns prices on a product it can edit.
 *   old card    ruling row 742 (owner 2026-10-22; D-2026-10-18): the old Units card stays only for unit STRUCTURE on a
 *               variant or recipe, and goes away on a standard product and a family.
 *   stock       ruling OR10 (SA-984 §0): with the grid on, the product page shows no stock numbers; counts live on Inventory.
 *
 * NOTE (corrects the SA-984 §4 wording "the tiers row and the legacy card are gone"): that holds on a STANDARD product only.
 * What the code does, and what is pinned here (page.tsx:475, :1780-1789, :2383-2385; unit-structure.ts:5-8):
 *
 *   shape            flag-on tiers row                  flag-on old units card
 *   STANDARD         gone                               gone
 *   FAMILY           kept (inside its price section)    gone
 *   RECIPE           KEPT                               kept, structure only
 *   VARIANT          KEPT                               kept, structure only
 */
let flagOn = true;
let current: Record<string, unknown>;

const BASE = {
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
  variants: [],
};
const SHAPES: Record<string, Record<string, unknown>> = {
  STANDARD: { ...BASE },
  FAMILY: { ...BASE, kind: "FAMILY", name: "Acme Widgets", unit: "box", unitsPerBox: null },
  RECIPE: { ...BASE, kind: "RECIPE", name: "Acme Kit" },
  VARIANT: { ...BASE, parentProductId: "fam-1", parent: { name: "Acme Widgets" } },
};

jest.mock("@/lib/api/product-sales", () => ({
  useProductSales: () => ({
    data: { summary: { count: 0 }, lines: [] },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/products/p1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
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
jest.mock("./ProductLabelsCard", () => ({
  ProductLabelsCard: () => <div data-testid="labels-card" />,
}));
jest.mock("./ProductPortalVisibilityCard", () => ({
  ProductPortalVisibilityCard: () => <div data-testid="portal-card" />,
}));
// The card is mocked to expose the two props the ruling is about: it is shown at all, and structureOnly.
jest.mock("./ProductUnitsCard", () => ({
  ProductUnitsCard: (p: { structureOnly?: boolean; hideAddForm?: boolean }) => (
    <div
      data-testid="units-card"
      data-structure-only={String(p.structureOnly)}
      data-hide-add={String(p.hideAddForm)}
    />
  ),
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
jest.mock("@/components/family/FamilyVariantsEditor", () => ({
  FamilyVariantsEditor: () => <div data-testid="family-variants" />,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/CategoryCombobox", () => ({ CategoryCombobox: () => null }));
jest.mock("@/components/SubcategoryCombobox", () => ({ SubcategoryCombobox: () => null }));
jest.mock("@/components/SetCostModal", () => ({ SetCostModal: () => null }));
jest.mock("@/components/VariantSplitModal", () => ({ VariantSplitModal: () => null }));
jest.mock("@/components/PackSizePrompt", () => ({ PackSizePrompt: () => null }));

/** Render the page for one shape under one flag value; the caller unmounts before the other value. */
function renderShape(shape: string, on: boolean) {
  flagOn = on;
  current = SHAPES[shape];
  return renderWithProviders(<ProductDetailPage />);
}
const tiersRows = () => screen.queryAllByText("Pricing Tiers").length;
const card = () => screen.queryByTestId("units-card");

// shape -> [flag-on tiers rows, flag-on old card shown]
const FLAG_ON: Record<string, { tiers: number; card: false | { structureOnly: "true" } }> = {
  STANDARD: { tiers: 0, card: false },
  FAMILY: { tiers: 1, card: false },
  RECIPE: { tiers: 1, card: { structureOnly: "true" } },
  VARIANT: { tiers: 1, card: { structureOnly: "true" } },
};

describe("E3 web: the unit-structure rule decides the shapes", () => {
  it("unitStructureGoverned is FAMILY, RECIPE or a variant, never a standard product (unit-structure.ts:5-8)", () => {
    expect(unitStructureGoverned({ kind: "STANDALONE", parentProductId: null })).toBe(false);
    expect(unitStructureGoverned({ kind: "FAMILY" })).toBe(true);
    expect(unitStructureGoverned({ kind: "RECIPE" })).toBe(true);
    expect(unitStructureGoverned({ kind: "STANDALONE", parentProductId: "fam-1" })).toBe(true);
  });
});

describe("E3 web, K12 P06: the Pricing Tiers row, per shape (flag on = new value, flag off = master)", () => {
  for (const shape of Object.keys(SHAPES)) {
    it(`${shape}: flag on shows ${FLAG_ON[shape].tiers} tiers row(s); flag off (master) shows 1`, () => {
      const on = renderShape(shape, true);
      expect(tiersRows()).toBe(FLAG_ON[shape].tiers);
      on.unmount();
      const off = renderShape(shape, false);
      expect(tiersRows()).toBe(1);
      off.unmount();
    });
  }
});

describe("E3 web, row 742: the old Units card, per shape (flag on = new value, flag off = master)", () => {
  for (const shape of Object.keys(SHAPES)) {
    const want = FLAG_ON[shape].card;
    it(`${shape}: flag on ${want ? "keeps it, structure only" : "removes it"}; flag off (master) shows the full card`, () => {
      const on = renderShape(shape, true);
      if (want) {
        expect(card()).not.toBeNull();
        expect(card()).toHaveAttribute("data-structure-only", want.structureOnly);
        expect(card()).toHaveAttribute("data-hide-add", "true");
      } else {
        expect(card()).toBeNull();
      }
      on.unmount();
      const off = renderShape(shape, false);
      expect(card()).not.toBeNull();
      expect(card()).toHaveAttribute("data-structure-only", "false");
      expect(card()).toHaveAttribute("data-hide-add", "false");
      off.unmount();
    });
  }
});

describe("E3 web, OR10: no stock numbers on the product page with the grid on", () => {
  for (const shape of ["STANDARD", "RECIPE", "VARIANT"]) {
    it(`${shape}: flag on has no count, no On hand, no Waitlist and a link to Inventory; flag off (master) shows '5 in stock' and On hand`, () => {
      const on = renderShape(shape, true);
      expect(screen.queryAllByText(/\d+ in stock/)).toHaveLength(0);
      expect(screen.queryByText(/On hand/)).toBeNull();
      expect(screen.queryByText(/waiting for restock/)).toBeNull();
      expect(screen.getByTestId(UNITS_V2_TESTIDS.headerStockLink)).toBeInTheDocument();
      on.unmount();
      const off = renderShape(shape, false);
      expect(screen.getAllByText("5 in stock").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/On hand/).length).toBeGreaterThan(0);
      expect(screen.queryByTestId(UNITS_V2_TESTIDS.headerStockLink)).toBeNull();
      off.unmount();
    });
  }
  it("FAMILY: flag on says it cannot be sold and shows no count; flag off shows no count either (a family is never stocked)", () => {
    const on = renderShape("FAMILY", true);
    expect(screen.getByTestId(UNITS_V2_TESTIDS.familyHeader)).toBeInTheDocument();
    expect(screen.queryAllByText(/\d+ in stock/)).toHaveLength(0);
    on.unmount();
    const off = renderShape("FAMILY", false);
    expect(screen.queryByTestId(UNITS_V2_TESTIDS.familyHeader)).toBeNull();
    expect(screen.queryAllByText(/\d+ in stock/)).toHaveLength(0);
    off.unmount();
  });
});
