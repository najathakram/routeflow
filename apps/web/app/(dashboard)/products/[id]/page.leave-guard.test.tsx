/* eslint-disable @next/next/no-html-link-for-pages -- plain anchors on purpose: the guard must catch any link, and jsdom has no router */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, fireEvent, waitFor } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * UX audit 2026-11-24, F03 (with F04): on the product page a typed price or description was lost by one click on
 * the side menu, with no question. The page now uses the order page's leave guard: a click on a link that leaves
 * the page, Back and a reload all ask "Discard your changes?" while the Details form holds a change.
 */
const mockPush = jest.fn();
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
  description: "A fine product",
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
  useRouter: () => ({ push: mockPush }),
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

const Screen = () => (
  <>
    <nav>
      <a href="/customers">Customers</a>
    </nav>
    <ProductDetailPage />
  </>
);
const startEditing = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTitle("Edit product"));
  return screen.getByDisplayValue("Acme Widget");
};
const question = () => screen.queryByText("Discard your changes?");
/** Click the menu link; report whether the guard stopped it (and stop jsdom from trying to navigate). */
function clickMenu(): boolean {
  let stopped = true;
  const record = (e: MouseEvent) => {
    stopped = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener("click", record);
  fireEvent.click(screen.getByRole("link", { name: "Customers" }));
  document.removeEventListener("click", record);
  return stopped;
}

beforeEach(() => {
  role = "OPERATOR";
  mockPush.mockReset();
  window.history.replaceState({}, "", "/products/p1");
});

describe("Product page: unsaved Details edits are never lost silently (F03)", () => {
  it("a changed name, then a click on a menu link: asks, and does not leave", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Screen />);
    await user.type(await startEditing(user), " XL");
    expect(clickMenu()).toBe(true);

    expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
    expect(
      screen.getByText("You have unsaved edits to this product. If you leave now they are lost."),
    ).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Keep editing closes the question and the typed value is still in the box", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Screen />);
    await user.type(await startEditing(user), " XL");
    clickMenu();
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));

    await waitFor(() => expect(question()).not.toBeInTheDocument());
    expect(screen.getByDisplayValue("Acme Widget XL")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Discard drops the edit and follows the link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Screen />);
    await user.type(await startEditing(user), " XL");
    clickMenu();
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/customers"));
    expect(screen.queryByDisplayValue("Acme Widget XL")).not.toBeInTheDocument();
  });

  it("edit mode with nothing changed: the link is not stopped", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Screen />);
    await startEditing(user);
    expect(clickMenu()).toBe(false);
    expect(question()).not.toBeInTheDocument();
  });

  it("a change typed and then typed back is not a change", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Screen />);
    const name = await startEditing(user);
    await user.type(name, "X");
    await user.type(name, "{Backspace}");
    expect(clickMenu()).toBe(false);
  });

  it("not editing: the link is not stopped", () => {
    renderWithProviders(<Screen />);
    expect(clickMenu()).toBe(false);
  });
});
