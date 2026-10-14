import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * Lost edits on a failed save: the Details form closed synchronously on Save, so a 409/500 threw away what the
 * operator typed. Edit mode now closes only when the PATCH succeeds; a failure keeps the form open with the draft
 * and the error toast, and Save is disabled (no double submit) while the request is in flight. The REAL
 * `useUpdateProduct` mutation runs; only the network and the page's heavy neighbours are mocked.
 */
const patch = jest.fn();
const toast = jest.fn();

const PRODUCT = {
  id: "p1",
  name: "Acme Widget",
  sku: "SKU-1",
  barcode: null,
  unitSku: null,
  unit: "EACH",
  pricePerUnit: "10",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
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

const fail = (status: number, message: string) =>
  patch.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data: { message } } }),
  );

async function openAndType(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<ProductDetailPage />);
  await user.click(await screen.findByTitle("Edit product"));
  const sku = screen.getByDisplayValue("SKU-1");
  await user.clear(sku);
  await user.type(sku, "SKU-TYPED");
  return sku;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("product Details edit: save outcome", () => {
  it.each([
    [409, "SKU already in use"],
    [500, "Internal server error"],
  ])(
    "a %i on Save keeps the form open with the typed values and shows the error toast",
    async (status, msg) => {
      const user = userEvent.setup();
      fail(status, msg);
      await openAndType(user);
      await user.click(screen.getByRole("button", { name: /save/i }));
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Failed to save product", variant: "error" }),
        ),
      );
      expect(screen.getByDisplayValue("SKU-TYPED")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
      expect(screen.getByTitle("Cancel")).toBeInTheDocument();
    },
  );

  it("a successful save closes the form", async () => {
    const user = userEvent.setup();
    patch.mockResolvedValueOnce({ data: { id: "p1" } });
    await openAndType(user);
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByTitle("Edit product")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("SKU-TYPED")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("Save is disabled while the request is pending, and a second click sends nothing", async () => {
    const user = userEvent.setup();
    let resolve!: (v: unknown) => void;
    patch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await openAndType(user);
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(patch).toHaveBeenCalledTimes(1);
    resolve({ data: { id: "p1" } });
    await waitFor(() => expect(screen.getByTitle("Edit product")).toBeInTheDocument());
  });
});
