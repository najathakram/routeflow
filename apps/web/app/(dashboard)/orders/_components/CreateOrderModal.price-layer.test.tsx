import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
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
let history: Record<string, { lastPrice: number; stickyPrice?: number | null }> | undefined;
// One reference across renders, as a settled query gives: a new array would re-run every effect and hide a missing dependency.
const mockNoCustomerPrices = { data: [] };
let customerPrices: { data: { productId: string; pricingTier: number }[] } = mockNoCustomerPrices;
const cust = { id: "c1", businessName: "Acme Foods", pricingTier: 3 };
const custB = { id: "c2", businessName: "Beta Bakery", pricingTier: 3 };
const custC = { id: "c3", businessName: "Cedar Cafe", pricingTier: 2 };
const custD = { id: "c4", businessName: "Dune Deli", pricingTier: 2 };
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
  useCustomers: () => ({ data: { data: [cust, custB, custC, custD] } }),
  useCustomerPrices: () => customerPrices,
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
// Row 661: the Account strip has its own Retry button and its own specs; this file is about a different Retry.
jest.mock("@/components/CustomerAccountStrip", () => ({ CustomerAccountStrip: () => null }));
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

  describe("SA-1068 M15: a line scanned before the customer", () => {
    const scanThenPickAcme = async () => {
      history = undefined; // no customer yet, so no memory
      const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      capturedOnScan!("111");
      await screen.findByText("Widget");
      return view;
    };
    const pickAcme = async () => {
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: "Acm" },
      });
      fireEvent.click(await screen.findByText("Acme Foods"));
    };

    beforeEach(() => {
      cust.pricingTier = 1; // Retail: list $42 is the tier price
    });

    it("T13: a customer with a memory puts the line on it, and no price is sent", async () => {
      await scanThenPickAcme();
      history = { "prod-1": { lastPrice: 45, stickyPrice: 45 } };
      await pickAcme();
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
      );
      saveDraft();
      expect(sentItem().unitPrice).toBeUndefined();
    });

    it("T14: a customer with no memory leaves the tier price", async () => {
      await scanThenPickAcme();
      await pickAcme();
      expect(await screen.findByText("$42.00 / each")).toBeInTheDocument();
    });

    it("M15: a history that arrives after the pick moves the line", async () => {
      const view = await scanThenPickAcme();
      await pickAcme();
      expect(await screen.findByText("$42.00 / each")).toBeInTheDocument();
      history = { "prod-1": { lastPrice: 45, stickyPrice: 45 } };
      view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
    });
  });

  it.each([true, false])(
    "B755: a price pre-filled from customer A's history does not follow the order to customer B (scan_v2 %s)",
    async (scanV2) => {
      mockScanV2 = scanV2;
      cust.pricingTier = 1; // Retail: A's last-given $36 < list $42 pre-fills (a SPECIAL tier skips history)
      await addWidgetForCustomer();
      // A's last-given $36 pre-filled the line
      expect(await screen.findByText("$36.00 / each")).toBeInTheDocument();
      history = undefined; // B has no history
      fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
      fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
        target: { value: "Bet" },
      });
      fireEvent.click(await screen.findByText("Beta Bakery"));
      // B is tier 3 ($38): A's negotiated $36 must be gone, and nothing is sent as an override
      expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
      expect(screen.queryByText("$36.00 / each")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
      );
      saveDraft();
      expect(sentItem().unitPrice).toBeUndefined();
      expect(sentItem().overrideReason).toBeUndefined();
    },
  );

  // #3840 review MUSTs: only a price the history pre-filled for A is dropped on a switch; anything the
  // operator did to the line (typed price, typed reason, revert) is theirs and follows the order.
  const switchToBeta = async () => {
    history = undefined; // B has no history
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Bet" },
    });
    fireEvent.click(await screen.findByText("Beta Bakery"));
  };
  const openEditor = (shown: string) => fireEvent.click(screen.getByText(shown));
  const closeEditor = () =>
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /^Edit / })).getByRole("button", { name: "Close" }),
    );
  const saved = async () => {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save as draft/i })).toBeEnabled(),
    );
    saveDraft();
    return sentItem();
  };

  it("B755 MUST 1a: a price typed over A's pre-fill survives the switch to B", async () => {
    cust.pricingTier = 1;
    await addWidgetForCustomer();
    openEditor(await screen.findByText("$36.00 / each").then((e) => e.textContent!));
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "30" } });
    closeEditor();
    expect(await screen.findByText("$30.00 / each")).toBeInTheDocument();
    await switchToBeta();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("$30.00 / each")).toBeInTheDocument();
    const item = await saved();
    expect(item.unitPrice).toBe(30);
  });

  it("B755 MUST 1b: a reason typed on A's pre-filled price keeps the price and reason through the switch", async () => {
    cust.pricingTier = 1;
    await addWidgetForCustomer();
    openEditor("$36.00 / each");
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "dented cans" } });
    closeEditor();
    await switchToBeta();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("$36.00 / each")).toBeInTheDocument();
    const item = await saved();
    expect(item.unitPrice).toBe(36);
    expect(item.overrideReason).toBe("dented cans");
  });

  it("B755 MUST 1c: a price reverted to the tier price re-prices to B's tier price, nothing sent as an override", async () => {
    cust.pricingTier = 1;
    await addWidgetForCustomer();
    openEditor("$36.00 / each");
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "" } });
    closeEditor();
    expect(await screen.findByText("$42.00 / each")).toBeInTheDocument();
    await switchToBeta();
    expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
    const item = await saved();
    expect(item.unitPrice).toBeUndefined();
    expect(item.overrideReason).toBeUndefined();
  });

  // SA-1068 A-5: what the line shows is what the request books. List $42, tier 3 $38, memory $45.
  describe("SA-1068 A-5: a remembered price above list", () => {
    const typePrice = (shown: string, value: string) => {
      openEditor(shown);
      fireEvent.change(screen.getByLabelText("Price"), { target: { value } });
      closeEditor();
    };

    beforeEach(() => {
      mockScanV2 = false;
      history = { "prod-1": { lastPrice: 45, stickyPrice: 45 } };
    });

    it("T18: tier 1, typing list shows list and sends it", async () => {
      cust.pricingTier = 1;
      await addWidgetForCustomer();
      typePrice("$45.00 / each", "42");
      expect(await screen.findByText("$42.00 / each")).toBeInTheDocument();
      expect((await saved()).unitPrice).toBe(42);
    });

    it("T19: tier 1, typing then clearing returns to the memory and sends nothing", async () => {
      cust.pricingTier = 1;
      await addWidgetForCustomer();
      typePrice("$45.00 / each", "43");
      typePrice("$43.00 / each", "");
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      expect((await saved()).unitPrice).toBeUndefined();
    });

    // The tier baseline it keeps is T21: the tier price needs no reason.
    it("T20: tier 3, a new line starts at the memory and sends nothing", async () => {
      await addWidgetForCustomer();
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      expect((await saved()).unitPrice).toBeUndefined();
    });

    it("T21: tier 3, typing the tier price shows it and sends it, with no reason asked", async () => {
      await addWidgetForCustomer();
      typePrice("$45.00 / each", "38");
      expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
      const item = await saved();
      expect(item.unitPrice).toBe(38);
      expect(item.overrideReason).toBeUndefined();
    });

    it("T22: tier 3, typing then clearing returns to the memory and sends nothing", async () => {
      await addWidgetForCustomer();
      typePrice("$45.00 / each", "43");
      typePrice("$43.00 / each", "");
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      expect((await saved()).unitPrice).toBeUndefined();
    });

    it("T23: a failed history read, typing list still sends it", async () => {
      cust.pricingTier = 1;
      history = undefined;
      await addWidgetForCustomer();
      typePrice("$42.00 / each", "42");
      expect((await saved()).unitPrice).toBe(42);
    });

    it("T24: a line moved to its memory keeps its baseline, so list needs no reason and is sent", async () => {
      mockScanV2 = true;
      cust.pricingTier = 1;
      history = undefined;
      const view = await addWidgetForCustomer();
      history = { "prod-1": { lastPrice: 45, stickyPrice: 45 } };
      rerenderModal(view);
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      typePrice("$45.00 / each", "42");
      const item = await saved();
      expect(item.unitPrice).toBe(42);
      expect(item.overrideReason).toBeUndefined();
    });

    it("M21: the customer effect keeps the tier baseline, so list on a tier 3 line asks a reason", async () => {
      mockScanV2 = true;
      history = undefined;
      const view = await addWidgetForCustomer();
      history = { "prod-1": { lastPrice: 45, stickyPrice: 45 } };
      rerenderModal(view);
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      openEditor("$45.00 / each");
      fireEvent.change(screen.getByLabelText("Price"), { target: { value: "42" } });
      expect(await screen.findByLabelText("Reason (required)")).toBeInTheDocument();
    });

    it("T26: a line at its memory has the memory as the box's placeholder", async () => {
      await addWidgetForCustomer();
      openEditor("$45.00 / each");
      expect(screen.getByLabelText("Price")).toHaveAttribute("placeholder", "45.00");
    });

    it("T27 guard: no memory, typing list sends nothing and asks no reason", async () => {
      cust.pricingTier = 1;
      history = {};
      await addWidgetForCustomer();
      typePrice("$42.00 / each", "42");
      openEditor("$42.00 / each");
      expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
      closeEditor();
      expect((await saved()).unitPrice).toBeUndefined();
    });

    it("T28 guard: a layer row beats the memory, typing its price then clearing sends nothing", async () => {
      layer = layerReady([packRow({})]);
      await addWidgetForCustomer();
      typePrice("$33.00 / each", "33");
      openEditor("$33.00 / each");
      expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
      closeEditor();
      typePrice("$33.00 / each", "34");
      typePrice("$34.00 / each", "");
      expect(await screen.findByText("$33.00 / each")).toBeInTheDocument();
      expect((await saved()).unitPrice).toBeUndefined();
    });

    it("T29 guard: a memory below list is no sticky price, clearing returns to list", async () => {
      cust.pricingTier = 1;
      history = { "prod-1": { lastPrice: 40, stickyPrice: 40 } };
      await addWidgetForCustomer();
      typePrice("$40.00 / each", "");
      expect(await screen.findByText("$42.00 / each")).toBeInTheDocument();
      expect((await saved()).unitPrice).toBeUndefined();
    });

    it("T35: typed, then cleared back to A's memory, the line still moves to B's price", async () => {
      await addWidgetForCustomer();
      typePrice("$45.00 / each", "43");
      typePrice("$43.00 / each", "");
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      await switchToBeta();
      expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
    });

    it("M20: a line at A's memory does not follow the order to B", async () => {
      await addWidgetForCustomer();
      expect(await screen.findByText("$45.00 / each")).toBeInTheDocument();
      await switchToBeta();
      expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
    });

    // List $42, tier 2 $38, tier 3 $36. A's memory is $45, B's is $50, C has none, D is on tier 3 for this product.
    describe("SA-1068 A-7 M27: a linked line follows its customer", () => {
      const stocked = {
        ...widget,
        product: { ...widget.product, priceTier2: "38", priceTier3: "36" },
      };
      const A = { "prod-1": { lastPrice: 45, stickyPrice: 45 } };
      const B = { "prod-1": { lastPrice: 50, stickyPrice: 50 } };
      type View = { rerender: (ui: React.ReactElement) => void };
      const shows = (price: string) => screen.findByText(`$${price}.00 / each`);
      const land = (view: View, read: typeof history) => {
        history = read;
        rerenderModal(view);
      };
      const switchTo = async (name: string, read: typeof history) => {
        history = read; // the mock has one read: what's here at the switch is what's cached, undefined is still out
        fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
        fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
          target: { value: name.slice(0, 3) },
        });
        fireEvent.click(await screen.findByText(name));
      };

      beforeEach(() => {
        mockResolveProductByCode.mockResolvedValue(stocked);
        cust.pricingTier = 2;
        custB.pricingTier = 2;
        customerPrices = mockNoCustomerPrices;
      });
      afterEach(() => {
        custB.pricingTier = 3;
        customerPrices = mockNoCustomerPrices;
      });

      const walks: [string, (view: View) => Promise<void>][] = [
        [
          "T37: to B with the read out, then it lands",
          async (view) => {
            await switchTo("Beta Bakery", undefined);
            await shows("38");
            land(view, B);
            await shows("50");
          },
        ],
        [
          "T38: to B cached, then to C with no memory",
          async () => {
            await switchTo("Beta Bakery", B);
            await shows("50");
            await switchTo("Cedar Cafe", {});
            await shows("38");
          },
        ],
        [
          "T39: to C with no memory, then back to A",
          async () => {
            await switchTo("Cedar Cafe", {});
            await shows("38");
            await switchTo("Acme Foods", A);
            await shows("45");
          },
        ],
        [
          "T40: to C with no memory, then on to B",
          async () => {
            await switchTo("Cedar Cafe", {});
            await shows("38");
            await switchTo("Beta Bakery", B);
            await shows("50");
          },
        ],
        [
          "T41: to B with the read out, back to A before it lands",
          async () => {
            await switchTo("Beta Bakery", undefined);
            await shows("38");
            await switchTo("Acme Foods", A);
            await shows("45");
          },
        ],
        [
          "T42: to D, the history lands first and the customer's prices last",
          async (view) => {
            await switchTo("Dune Deli", undefined);
            await shows("38");
            land(view, {});
            await shows("38");
            customerPrices = { data: [{ productId: "prod-1", pricingTier: 3 }] };
            rerenderModal(view);
            await shows("36");
          },
        ],
      ];

      it.each(walks)("%s, and nothing is sent", async (_, walk) => {
        const view = await addWidgetForCustomer();
        await shows("45");
        await walk(view);
        expect((await saved()).unitPrice).toBeUndefined();
      });

      it.each(walks)("T45 guard, scan_v2 on: %s", async (_, walk) => {
        mockScanV2 = true;
        const view = await addWidgetForCustomer();
        await shows("45");
        await walk(view);
        expect((await saved()).unitPrice).toBeUndefined();
      });

      it("T54 guard: with no resume, a failed history read still lets the customer's prices land", async () => {
        await addWidgetForCustomer().then(async (view) => {
          await shows("45");
          await switchTo("Dune Deli", undefined);
          await shows("38");
          customerPrices = { data: [{ productId: "prod-1", pricingTier: 3 }] };
          rerenderModal(view);
          await shows("36");
        });
        expect((await saved()).unitPrice).toBeUndefined();
      });

      it("T43 guard: a price typed while the read is out stands when it lands", async () => {
        const view = await addWidgetForCustomer();
        await shows("45");
        await switchTo("Beta Bakery", undefined);
        await shows("38");
        openEditor("$38.00 / each");
        fireEvent.change(screen.getByLabelText("Price"), { target: { value: "30" } });
        fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "dented cans" } });
        closeEditor();
        await shows("30");
        land(view, B);
        await new Promise((r) => setTimeout(r, 50));
        await shows("30");
        expect((await saved()).unitPrice).toBe(30);
      });

      it("T44 guard: a Retail price pre-filled at $45 stands when A is picked again", async () => {
        cust.pricingTier = 1;
        await addWidgetForCustomer();
        await shows("45");
        await switchTo("Acme Foods", A);
        await new Promise((r) => setTimeout(r, 50));
        await shows("45");
        expect((await saved()).unitPrice).toBe(45);
      });
    });
  });

  it("B755 MUST 2: A's last price equal to B's tier price leaves a plain line (no stale stamp or override)", async () => {
    cust.pricingTier = 1;
    history = { "prod-1": { lastPrice: 38 } }; // A's last-given $38 == B's tier-3 price
    await addWidgetForCustomer();
    expect(await screen.findByText("$38.00 / each")).toBeInTheDocument();
    await switchToBeta();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("$38.00 / each")).toBeInTheDocument();
    // plain line: no one-time price left on it (the editor shows no typed price and no Reason field)
    openEditor("$38.00 / each");
    expect(screen.getByLabelText("Price")).toHaveValue("");
    expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
    closeEditor();
    const item = await saved();
    expect(item.unitPrice).toBeUndefined();
    expect(item.overrideReason).toBeUndefined();
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
