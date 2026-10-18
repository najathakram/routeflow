import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * K11-20c: Details on the v2 page. With the flag on, the case price and the four tier prices are read-only figures
 * (each a button that opens the floating price window), "Edit prices" is disabled while Details is in edit mode, and the
 * Details save carries no price key at all, so S9 is the only writer of prices. Flag OFF: nothing changes.
 * The REAL page, `useProduct`, `useUpdateProduct` and the page-level price host run; the network is a tiny in-memory
 * server and the heavy neighbours are mocked.
 */
let flagOn = true;
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
  useAuth: () => ({ user: { role: "OPERATOR" } }),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
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
  ProductUnitsCard: () => <div data-testid="units-card" />,
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
jest.mock("@/components/PackSizePrompt", () => ({ PackSizePrompt: () => null }));

async function renderPage() {
  const view = renderWithProviders(<ProductDetailPage />);
  await screen.findByTitle("Edit product");
  return view;
}
const line = () => screen.getByTestId("details-price-line");
const edit = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByTitle("Edit product"));
const rename = async (user: ReturnType<typeof userEvent.setup>) => {
  const name = screen.getByDisplayValue("Acme Widget");
  await user.clear(name);
  await user.type(name, "Acme Widget 2");
};
const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  return patch.mock.calls[0][1] as Record<string, unknown>;
};

beforeEach(() => {
  jest.clearAllMocks();
  flagOn = true;
  getProduct.mockImplementation(() => Promise.resolve({ data: { ...PRODUCT } }));
  patch.mockResolvedValue({ data: { id: "p1" } });
});

describe("K11-20c Details, v2 on", () => {
  it("shows one read-only price line from the served grid, each figure a button to the window", async () => {
    await renderPage();
    const l = await screen.findByTestId("details-price-line");
    await waitFor(() => expect(l).toHaveTextContent("$30.00"));
    expect(l).toHaveTextContent("Retail");
    expect(l).toHaveTextContent("$28.00");
    expect(l).toHaveTextContent("Tier 5");
    expect(l).toHaveTextContent("$22.00");
    // The product row's own (stale) figures are not what Details shows.
    expect(l).not.toHaveTextContent("$10.00");
    expect(within(l).getByRole("button", { name: "Edit Retail Case price" })).toBeInTheDocument();
    expect(within(l).getByRole("button", { name: "Edit Tier 2 Case price" })).toBeInTheDocument();
  });

  it("a figure opens the floating price window on that box, anchored over Details", async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByTestId("details-price-line");
    await user.click(await screen.findByRole("button", { name: "Edit Tier 2 Case price" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(within(dialog).getByTestId("units-v2-input-case-2")).toHaveFocus());
  });

  it("in Details edit mode the price fields are gone: the line is read-only and Edit prices is disabled", async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByTestId("details-price-line");
    await edit(user);
    expect(screen.queryByDisplayValue("10.00")).toBeNull();
    expect(screen.queryByDisplayValue("9.00")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Set all to/ })).toBeNull();
    expect(within(line()).queryByRole("button", { name: /^Edit (Retail|Tier)/ })).toBeNull();
    const trigger = within(line()).getByRole("button", { name: "Edit prices" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAccessibleDescription("Save or cancel Details first");
  });

  it("the Details save body has no price key, even after a rename", async () => {
    const user = userEvent.setup();
    await renderPage();
    await edit(user);
    await rename(user);
    const body = await save(user);
    expect(body.name).toBe("Acme Widget 2");
    for (const k of PRICE_KEYS) expect(Object.keys(body)).not.toContain(k);
  });

  it("wraps the prices section in the region that widens in inline edit mode", async () => {
    await renderPage();
    expect(await screen.findByTestId("units-v2-region")).toContainElement(
      screen.getByTestId("pricing-v2"),
    );
  });
});

describe("K11-20c Details, flag OFF is unchanged", () => {
  beforeEach(() => {
    flagOn = false;
  });

  it("keeps the price inputs and sends the case price when it is edited", async () => {
    const user = userEvent.setup();
    await renderPage();
    expect(screen.queryByTestId("details-price-line")).toBeNull();
    expect(screen.queryByTestId("units-v2-region")).toBeNull();
    await edit(user);
    const price = screen.getAllByDisplayValue("10.00")[0];
    await user.clear(price);
    await user.type(price, "11");
    const body = await save(user);
    expect(body.pricePerUnit).toBe("11");
  });
});
