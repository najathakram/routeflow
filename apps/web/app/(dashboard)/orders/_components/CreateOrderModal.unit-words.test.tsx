import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// W-1170 polish P11: a boxed line speaks the product's own pack word in its price, quantity and stock text.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

type LayerState = {
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
  data?: { complete: boolean; products: Record<string, unknown[]> } | null;
};
let layer: LayerState;
let history: Record<string, { lastPrice: number; stickyPrice?: number | null }> | undefined;
let historyPending = false;
let mockRows: unknown[] = [];
const mockNoCustomerPrices = { data: [] };
const cust = { id: "c1", businessName: "UX-Acme Foods", pricingTier: 3 };

jest.mock("@/lib/api/useCustomerPriceLayer", () => {
  const { priceLayerStatus } = jest.requireActual("@routeflow/pricing");
  return {
    useCustomerPriceLayer: (customerId?: string) => {
      const enabled = layer.enabled && !!customerId;
      const status = priceLayerStatus({ ...layer, enabled });
      return {
        ...status,
        layerOf: (id?: string) => (enabled && id ? layer.data?.products[id] : undefined),
        error: null,
        refetch: jest.fn(),
      };
    },
  };
});
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [cust] } }),
  useCustomerPrices: () => mockNoCustomerPrices,
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockRows } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useActiveOrderForCustomer: () => ({ data: undefined }),
  useCustomerPriceHistory: () => ({ data: history, isPending: historyPending }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateDraft: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteDraft: () => ({ mutate: jest.fn() }),
  useDraft: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({
  useHasAddon: () => false,
  useTenantAddons: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => true,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/components/CustomerAccountStrip", () => ({ CustomerAccountStrip: () => null }));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => <button type="button">scan</button>,
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: () => ({
    videoRef: { current: null },
    torchAvailable: false,
    torchOn: false,
    toggleTorch: jest.fn(),
    refocus: jest.fn(),
    error: null,
  }),
}));
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));

const boxed = (over: Record<string, unknown>) => ({
  id: "prod-1",
  name: "UX-Jerky",
  pricePerUnit: "42",
  unitsPerBox: 12,
  isActive: true,
  ...over,
});
const layerOff = (): LayerState => ({
  enabled: false,
  isPending: false,
  isError: false,
  data: null,
});

const addFromPicker = async () => {
  renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: "jer" },
  });
  const list = await screen.findByRole("listbox", { name: "Products" });
  fireEvent.click(within(list).getByRole("option", { name: /UX-Jerky/ }));
  return screen.findByRole("listitem");
};

describe("CreateOrderModal - the product's own unit words on a boxed line (W-1170 P11)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    layer = layerOff();
    history = undefined;
    historyPending = false;
  });

  it("a pack label the business chose: price, quantity and pack size all say it", async () => {
    mockRows = [boxed({ unit: "case", packLabel: "Carton" })];
    const row = await addFromPicker();
    expect(within(row).getByText("$42.00 / carton")).toBeInTheDocument();
    expect(within(row).getByTitle("Number of whole cartons")).toBeInTheDocument();
    expect(within(row).getByText(/1 carton = 12/)).toBeInTheDocument();
    expect(within(row).queryByText(/box/i)).not.toBeInTheDocument();
  });

  it("a loose-item label the business chose reaches the line too", async () => {
    mockRows = [boxed({ unit: "case", baseUnitLabel: "Bottle" })];
    const row = await addFromPicker();
    expect(within(row).getByTitle(/^Add extra bottles/)).toBeInTheDocument();
  });

  it("no label: the default Box words, as before", async () => {
    mockRows = [boxed({ unit: "each" })];
    const row = await addFromPicker();
    expect(within(row).getByText("$42.00 / box")).toBeInTheDocument();
    expect(within(row).getByTitle("Number of whole boxes")).toBeInTheDocument();
    expect(within(row).getByText(/1 box = 12/)).toBeInTheDocument();
  });
});
