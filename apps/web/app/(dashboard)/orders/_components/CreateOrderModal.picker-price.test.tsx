import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// W-1170 F8: the product picker shows the price the line will carry for the chosen customer, not the list price.
// The add path and the picker row read ONE function (linePriceAtAdd), so what the row says is what the line gets.
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
let historyError = false;
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
  useCustomerPriceHistory: () => ({
    data: history,
    isPending: historyPending,
    isError: historyError,
  }),
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

// List $45, tier 3 $42.
const WIDGET = {
  id: "prod-1",
  name: "Widget",
  pricePerUnit: "45",
  priceTier2: "43",
  priceTier3: "42",
  unit: "each",
  isActive: true,
};
// A 12-pack sold by the Case, priced per pack: the row must say which unit its price is for.
const BOXED = { ...WIDGET, id: "prod-3", name: "UX-Crate", unitsPerBox: 12, packLabel: "Case" };
const FAMILY = {
  id: "f-1",
  name: "UX-Pod",
  kind: "FAMILY",
  parentProductId: null,
  unit: "each",
  pricePerUnit: "0",
  isActive: true,
  variants: [
    {
      id: "v-1",
      name: "Mint",
      variantName: "Mint",
      kind: "VARIANT",
      parentProductId: "f-1",
      unit: "each",
      pricePerUnit: "45",
      priceTier2: "43",
      priceTier3: "42",
      isActive: true,
    },
  ],
};
const layerReady = (): LayerState => ({
  enabled: true,
  isPending: false,
  isError: false,
  data: { complete: true, products: {} },
});

const pickCustomer = async () => {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "UX-" },
  });
  fireEvent.click(await screen.findByText("UX-Acme Foods"));
};
const openPicker = async (term: string) => {
  fireEvent.change(screen.getByPlaceholderText(/search by name, sku or scan barcode/i), {
    target: { value: term },
  });
  return screen.findByRole("listbox", { name: "Products" });
};
const struck = (el: HTMLElement) => el.className.includes("line-through");

describe("CreateOrderModal product picker - the customer's price (W-1170 F8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    layer = layerReady();
    history = undefined;
    historyPending = false;
    historyError = false;
    mockRows = [WIDGET];
    cust.pricingTier = 3;
  });

  it("a tier-3 customer: the row shows the tier price $42.00 with the list $45.00 struck", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(within(row).getByText("$42.00")).toBeInTheDocument();
    const was = within(row).getByText("$45.00");
    expect(struck(was)).toBe(true);
  });

  it("a screen reader hears one sentence for a struck list: list price, then the customer price", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(row).toHaveAccessibleName(
      expect.stringContaining("List price $45.00, customer price $42.00"),
    );
    expect(row.textContent).toContain("List price $45.00, customer price ");
    expect(row.querySelector(".line-through")).toHaveAttribute("aria-hidden", "true");
  });

  it("the row price is the price the added line gets", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    fireEvent.click(within(list).getByRole("option", { name: /Widget/ }));
    expect(await screen.findByText("$42.00 / each")).toBeInTheDocument();
  });

  it("no customer picked: the list price, no strike", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(struck(within(row).getByText("$45.00"))).toBe(false);
    expect(within(row).queryByText("$42.00")).not.toBeInTheDocument();
  });

  it("the customer's last-given price below the tier shows too, as the line will carry it", async () => {
    cust.pricingTier = 1; // a special tier (3) is a permanent price: last-given never pre-fills over it
    history = { "prod-1": { lastPrice: 40 } };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(within(row).getByText("$40.00")).toBeInTheDocument();
    expect(struck(within(row).getByText("$45.00"))).toBe(true);
  });

  it("while the customer's price layer is still loading: the list price, no strike, no wrong claim", async () => {
    layer = { enabled: true, isPending: true, isError: false, data: null };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(struck(within(row).getByText("$45.00"))).toBe(false);
    expect(within(row).queryByText("$42.00")).not.toBeInTheDocument();
  });

  it("while the price history is still loading: the list price, no strike", async () => {
    historyPending = true;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(struck(within(row).getByText("$45.00"))).toBe(false);
    expect(within(row).queryByText("$42.00")).not.toBeInTheDocument();
  });

  it("when the price history read failed: the list price, muted and unstruck, like a read still out", async () => {
    historyError = true; // the read failed: whether a last-given price exists is unknown
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(struck(within(row).getByText("$45.00"))).toBe(false);
    expect(within(row).queryByText("$42.00")).not.toBeInTheDocument();
  });

  it("a boxed product: the price names the pack word it is for (the line may start on another unit)", async () => {
    mockRows = [BOXED];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("crate");
    const row = within(list).getByRole("option", { name: /UX-Crate/ });
    expect(within(row).getByText("$42.00")).toBeInTheDocument();
    expect(within(row).getByText("/ case")).toBeInTheDocument();
  });

  it("a product sold by one unit: no extra word, its unit already sits beside the name", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(within(row).queryByText((text) => text.startsWith("/"))).not.toBeInTheDocument();
  });

  it("a customer on the list price: one price, no strike", async () => {
    cust.pricingTier = 1;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(struck(within(row).getByText("$45.00"))).toBe(false);
  });

  it("a variant row shows its own customer price the same way", async () => {
    mockRows = [FAMILY];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("pod");
    fireEvent.click(within(list).getByRole("option", { name: /UX-Pod/ }));
    const row = await screen.findByRole("option", { name: /UX-Pod - Mint/ });
    expect(within(row).getByText("$42.00")).toBeInTheDocument();
    expect(struck(within(row).getByText("$45.00"))).toBe(true);
  });

  it("flag off (no price layer): the picker keeps the list price", async () => {
    layer = { enabled: false, isPending: false, isError: false, data: null };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    const list = await openPicker("wid");
    const row = within(list).getByRole("option", { name: /Widget/ });
    expect(within(row).getByText("$45.00")).toBeInTheDocument();
    await waitFor(() => expect(within(row).queryByText("$42.00")).not.toBeInTheDocument());
  });
});
