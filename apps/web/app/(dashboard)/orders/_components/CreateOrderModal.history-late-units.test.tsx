import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// B1139 (W-1170) follow-up: the late last-given price never lands on a line the unit machinery shaped (a derived Piece,
// a line whose unit was switched). Those lines drop a one-time price on purpose.
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
let mockPickerLadder: unknown[] | undefined;
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({ data: mockPickerLadder }),
  fetchProductUnits: () => Promise.resolve(mockPickerLadder ?? []),
  productUnitsKey: (id: string) => ["product-units", id],
  UNITS_FLAG: "flag.units_v1",
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
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
// A 12-pack at $45 (tier 1). Its default selling unit is the Piece, which has no price of its own: a DERIVED Piece
// that bills as the pack proration (1/12 of the pack price), and never takes a one-time price.
const WIDGET = {
  id: "prod-1",
  name: "Widget",
  pricePerUnit: "45",
  unit: "Case",
  unitsPerBox: 12,
  isActive: true,
};
const GADGET = { id: "prod-2", name: "Gadget", pricePerUnit: "10", unit: "each", isActive: true };
const pieceLevel = (isDefaultSelling: boolean) => ({
  id: "u1",
  label: "Piece",
  factorToBase: 1,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling,
  sortOrder: 0,
});
const layerReady = (): LayerState => ({
  enabled: true,
  isPending: false,
  isError: false,
  data: { complete: true, products: {} },
});
const LATE = { "prod-1": { lastPrice: 40 } };

const view = { current: null as null | { rerender: (ui: React.ReactElement) => void } };
const rerenderModal = () => view.current!.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
const historyArrives = (h: typeof history) => {
  history = h;
  historyPending = false;
  rerenderModal();
};
const pickProduct = async (search: string, name: RegExp) => {
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: search },
  });
  const list = await screen.findByRole("listbox", { name: "Products" });
  fireEvent.click(within(list).getByRole("option", { name }));
};
const openOrder = async () => {
  view.current = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "UX-" },
  });
  fireEvent.click(await screen.findByText("UX-Acme Foods"));
};
const sellBy = () => screen.findByLabelText("Sell Widget by") as Promise<HTMLSelectElement>;
const priceTexts = () => document.body.textContent ?? "";

describe("CreateOrderModal - the late last-given price skips lines the units shaped (B1139)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    layer = layerReady();
    history = undefined;
    historyPending = true;
    mockRows = [WIDGET, GADGET];
    mockPickerLadder = [pieceLevel(true)];
    cust.pricingTier = 1;
  });

  it("a Piece-default product with late history gets no pre-fill: the pieces bill at the pack proration", async () => {
    await openOrder();
    await pickProduct("wid", /Widget/);
    await waitFor(async () => expect((await sellBy()).value).toBe("Piece"));
    historyArrives(LATE);
    expect(screen.queryByText("Discounted")).not.toBeInTheDocument();
    expect(priceTexts()).not.toContain("40.00");
    expect(priceTexts()).toContain("3.75");
  });

  it("adding a second product does not re-price the first piece line", async () => {
    history = LATE;
    historyPending = false;
    await openOrder();
    await pickProduct("wid", /Widget/); // added with the pre-fill ($40 for the pack)
    fireEvent.change(await sellBy(), { target: { value: "Piece" } }); // the Piece drops the one-time price
    await waitFor(() => expect(priceTexts()).toContain("3.75"));
    await pickProduct("gad", /Gadget/); // layerSig changes: the effect runs again
    await screen.findAllByText(/Gadget/);
    expect(screen.queryByText("Discounted")).not.toBeInTheDocument();
    expect(priceTexts()).not.toContain("40.00");
    expect(priceTexts()).toContain("3.75");
  });

  it("Case, then Piece, then Case: the one-time price the switch dropped is not put back", async () => {
    mockPickerLadder = [pieceLevel(false)]; // no default unit: the line starts on the Case
    history = LATE;
    historyPending = false;
    await openOrder();
    await pickProduct("wid", /Widget/);
    expect(await screen.findByText("Discounted")).toBeInTheDocument(); // the pre-fill on the Case
    fireEvent.change(await sellBy(), { target: { value: "Piece" } });
    await waitFor(() => expect(screen.queryByText("Discounted")).not.toBeInTheDocument());
    fireEvent.change(await sellBy(), { target: { value: "" } }); // back to the Case
    await waitFor(() =>
      expect((screen.getByLabelText("Sell Widget by") as HTMLSelectElement).value).toBe(""),
    );
    historyArrives({ "prod-1": { lastPrice: 40 } }); // a refetch: new object, same answer
    expect(screen.queryByText("Discounted")).not.toBeInTheDocument();
    expect(priceTexts()).not.toContain("40.00");
  });
});
