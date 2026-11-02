import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * SA-1082 A-1 on the page: a family save that changes a price asks first. The REAL `useUpdateProduct` runs; the network,
 * the read and the page's heavy neighbours are mocked. VM-W1 and VM-W2.
 */
const patch = jest.fn();
const mockPreview = jest.fn();
const toast = jest.fn();

const PRODUCT = {
  id: "p1",
  name: "Acme Widget",
  sku: "SKU-1",
  barcode: null,
  unitSku: null,
  unit: "EACH",
  pricePerUnit: "24",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  msrp: null,
  category: "Misc",
  description: null,
  isActive: true,
  kind: "FAMILY",
  currentStock: 5,
  images: [],
  imageKeys: [],
  unitsPerBox: null,
  parentProductId: null,
  packTenantUnitId: "tu-each",
};

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { patch: (...a: unknown[]) => patch(...a), get: jest.fn(), post: jest.fn() },
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/products", () => {
  const rq = jest.requireActual("@tanstack/react-query");
  const client = jest.requireMock("@/lib/api-client").apiClient;
  const idle = () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false });
  return {
    useProduct: () => ({ data: PRODUCT, isLoading: false }),
    useProducts: () => ({ data: { data: [] } }),
    previewFamilyMove: (...a: unknown[]) => mockPreview(...a),
    useUpdateProduct: () =>
      rq.useMutation({
        mutationFn: ({ id, ...data }: { id: string }) =>
          client.patch(`/products/${id}`, data).then((r: { data: unknown }) => r.data),
      }),
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

jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Pending: () => false,
}));

const TWO = {
  count: 2,
  variants: [
    { id: "v1", name: "Acme One", from: 24, to: 26 },
    { id: "v2", name: "Acme Two", from: 24, to: 26 },
  ],
  retailFrom: 24,
  retailTo: 26,
};

async function typeNewPrice(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<ProductDetailPage />);
  await user.click(await screen.findByTitle("Edit product"));
  const [price] = screen.getAllByDisplayValue("24.00") as [HTMLInputElement];
  await user.clear(price);
  await user.type(price, "26");
  await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("VM-W1: saving a family's price", () => {
  it("asks with the price it would save, and sends nothing until answered", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TWO);
    await typeNewPrice(user);
    expect(await screen.findByText("Move the 2 variants at $24.00 to $26.00?")).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ pricePerUnit: expect.anything() }),
    );
    expect(Number(mockPreview.mock.calls[0][1].pricePerUnit)).toBe(26);
    expect(patch).not.toHaveBeenCalled();
  });

  it("Move them saves with the listed ids, and the toast says how many moved", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TWO);
    patch.mockResolvedValueOnce({ data: { id: "p1", movedVariants: 2 } });
    await typeNewPrice(user);
    await user.click(await screen.findByTestId("family-move-confirm"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1].moveVariantIds).toEqual(["v1", "v2"]);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Saved",
        description: "2 variants moved.",
        variant: "success",
      }),
    );
  });

  it("Keep their prices saves the family and names no variant", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TWO);
    patch.mockResolvedValueOnce({ data: { id: "p1" } });
    await typeNewPrice(user);
    await user.click(await screen.findByTestId("family-move-keep"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).not.toHaveProperty("moveVariantIds");
    expect(Number(patch.mock.calls[0][1].pricePerUnit)).toBe(26);
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Saved", variant: "success" }));
  });

  it("closing the question saves nothing, and the form stays open", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue(TWO);
    await typeNewPrice(user);
    await screen.findByTestId("family-move-list");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("family-move-list")).toBeNull());
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getAllByDisplayValue(/^26/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /save/i })[0]).toBeEnabled();
  });
});

describe("VM-W2: no question", () => {
  it("nobody at the family's price: it saves straight away", async () => {
    const user = userEvent.setup();
    mockPreview.mockResolvedValue({ count: 0, variants: [], retailFrom: 24, retailTo: 26 });
    patch.mockResolvedValueOnce({ data: { id: "p1" } });
    await typeNewPrice(user);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("family-move-list")).toBeNull();
    expect(patch.mock.calls[0][1]).not.toHaveProperty("moveVariantIds");
  });

  it("no price changed: it doesn't read or ask", async () => {
    const user = userEvent.setup();
    patch.mockResolvedValueOnce({ data: { id: "p1" } });
    renderWithProviders(<ProductDetailPage />);
    await user.click(await screen.findByTitle("Edit product"));
    const sku = screen.getByDisplayValue("SKU-1");
    await user.clear(sku);
    await user.type(sku, "SKU-TYPED");
    await user.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(mockPreview).not.toHaveBeenCalled();
  });
});
