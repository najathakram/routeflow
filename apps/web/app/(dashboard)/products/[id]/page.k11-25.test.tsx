import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K11-25: the family page. Variants sit directly under Details, a family that was never sold shows ONE true
 * empty state (not Demand and Sales both saying "Never sold"), and the family price stays editable behind a
 * "Family price $x" disclosure that Edit opens.
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
  name: "Acme Widgets",
  unit: "box",
  pricePerUnit: "1.25",
  priceTier2: "1.1",
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

const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function show() {
  renderWithProviders(<ProductDetailPage />);
  return screen.getByRole("heading", { name: "Details" }).closest("div.overflow-hidden")!;
}

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

describe("K11-25: Variants directly under Details", () => {
  it("on a family the variants editor is the next card after Details, in the same grid item", () => {
    const details = show();
    const variants = screen.getByTestId("family-variants");
    expect(details.nextElementSibling).toBe(variants);
    expect(screen.getAllByTestId("family-variants")).toHaveLength(1);
    // phone order: Details, Variants, Image, then everything else
    const image = screen.getByRole("heading", { name: "Image" }).closest("div.overflow-hidden")!;
    expect(follows(variants, image)).toBe(true);
    expect(follows(image, screen.getByTestId("labels-card"))).toBe(true);
  });

  it("the same order holds with the units v2 flag off, and nothing is missing", () => {
    flagOn = false;
    const details = show();
    expect(details.nextElementSibling).toBe(screen.getByTestId("family-variants"));
    expect(screen.getByTestId("units-card")).toBeInTheDocument(); // the legacy card stays for a flag-off family
    expect(screen.getByTestId("labels-card")).toBeInTheDocument();
    expect(screen.getByTestId("portal-card")).toBeInTheDocument();
  });

  it("a standalone product has no variants editor and keeps today's order", () => {
    current = { ...BASE_PRODUCT, variants: [] };
    show();
    expect(screen.queryByTestId("family-variants")).toBeNull();
  });
});

describe("K11-25: one true empty state", () => {
  it("a family with no sales shows exactly one 'Never sold' and no Demand card", () => {
    show();
    expect(screen.getAllByText("Never sold")).toHaveLength(1);
    expect(screen.queryByTestId("demand-card")).toBeNull();
    expect(
      screen.getByText("A family isn't sold itself. Each variant's sales are on its own page."),
    ).toBeInTheDocument();
    // the old line was false: a family's own card never shows its variants' sales
    expect(screen.queryByText(/Sales show here once a variant sells/)).toBeNull();
    expect(screen.queryByText(/hasn't appeared on an invoice yet/)).toBeNull();
  });

  it("keeps the Sales heading and its jump id, and the box is the compact 88 px one", () => {
    show();
    const h = screen.getByRole("heading", { name: "Sales" });
    expect(h).toHaveAttribute("id", "h-sales");
    const box = screen.getByText("Never sold").parentElement as HTMLElement;
    expect(box.className).toMatch(/h-\[88px\]/);
    expect(box.className).not.toMatch(/h-\[120px\]/);
  });

  it("'Create an order with this product' is hidden on every family, flag on or off", () => {
    show();
    expect(screen.queryByText(/Create an order with this product/)).toBeNull();
  });

  it("flag off: still one empty state and no create-order link", () => {
    flagOn = false;
    show();
    expect(screen.getAllByText("Never sold")).toHaveLength(1);
    expect(screen.queryByText(/Create an order with this product/)).toBeNull();
  });

  it("while the sales load only the Sales skeleton shows (no Demand)", () => {
    sales = { data: undefined, isLoading: true, isError: false, refetch: jest.fn() };
    show();
    expect(screen.queryByTestId("demand-card")).toBeNull();
    expect(screen.getByRole("heading", { name: "Sales" })).toBeInTheDocument();
    expect(screen.queryByText("Never sold")).toBeNull();
  });

  it("on an error Sales shows its own error state and Demand stays hidden", () => {
    sales = { data: undefined, isLoading: false, isError: true, refetch: jest.fn() };
    show();
    expect(screen.getByText("Couldn't load sales history.")).toBeInTheDocument();
    expect(screen.queryByTestId("demand-card")).toBeNull();
  });

  it("a family with old history (count > 0) shows both cards as before", () => {
    sales = {
      data: {
        summary: {
          count: 2,
          buyers: 1,
          totalQty: 3,
          totalRevenue: 4,
          minPrice: 1,
          avgPrice: 1,
          maxPrice: 1,
        } as never,
        lines: [],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    show();
    expect(screen.getByTestId("demand-card")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sales" })).toBeInTheDocument();
    expect(screen.queryByText("Never sold")).toBeNull();
  });

  it("a standalone product is unchanged: Demand and Sales both render, with their own copy and the order link", () => {
    current = { ...BASE_PRODUCT, variants: [] };
    show();
    expect(screen.getByTestId("demand-card")).toBeInTheDocument();
    expect(screen.getByText("Never sold")).toBeInTheDocument();
    expect(screen.getByText("This product hasn't appeared on an invoice yet.")).toBeInTheDocument();
    expect(screen.getByText(/Create an order with this product/)).toBeInTheDocument();
  });
});

describe("K11-25 P23: the family price stays editable behind a disclosure", () => {
  it("shows the true line and a collapsed 'Family price $1.25' disclosure", () => {
    show();
    expect(screen.getByText("New variants start from the family price.")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Family price $1.25" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(btn.getAttribute("aria-controls")!)!;
    expect(region).not.toBeNull();
    expect(region.className).toMatch(/invisible/);
    expect(screen.queryByText("Variants set their own prices.")).toBeNull();
  });

  it("expanding shows today's Price each row and Pricing Tiers, unchanged", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Family price $1.25" }));
    const btn = screen.getByRole("button", { name: "Family price $1.25" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const region = document.getElementById(btn.getAttribute("aria-controls")!)!;
    expect(region.className).not.toMatch(/invisible/);
    expect(region).toHaveTextContent("Pricing Tiers");
    expect(region).toHaveTextContent(/Price (each|per)/);
    expect(region).toHaveTextContent("$1.25");
  });

  it("Edit opens it and keeps it open, with the inputs and 'Set all to' there", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTitle("Edit product"));
    const btn = screen.getByRole("button", { name: /^Family price/ });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const region = document.getElementById(btn.getAttribute("aria-controls")!)!;
    expect(region).toContainElement(screen.getByRole("button", { name: /Set all to/ }));
    expect(region.querySelectorAll("input").length).toBeGreaterThanOrEqual(5);
    // clicking it while editing does not hide the inputs the operator is working in
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("the price row and tiers are not left in their old spots (one copy of each)", () => {
    show();
    expect(screen.getAllByText("Pricing Tiers")).toHaveLength(1);
  });

  it("a standalone product has no disclosure and keeps its price in the fact grid", () => {
    current = { ...BASE_PRODUCT, variants: [] };
    show();
    expect(screen.queryByRole("button", { name: /^Family price/ })).toBeNull();
    expect(screen.queryByText("New variants start from the family price.")).toBeNull();
    expect(screen.getAllByText("Pricing Tiers")).toHaveLength(1);
  });
});
