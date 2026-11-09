import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// B1139 (W-1170): a line added before the customer price history has loaded takes the last-given price once it arrives.
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

// List $45; the customer is on the list price (tier 1), so a last-given $40 is a pre-fill below the tier price.
const WIDGET = {
  id: "prod-1",
  name: "Widget",
  pricePerUnit: "45",
  priceTier2: "43",
  priceTier3: "42",
  unit: "each",
  isActive: true,
};
const layerReady = (): LayerState => ({
  enabled: true,
  isPending: false,
  isError: false,
  data: { complete: true, products: {} },
});
const LATE = { "prod-1": { lastPrice: 40 } };

const view = { current: null as null | { rerender: (ui: React.ReactElement) => void } };
const rerenderModal = () => view.current!.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
// the history query answers: the same re-render a settled query gives
const historyArrives = (h: typeof history) => {
  history = h;
  historyPending = false;
  rerenderModal();
};

const addLine = async (shows = "$45.00 / each") => {
  view.current = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "UX-" },
  });
  fireEvent.click(await screen.findByText("UX-Acme Foods"));
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: "wid" },
  });
  const list = await screen.findByRole("listbox", { name: "Products" });
  fireEvent.click(within(list).getByRole("option", { name: /Widget/ }));
  expect(await screen.findByText(shows)).toBeInTheDocument();
};
const addBeforeHistory = () => addLine();
const typePrice = async (value: string) => {
  fireEvent.click(screen.getAllByLabelText("Change price")[0]);
  const sheet = await screen.findByRole("dialog", { name: /^edit /i });
  fireEvent.change(within(sheet).getByLabelText("Price"), { target: { value } });
  fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
};

describe("CreateOrderModal - the last-given price arrives after the add (B1139)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    layer = layerReady();
    history = undefined;
    historyPending = true; // the history read is still out
    mockRows = [WIDGET];
    cust.pricingTier = 1;
  });

  it("a line added before the history loaded takes the last-given price when it arrives", async () => {
    await addBeforeHistory();
    historyArrives(LATE);
    expect(await screen.findByText("$40.00 / each")).toBeInTheDocument();
    // it is the same pre-filled one-time price an add after the history would have made
    expect(screen.getByText("Discounted")).toBeInTheDocument();
  });

  it("a price the operator typed stands when the history arrives", async () => {
    await addBeforeHistory();
    await typePrice("44.00");
    expect(await screen.findByText("$44.00 / each")).toBeInTheDocument();
    historyArrives(LATE);
    expect(screen.getByText("$44.00 / each")).toBeInTheDocument();
    expect(screen.queryByText("$40.00 / each")).not.toBeInTheDocument();
  });

  it("a price the operator typed at the tier price stands too (it is a choice, not an untouched line)", async () => {
    await addBeforeHistory();
    await typePrice("45.00");
    historyArrives(LATE);
    expect(screen.getByText("$45.00 / each")).toBeInTheDocument();
    expect(screen.queryByText("$40.00 / each")).not.toBeInTheDocument();
  });

  it("a pre-fill the operator cleared is not put back by a later refresh of the history", async () => {
    history = LATE;
    historyPending = false;
    await addLine("$40.00 / each"); // added AFTER the history: the pre-fill is there from the start
    await typePrice("");
    expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
    historyArrives({ "prod-1": { lastPrice: 40 } }); // a refetch: new object, same answer
    expect(screen.getByText("$45.00 / each")).toBeInTheDocument();
  });

  it("flag off (no price layer): the line keeps the price it was added at", async () => {
    layer = { enabled: false, isPending: false, isError: false, data: null };
    await addBeforeHistory();
    historyArrives(LATE);
    expect(screen.getByText("$45.00 / each")).toBeInTheDocument();
  });
});
