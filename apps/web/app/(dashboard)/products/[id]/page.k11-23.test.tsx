import * as React from "react";
import { cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K11-23: prices on the first phone screen. The DOM order is the reading order on a phone and the tab order:
 * the Details card, then the Image and stock column, then everything else. No `order-*` classes.
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
jest.mock("./OpenOrdersCard", () => ({
  OpenOrdersCard: () => <div data-testid="open-orders-card" />,
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

function cards() {
  renderWithProviders(<ProductDetailPage />);
  const details = screen.getByRole("heading", { name: "Details" }).closest("div.overflow-hidden")!;
  const image = screen.getByRole("heading", { name: "Image" }).closest("div.overflow-hidden")!;
  return { details, image };
}

describe("K11-23: Details first, then Image and stock, then the rest", () => {
  beforeEach(() => {
    role = "OPERATOR";
  });

  it("the DOM order is Details, Image, Stock and cost, then the cards after them", async () => {
    const { details, image } = cards();
    const stock = screen.getByTestId("stock-card");
    expect(follows(details, image)).toBe(true);
    expect(follows(image, stock)).toBe(true);
    for (const id of ["labels-card", "portal-card", "units-card", "demand-card", "sales-card"]) {
      expect(follows(stock, screen.getByTestId(id))).toBe(true);
    }
  });

  it("staff see Open orders above Sales; a non-staff role does not", () => {
    cards();
    const open = screen.getByTestId("open-orders-card");
    expect(follows(screen.getByTestId("demand-card"), open)).toBe(true);
    expect(follows(open, screen.getByTestId("sales-card"))).toBe(true);
    cleanup();
    role = "DRIVER";
    cards();
    expect(screen.queryByTestId("open-orders-card")).toBeNull();
    expect(screen.getByTestId("sales-card")).toBeInTheDocument();
  });

  it("is built from three grid items placed at lg, never from order-* classes or display: contents", () => {
    const { details, image } = cards();
    const grid = details.closest(".grid") as HTMLElement;
    expect(grid.className).toMatch(/lg:grid-cols-3/);
    expect(grid.className).toMatch(/lg:gap-y-5/);
    // Row 1 is Details' own height whatever the image column's height: a tall Image + Stock column (3 photos) spans both
    // rows, and with two auto rows its extra height was spread into row 1, widening the gap under Details.
    expect(grid.className).toMatch(/lg:grid-rows-\[auto_1fr\]/);
    const items = Array.from(grid.children) as HTMLElement[];
    expect(items).toHaveLength(3);
    expect(items[0]).toContainElement(details as HTMLElement);
    expect(items[0].className).toMatch(/lg:col-span-2 lg:col-start-2 lg:row-start-1/);
    expect(items[1]).toContainElement(image as HTMLElement);
    expect(items[1].className).toMatch(/lg:col-start-1 lg:row-start-1 lg:row-span-2/);
    expect(items[2]).toContainElement(screen.getByTestId("labels-card"));
    expect(items[2].className).toMatch(/lg:col-span-2 lg:col-start-2 lg:row-start-2/);
    expect(grid.outerHTML).not.toMatch(/(^|[\s"])(sm:|md:|lg:)?order-/);
    expect(grid.outerHTML).not.toMatch(/\bcontents\b/);
  });

  it("Buyer merchandising ends the Details body, after Description, on every width", () => {
    const { details } = cards();
    const merch = screen.getByRole("heading", { name: "Buyer merchandising" });
    expect(details).toContainElement(merch);
    const description = screen.getByText("Description");
    expect(follows(description, merch)).toBe(true);
    // the first fact (SKU) now comes before it, so the price row is nearer the top
    expect(follows(screen.getByText("SKU (box code)"), merch)).toBe(true);
    expect(screen.getAllByRole("switch").map((s) => s.textContent)).toEqual([
      expect.stringContaining("Featured"),
      expect.stringContaining("New"),
      expect.stringContaining("Deal"),
    ]);
  });

  it("the price row sits before Buyer merchandising and before the tier grid in Details", () => {
    cards();
    const price = screen.getByText(/^Price per/);
    expect(follows(price, screen.getByRole("heading", { name: "Buyer merchandising" }))).toBe(true);
  });

  it("a non-staff user sees no merchandising, and the rest of the order holds", () => {
    role = "STAFF";
    const { details, image } = cards();
    expect(screen.queryByRole("heading", { name: "Buyer merchandising" })).toBeNull();
    expect(follows(details, image)).toBe(true);
  });

  it("in edit mode the card keeps its 'apply immediately' note, still at the end of Details", async () => {
    const user = userEvent.setup();
    const { details } = cards();
    await user.click(screen.getByTitle("Edit product"));
    const note = screen.getByText("These switches apply immediately, without Save.");
    expect(details).toContainElement(note);
    expect(follows(screen.getByText("Description"), note)).toBe(true);
  });
});
