import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test-utils/render";
import ProductDetailPage from "./page";

/**
 * F28: a product with no photos used to open on a 176px (full phone screen with the card chrome) drop zone,
 * so no price was visible. The empty state is now one "Add photos" button. The page mounts for real; only the
 * network and its heavy neighbours are mocked. CropModal is a stub that exposes the queued file.
 */
const patch = jest.fn();
const toast = jest.fn();
let mockImages: string[] = [];

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
    useProduct: () => ({
      data: mockImages.length ? { ...PRODUCT, imageUrls: mockImages, imageKeys: ["k1"] } : PRODUCT,
      isLoading: false,
    }),
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

jest.mock("./CropModal", () => ({
  CropModal: ({ file }: { file: File }) => <div data-testid="crop-stub">{file.name}</div>,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockImages = [];
});

describe("F28: product page image card with no photos", () => {
  it("renders one 'Add photos' button, not the large drop zone", async () => {
    renderWithProviders(<ProductDetailPage />);
    const add = await screen.findByRole("button", { name: /add photos/i });
    expect(add.className).toMatch(/min-h-\[44px\]/);
    expect(screen.queryByText("Drop images here or click to upload")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upload images/i })).not.toBeInTheDocument();
  });

  it("clicking it opens the file picker and a chosen file reaches the crop queue (upload flow)", async () => {
    const user = userEvent.setup();
    const click = jest.spyOn(HTMLInputElement.prototype, "click");
    const { container } = renderWithProviders(<ProductDetailPage />);
    await user.click(await screen.findByRole("button", { name: /add photos/i }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["x"], "can.png", { type: "image/png" }));
    expect(await screen.findByTestId("crop-stub")).toHaveTextContent("can.png");
  });

  it("dropping a file on the collapsed control queues it", async () => {
    renderWithProviders(<ProductDetailPage />);
    const add = await screen.findByRole("button", { name: /add photos/i });
    const file = new File(["x"], "dropped.png", { type: "image/png" });
    fireEvent.dragOver(add, { dataTransfer: { files: [file] } });
    fireEvent.drop(add, { dataTransfer: { files: [file] } });
    expect(await screen.findByTestId("crop-stub")).toHaveTextContent("dropped.png");
  });

  it("with images the full gallery and the Upload images button stay, and there is no Add photos", async () => {
    mockImages = ["https://img.test/a.png"];
    renderWithProviders(<ProductDetailPage />);
    expect(await screen.findByRole("button", { name: /upload images/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add photos/i })).not.toBeInTheDocument();
  });
});
