import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// S19b slice B (SA-811a R1/R3, SA-813 M1/M3): the create modal prices a line through the customer's price layer.
// The layer hook is the one seam (the server resolves the rows; no ladder is evaluated here).
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createOrderMutate = jest.fn();
const refetchLayer = jest.fn();
type LayerState = {
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
  data?: { complete: boolean; products: Record<string, unknown[]> } | null;
};
let mockScanV2 = true;
let activeOrder: Record<string, unknown> | undefined;
let layer: LayerState;
let history: Record<string, { lastPrice: number }> | undefined;
const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 3 };
const rerenderModal = (view: { rerender: (ui: React.ReactElement) => void }) =>
  view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);

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
        refetch: refetchLayer,
      };
    },
  };
});
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: {
      capabilities: {
        fulfilment: {
          methods: ["SHIP"],
          staffDefault: "SHIP",
          staffOpensAs: "order",
          portalMethods: [],
          portalDefault: null,
          counter: "off",
          fleet: false,
          consistent: true,
        },
      },
    },
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [cust] } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: activeOrder }),
  useCustomerPriceHistory: () => ({ data: history }),
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
  useScanV2: () => mockScanV2,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void; title?: string }) => {
    capturedOnScan = props.onScan;
    return <button type="button">{props.title}</button>;
  },
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
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

// List $42, tier 3 $38: the customer typed $33 on the pack (SPECIAL, R3), or $45 above list (MANUAL, SA-811a R2).
const widget = {
  notFound: false,
  archived: false,
  product: {
    id: "prod-1",
    name: "Widget",
    pricePerUnit: "42",
    priceTier2: "40",
    priceTier3: "38",
    unit: "each",
  },
};
const packRow = (over: Record<string, unknown>) => ({
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
  ...over,
});
const layerReady = (rows: unknown[]): LayerState => ({
  enabled: true,
  isPending: false,
  isError: false,
  data: { complete: true, products: { "prod-1": rows } },
});

const addWidgetForCustomer = async () => {
  const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  // the scan handler closes over the chosen customer: let that render commit before scanning
  await new Promise((r) => setTimeout(r, 50));
  capturedOnScan!("111");
  await screen.findByText("Widget");
  return view;
};
const saveDraft = () => fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
const sentItem = () => createOrderMutate.mock.calls[0][0].items[0];

describe("CreateOrderModal - the customer's price layer (S19b slice B)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveProductByCode.mockResolvedValue(widget);
    history = { "prod-1": { lastPrice: 36 } }; // last-given $36 is below the $38 tier price
    layer = { enabled: false, isPending: false, isError: false, data: null };
    cust.pricingTier = 3;
    mockScanV2 = true;
    activeOrder = undefined;
  });

  it("flag off: no layer, master's tier price ($38) and nothing sent as an override", async () => {
    await addWidgetForCustomer();
    expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(sentItem().overrideReason).toBeUndefined();
    expect(screen.queryByText("Checking this customer's prices…")).not.toBeInTheDocument();
  });

  it("B-1: a typed $33 pre-fills $33 SPECIAL, not last-given $36, and saves with no price or reason", async () => {
    cust.pricingTier = 1; // Retail customer, typed $33: last-given $36 would pre-fill if R3 did not skip it
    layer = layerReady([packRow({})]);
    await addWidgetForCustomer();
    expect(await screen.findByText("$33.00 / each")).toBeInTheDocument();
    expect(screen.queryByText("$36.00 / each")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(sentItem().unitPrice).toBeUndefined(); // the server bills the layer (a permanent special is no override)
    expect(sentItem().overrideReason).toBeUndefined();
  });

  it("B-3: a typed $45 above list is MANUAL: $45 shown, no reason prompt, nothing sent as an override", async () => {
    layer = layerReady([packRow({ price: 45, aboveList: true })]);
    await addWidgetForCustomer();
    expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(sentItem().unitPrice).toBeUndefined();
    expect(sentItem().overrideReason).toBeUndefined();
  });

  it("B-5: a layer query error disables Create and Save, names the failure, and Retry refetches", async () => {
    layer = { enabled: true, isPending: false, isError: true, data: null };
    await addWidgetForCustomer();
    expect(await screen.findByText(/Couldn't load this customer's prices\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create order/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save as draft/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchLayer).toHaveBeenCalledTimes(1);
    saveDraft();
    expect(createOrderMutate).not.toHaveBeenCalled();
  });

  it("B-5b: a pending layer shows the unconfirmed marker, never a final price, and Create waits", async () => {
    layer = { enabled: true, isPending: true, isError: false, data: null };
    const view = await addWidgetForCustomer();
    expect(await screen.findByText("Checking this customer's prices…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create order/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save as draft/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // never a final price: while a line price is on screen the unconfirmed marker is too (SA-813 M1) ...
    expect(screen.getByText("$38.00 / each")).toBeInTheDocument();
    expect(screen.getByTestId("order-price-layer-pending")).toHaveTextContent(
      "Checking this customer's prices…",
    );
    // ... and it goes away, with the buttons enabling, only once the layer confirms the prices
    layer = layerReady([packRow({})]);
    rerenderModal(view);
    await waitFor(() =>
      expect(screen.queryByTestId("order-price-layer-pending")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("$33.00 / each")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create order/i })).toBeEnabled();
  });
  it("flag off, tier 1: master's last-given pre-fill ($36 < $42) is kept and sent", async () => {
    cust.pricingTier = 1;
    await addWidgetForCustomer();
    expect(await screen.findByText("$36.00 / each")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    expect(sentItem().unitPrice).toBe(36);
  });

  it("review 1: a last-given pre-fill taken while the layer is pending yields to the layer's $33 once ready", async () => {
    cust.pricingTier = 1; // a Retail customer with a typed price: last-given $36 < list $42 pre-fills (SPECIAL tiers skip it)
    layer = { enabled: true, isPending: true, isError: false, data: null };
    const view = await addWidgetForCustomer();
    layer = layerReady([packRow({})]);
    rerenderModal(view);
    expect(await screen.findByText("$33.00 / each")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    expect(sentItem().unitPrice).toBeUndefined();
    expect(sentItem().overrideReason).toBeUndefined();
  });

  it("review 7: new layer data re-prices ($33 -> $31); a row that disappears returns to master's $38", async () => {
    mockScanV2 = false; // the scan_v2 effect would mask the layer effect's own restore
    layer = layerReady([packRow({})]);
    const view = await addWidgetForCustomer();
    expect(await screen.findByText("$33.00 / each")).toBeInTheDocument();
    layer = layerReady([packRow({ price: 31 })]);
    rerenderModal(view);
    expect(await screen.findByText("$31.00 / each")).toBeInTheDocument();
    layer = layerReady([]);
    rerenderModal(view);
    expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
  });
  it.each([[false], [true]])(
    "MUST-7: the server drops a vanished typed row (product ABSENT from products): back to master's $38 (scan_v2 %s)",
    async (scanV2) => {
      mockScanV2 = scanV2;
      layer = layerReady([packRow({})]);
      const view = await addWidgetForCustomer();
      expect(await screen.findByText("$33.00 / each")).toBeInTheDocument();
      layer = {
        enabled: true,
        isPending: false,
        isError: false,
        data: { complete: true, products: {} },
      };
      rerenderModal(view);
      expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
    },
  );

  it("nit 4: a layered MANUAL (above-list) line re-prices when the layer's row goes away (scan_v2 on and off)", async () => {
    mockScanV2 = false;
    layer = layerReady([packRow({ price: 45, aboveList: true })]);
    const view = await addWidgetForCustomer();
    expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
    layer = {
      enabled: true,
      isPending: false,
      isError: false,
      data: { complete: true, products: {} },
    };
    rerenderModal(view);
    expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
  });

  it("merge prompt: a layer that fails after the prompt opened disables both choices and says why", async () => {
    activeOrder = { id: "o1", orderNumber: "ORD-1", status: "PENDING", itemCount: 1, total: 40 };
    layer = layerReady([packRow({})]);
    const view = await addWidgetForCustomer();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    const merge = await screen.findByRole("button", { name: /merge into ORD-1/i });
    expect(merge).toBeEnabled();
    layer = { enabled: true, isPending: false, isError: true, data: null };
    rerenderModal(view);
    expect(await screen.findByTestId("merge-price-layer-wait")).toHaveTextContent(
      /Couldn't load this customer's prices\./,
    );
    expect(screen.getByRole("button", { name: /merge into ORD-1/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /create as separate/i })).toBeDisabled();
    expect(createOrderMutate).not.toHaveBeenCalled();
  });

  it("nit 1: flag off, the last-given pre-fill is not marked systemPrefill (draft blobs stay byte-identical)", async () => {
    cust.pricingTier = 1;
    await addWidgetForCustomer();
    expect(await screen.findByText("$36.00 / each")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    expect(JSON.stringify(createOrderMutate.mock.calls[0][0])).not.toContain("systemPrefill");
  });
});
