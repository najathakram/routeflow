import * as React from "react";
import { renderWithProviders, screen, waitFor, act, fireEvent, cleanup } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { createMemoryDraftStorage, setDraftMirrorStorage } from "@/lib/order-draft/storage";
import { readDraftSubmitKey } from "@routeflow/types/draft-submit-key";
import { counterCartToDraftPayload } from "@/lib/counter-ship-handoff";

// SA-817 (A): an in-progress staff order survives a connection drop / reload and resumes.
//   A1 reload + reopen offers "Resume your unsent order?" with the same lines
//   A2 autosave to SaleDraft from the first parkable change, without Minimize
//   A4 (UI half) 409 DRAFT_CHANGED -> "Keep this one or open the other?", both kept
//   A5 resume shows today's price + "Price changed since you started"; a typed override with its reason survives
//   A6 submit, response lost, reload, resume, submit again: the SAME Idempotency-Key
// The local mirror is the in-memory adapter (no IndexedDB in jsdom); the server draft calls are the modal's own mutations.

window.HTMLElement.prototype.scrollIntoView = jest.fn();

let mockUser: Record<string, unknown> | null = { id: "u1", tenantId: "t1", role: "OPERATOR" };
jest.mock("@/lib/auth-context", () => {
  const actual = jest.requireActual("@/lib/auth-context");
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), user: mockUser }) };
});

let mockCustomers: Array<Record<string, unknown>> = [];
// The customer's remembered prices; the rows without a memory read an empty history.
let mockHistory: Record<string, unknown> = { data: {} };
// One reference across renders, as a settled query gives: a new array would re-run the customer effect on every render.
const mockNoCustomerPrices = { data: [] };
// SA-1076 A-1: T36 to T42 read through the real hooks. Set after the line is parked; each answer is per customer.
let mockRealReads = false;
let mockPricesAnswer: (customerId: string) => Promise<unknown> = () =>
  Promise.resolve({ data: [] });
let mockHistoryAnswer: (customerId: string) => Promise<unknown> = () =>
  Promise.resolve({ data: {} });
jest.mock("@/lib/api/customers", () => {
  const actual = jest.requireActual("@/lib/api/customers");
  return {
    useCustomers: () => ({ data: { data: mockCustomers } }),
    useCustomerPrices: (id?: string) =>
      mockRealReads ? actual.useCustomerPrices(id) : mockNoCustomerPrices,
    useCustomer: () => ({ data: undefined }),
  };
});
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => {
  const actual = jest.requireActual("@/lib/api/orders");
  return {
    ...actual,
    useActiveOrderForCustomer: () => ({ data: undefined }),
    useCustomerPriceHistory: (id?: string) =>
      mockRealReads ? actual.useCustomerPriceHistory(id) : mockHistory,
  };
});

const mockCreateDraft = jest.fn();
const mockUpdateDraft = jest.fn();
const mockDeleteDraft = jest.fn();
let mockLoadedDraft: unknown = undefined;
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({
    mutate: jest.fn(),
    mutateAsync: (...a: unknown[]) => mockCreateDraft(...a),
    isPending: false,
  }),
  useUpdateDraft: () => ({
    mutate: jest.fn(),
    mutateAsync: (...a: unknown[]) => mockUpdateDraft(...a),
    isPending: false,
  }),
  useDeleteDraft: () => ({ mutate: (...a: unknown[]) => mockDeleteDraft(...a) }),
  useDraft: () => ({ data: mockLoadedDraft, isFetching: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

let mockServerDrafts: unknown[] = [];
// GET /products/:id - today's tier columns per product; null = the read fails (offline).
let mockProductNow: Record<string, Record<string, unknown>> | null = {};
// A product read held open: it lands when the row releases this.
let mockProductHold: Promise<void> | null = null;
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn((url: string, config?: { params?: { customerId: string } }) => {
      const m = /^\/products\/([^/]+)$/.exec(url);
      if (m) {
        const read = () => {
          const row = mockProductNow?.[m[1]];
          return row ? Promise.resolve({ data: row }) : Promise.reject(new Error("Network Error"));
        };
        return mockProductHold ? mockProductHold.then(read) : read();
      }
      const prices = /^\/customers\/([^/]+)\/prices$/.exec(url);
      if (prices) return mockPricesAnswer(prices[1]);
      if (url === "/orders/price-history") return mockHistoryAnswer(config!.params!.customerId);
      return Promise.resolve({ data: url === "/drafts" ? mockServerDrafts : { taxRate: 0 } });
    }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

let capturedOnScan: ((code: string) => void) | undefined;
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { onScan: (code: string) => void; title?: string }) => {
    capturedOnScan = props.onScan;
    return (
      <button type="button" title={props.title} aria-label={props.title}>
        {props.title}
      </button>
    );
  },
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
let mockScanV2 = false;
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => mockScanV2,
  useOrderUiV2: () => ({ enabled: false, resolved: true }),
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
jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
// A ready layer with no rows, so a line added re-runs the customer effect. Set before the modal mounts.
let mockLayerOn = false;
let mockLayerFailed = false;
jest.mock("@/lib/api/useCustomerPriceLayer", () => {
  const actual = jest.requireActual("@/lib/api/useCustomerPriceLayer");
  const { priceLayerStatus } = jest.requireActual("@routeflow/pricing");
  const on = {
    ...priceLayerStatus({
      enabled: true,
      isPending: false,
      isError: false,
      data: { complete: true, products: {} },
    }),
    layerOf: () => undefined,
    error: null,
    refetch: jest.fn(),
  };
  const failed = {
    ...on,
    ...priceLayerStatus({ enabled: true, isPending: false, isError: true, data: undefined }),
  };
  return {
    ...actual,
    useCustomerPriceLayer: (customerId?: string) =>
      mockLayerFailed ? failed : mockLayerOn ? on : actual.useCustomerPriceLayer(customerId),
  };
});
const mockResolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolveProductByCode(code),
}));
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

import { apiClient } from "@/lib/api-client";

const post = apiClient.post as jest.Mock;
const orderPosts = () => post.mock.calls.filter((c) => c[0] === "/orders");
const keyOf = (i: number) => orderPosts()[i][2]?.headers?.["Idempotency-Key"] as string;
const bodyOf = (i: number) => orderPosts()[i][1] as { items: Array<Record<string, unknown>> };
const product = (id: string) => ({
  notFound: false,
  archived: false,
  product: { id, name: `Widget ${id}`, pricePerUnit: "9.99", unit: "each" },
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
const createBtn = () => screen.getByRole("button", { name: /^create order$/i });
const NEVER = () => new Promise(() => undefined);
const PREFIX = "rf:draft:t1:u1:";

let storage: ReturnType<typeof createMemoryDraftStorage>;

async function pickCustomerAndScan(code = "111", id = "p1") {
  mockCustomers = [{ id: "c1", businessName: "Acme Foods", pricingTier: 1 }];
  mockResolveProductByCode.mockResolvedValue(product(id));
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
  capturedOnScan!(code);
  await screen.findByText(`Widget ${id}`);
}

const localRecords = () => storage.list(PREFIX);
const waitForLocalCopy = () =>
  waitFor(async () => expect(await localRecords()).toHaveLength(1), { timeout: 4000 });

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: "u1", tenantId: "t1", role: "OPERATOR" };
  mockServerDrafts = [];
  mockLoadedDraft = undefined;
  mockProductNow = {};
  mockHistory = { data: {} };
  mockScanV2 = false;
  mockLayerOn = false;
  mockLayerFailed = false;
  mockRealReads = false;
  mockProductHold = null;
  mockPricesAnswer = () => Promise.resolve({ data: [] });
  mockHistoryAnswer = () => Promise.resolve({ data: {} });
  storage = createMemoryDraftStorage();
  setDraftMirrorStorage(storage);
  mockCreateDraft.mockImplementation(() => NEVER()); // the server is unreachable unless a test says otherwise
  mockUpdateDraft.mockImplementation(() => NEVER());
});
afterEach(() => setDraftMirrorStorage(null));

describe("CreateOrderModal - draft autosave and resume (SA-817 A)", () => {
  it("A2: the server draft is created from the first parkable change (customer + one line), without Minimize", async () => {
    mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomerAndScan();

    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    const dto = mockCreateDraft.mock.calls[0][0];
    expect(dto).toMatchObject({ kind: "ORDER", customerId: "c1", customerName: "Acme Foods" });
    expect(dto.payload.lineItems).toHaveLength(1);
    expect(dto.payload._submitKey).toEqual(expect.any(String));
  });

  it("A2: a customer alone (no line yet) is not worth a server row", async () => {
    mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
    mockCustomers = [{ id: "c1", businessName: "Acme Foods", pricingTier: 1 }];
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
      target: { value: "Acm" },
    });
    fireEvent.click(await screen.findByText("Acme Foods"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300));
    });
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it("A2: the next edit PATCHes the same draft with the updatedAt the server returned (expectedUpdatedAt)", async () => {
    mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
    mockUpdateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:05.000Z" });
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomerAndScan();
    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });

    mockResolveProductByCode.mockResolvedValue(product("p2"));
    capturedOnScan!("222");
    await screen.findByText("Widget p2");
    await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(mockUpdateDraft.mock.calls[0][0]).toMatchObject({
      id: "d1",
      expectedUpdatedAt: "2026-10-19T10:00:00.000Z",
    });
    expect(mockUpdateDraft.mock.calls[0][0].payload.lineItems).toHaveLength(2);
  });

  it("A1: a fresh order survives a reload; reopening offers 'Resume your unsent order?' with the same lines", async () => {
    // the server never answers (a dropped connection): only the local copy can save the order
    const first = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomerAndScan();
    await waitForLocalCopy();
    first.unmount(); // the reload

    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    expect(await screen.findByText("Resume your unsent order?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Widget p1")).toBeInTheDocument();
    expect(screen.getAllByText("Acme Foods").length).toBeGreaterThan(0);
  });

  it("A1: nothing is offered when there is nothing unsent", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await flush();
    expect(screen.queryByText("Resume your unsent order?")).not.toBeInTheDocument();
  });

  it("A7: another user's unsent order in the same browser is never offered", async () => {
    const first = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomerAndScan();
    await waitForLocalCopy();
    first.unmount();

    mockUser = { id: "u2", tenantId: "t1", role: "OPERATOR" };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await flush();
    expect(screen.queryByText("Resume your unsent order?")).not.toBeInTheDocument();
  });

  it("A1: 'Not now' leaves the copy on the device (nothing is deleted)", async () => {
    const first = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomerAndScan();
    await waitForLocalCopy();
    first.unmount();

    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await screen.findByText("Resume your unsent order?");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByText("Resume your unsent order?")).not.toBeInTheDocument(),
    );
    expect(await localRecords()).toHaveLength(1);
  });

  describe("A5 - resume re-prices for display", () => {
    const parked = () => ({
      customer: { id: "c1", businessName: "Acme Foods", pricingTier: 1 },
      lineItems: [
        {
          tempId: "t1",
          productId: "p1",
          productName: "Widget p1",
          unit: "each",
          listPrice: 10,
          unitPrice: 10,
          priceType: "STANDARD",
          qty: 1,
          tierPrices: { pricePerUnit: 10 }, // the snapshot parked with the line: STALE
        },
        {
          tempId: "t2",
          productId: "p2",
          productName: "Widget p2",
          unit: "each",
          listPrice: 12,
          unitPrice: 8,
          discountedPrice: 8,
          overrideReason: "Damaged box",
          priceType: "DISCOUNTED",
          qty: 1,
          tierPrices: { pricePerUnit: 10 },
        },
      ],
      orderDiscount: "",
      shippingFee: "",
      requestedDeliveryDate: "",
      orderDate: "",
      notes: "",
      urgent: false,
      floorAcked: [],
      commissionRatePct: null,
      fulfillPath: undefined,
      _submitKey: "K-PARKED",
    });

    async function seedParked(payload: unknown = parked()) {
      const { createDraftMirror } = await import("@/lib/order-draft/mirror");
      const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      m.write({
        localId: "L-parked",
        serverDraftId: null,
        serverUpdatedAt: null,
        syncedHash: null,
        customerId: "c1",
        customerName: "Acme Foods",
        payload: payload as never,
      });
      await m.flush();
    }

    it("A5: parked at $10, the product's tier column is now $12 (the snapshot still says $10): shows $12 and 'Price changed since you started'; a typed override with its reason survives", async () => {
      mockProductNow = {
        p1: { id: "p1", pricePerUnit: "12" },
        p2: { id: "p2", pricePerUnit: "12" },
      };
      await seedParked();
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await screen.findByText("Resume your unsent order?");
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await screen.findByText("Widget p1");

      const note = await screen.findByTestId("price-changed-note");
      expect(note).toHaveTextContent("Price changed since you started ($10.00 → $12.00)");
      expect(screen.getAllByTestId("price-changed-note")).toHaveLength(1); // the override line carries no note

      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
      const items = bodyOf(0).items;
      // the server prices the plain line; only the staff-typed override is sent, with its reason, as typed
      expect(items.find((i) => i.productId === "p1")).not.toHaveProperty("unitPrice");
      expect(items.find((i) => i.productId === "p2")).toMatchObject({
        unitPrice: 8,
        overrideReason: "Damaged box",
      });
    });

    it("A5 offline: the product reads fail - resume still works, the lines stay as parked, and the screen says prices were not refreshed", async () => {
      mockProductNow = null;
      await seedParked();
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await screen.findByText("Resume your unsent order?");
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await screen.findByText("Widget p1");
      expect(await screen.findByTestId("prices-not-refreshed")).toHaveTextContent(
        "Prices not refreshed. They are checked again when you submit.",
      );
      expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
      // never blocks: the order can still be submitted
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
    });

    it("A5: when every read works there is no 'not refreshed' notice", async () => {
      mockProductNow = {
        p1: { id: "p1", pricePerUnit: "10" },
        p2: { id: "p2", pricePerUnit: "12" },
      };
      await seedParked();
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await screen.findByText("Resume your unsent order?");
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await screen.findByText("Widget p1");
      await flush();
      expect(screen.queryByTestId("prices-not-refreshed")).not.toBeInTheDocument();
    });

    describe("SA-1068 A-3: a cart shipped from the till, resumed", () => {
      const customer = { id: "c1", businessName: "Acme Foods", pricingTier: 1 };
      const tillLine = {
        tempId: "till-1",
        productId: "p1",
        name: "Widget p1",
        qty: 2,
        listPrice: 12,
        unit: "each",
      };
      const atMemory = () =>
        counterCartToDraftPayload(
          [{ ...tillLine, unitPrice: 15, priceType: "MANUAL" as const }],
          customer,
        );
      const productReads = () =>
        (apiClient.get as jest.Mock).mock.calls.filter((c) => c[0] === "/products/p1");
      const resume = async () => {
        const view = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await screen.findByText("Resume your unsent order?");
        fireEvent.click(screen.getByRole("button", { name: "Resume" }));
        await screen.findByText("Widget p1");
        await flush();
        return view;
      };

      beforeEach(() => {
        mockProductNow = { p1: { id: "p1", pricePerUnit: "12" } };
      });

      it("T12: the line stays at its memory, with no note, no price sent and the total the invoice will carry", async () => {
        mockHistory = {
          data: { p1: { lastPrice: 15, stickyPrice: 15 } },
          isPending: false,
          isError: false,
        };
        await seedParked(atMemory());
        post.mockResolvedValue({ data: { id: "o1" } });
        await resume();
        await waitFor(() => expect(productReads()).toHaveLength(1));
        await flush();
        expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
        expect(screen.getByText("$15.00 / each")).toBeInTheDocument();
        expect(screen.getAllByText("$30.00").length).toBeGreaterThan(0);

        fireEvent.click(createBtn());
        await waitFor(() => expect(orderPosts()).toHaveLength(1));
        expect(bodyOf(0).items[0]).not.toHaveProperty("unitPrice");
      });

      it("M14: the re-price waits for the history read", async () => {
        mockHistory = { data: undefined, isPending: true, isError: false };
        await seedParked(atMemory());
        const view = await resume();
        expect(productReads()).toHaveLength(0);

        mockHistory = {
          data: { p1: { lastPrice: 15, stickyPrice: 15 } },
          isPending: false,
          isError: false,
        };
        view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
        await waitFor(() => expect(productReads()).toHaveLength(1));
        await flush();
        expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
      });

      it("T17: a failed history read keeps the line as parked and says so, never a false note", async () => {
        mockHistory = { data: undefined, isPending: false, isError: true };
        await seedParked(atMemory());
        await resume();
        expect(await screen.findByTestId("prices-not-refreshed")).toBeInTheDocument();
        expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
        expect(screen.getByText("$15.00 / each")).toBeInTheDocument();
      });

      it("T16: a failed refetch keeps the cached memories, so the re-price still runs on them", async () => {
        mockHistory = {
          data: { p1: { lastPrice: 15, stickyPrice: 15 } },
          isPending: false,
          isError: true,
        };
        await seedParked(atMemory());
        await resume();
        await waitFor(() => expect(productReads()).toHaveLength(1));
        await flush();
        expect(screen.queryByTestId("prices-not-refreshed")).not.toBeInTheDocument();
        expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
        expect(screen.getByText("$15.00 / each")).toBeInTheDocument();
      });

      it("T15: a typed price is sent with its reason", async () => {
        await seedParked(
          counterCartToDraftPayload(
            [
              {
                ...tillLine,
                unitPrice: 8,
                priceType: "STANDARD",
                tierPrice: 12,
                override: { reason: "Damaged box" },
              },
            ],
            customer,
          ),
        );
        post.mockResolvedValue({ data: { id: "o1" } });
        await resume();
        expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();

        fireEvent.click(createBtn());
        await waitFor(() => expect(orderPosts()).toHaveLength(1));
        expect(bodyOf(0).items[0]).toMatchObject({ unitPrice: 8, overrideReason: "Damaged box" });
      });

      // SA-1068 A-8: the builder's own line at memory carries its tiers, so the draft comes from the modal, not the till. List $42, tier $38, memory $45. Nothing is sent on any row.
      describe("a line the builder parked at its customer's memory", () => {
        const custB = { id: "c2", businessName: "Beta Bakery", pricingTier: 2 };
        const custC = { id: "c3", businessName: "Cedar Cafe", pricingTier: 2 };
        const columns = { pricePerUnit: "42", priceTier2: "38", priceTier3: "36" };
        const read = (
          data?: Record<string, { lastPrice: number; stickyPrice: number }>,
          isError = false,
        ) => ({
          data,
          isPending: false,
          isError,
        });
        const failed = read(undefined, true);
        const out = { data: undefined, isPending: true, isError: false };
        const memory = read({ p1: { lastPrice: 45, stickyPrice: 45 } });
        const memoryNow = read({ p1: { lastPrice: 50, stickyPrice: 50 } });
        const shows = (price: string) => screen.findByText(`$${price}.00 / each`);
        const note = (from: string, to: string) =>
          waitFor(() =>
            expect(screen.getByTestId("price-changed-note")).toHaveTextContent(
              `Price changed since you started ($${from}.00 → $${to}.00)`,
            ),
          );
        const noNote = () =>
          expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
        const refresh = (view: { rerender: (ui: React.ReactElement) => void }) =>
          view.rerender(<CreateOrderModal isOpen onClose={jest.fn()} />);
        const sendsNoPrice = async () => {
          post.mockResolvedValue({ data: { id: "o1" } });
          fireEvent.click(createBtn());
          await waitFor(() => expect(orderPosts()).toHaveLength(1));
          expect(bodyOf(0).items[0]).not.toHaveProperty("unitPrice");
        };

        async function parkLine(history: Record<string, unknown>) {
          mockCustomers = [{ ...customer, pricingTier: 2 }, custB, custC];
          mockHistory = history;
          mockProductNow = { p1: { id: "p1", ...columns } };
          mockResolveProductByCode.mockResolvedValue({
            ...product("p1"),
            product: { ...product("p1").product, ...columns },
          });
          const first = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
          fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
            target: { value: "Acm" },
          });
          fireEvent.click(await screen.findByText("Acme Foods"));
          capturedOnScan!("111");
          await screen.findByText("Widget p1");
          await waitForLocalCopy();
          const [rec] = await localRecords();
          first.unmount();
          return rec.payload as unknown as { lineItems: Record<string, unknown>[] };
        }

        async function parkLineAtMemory() {
          const payload = await parkLine(memory);
          expect(payload.lineItems[0]).toMatchObject({ unitPrice: 45, priceType: "MANUAL" });
          expect(payload.lineItems[0].prefillCustomerId).toBeUndefined(); // SA-1076: a memory is no link
          expect(payload.lineItems[0].tierPrices).toBeDefined();
          return payload;
        }

        it("T46: a failed history read keeps the line as parked, and it still sends no price", async () => {
          await parkLineAtMemory();
          mockHistory = failed;
          await resume();
          expect(await screen.findByTestId("prices-not-refreshed")).toBeInTheDocument();
          expect(await shows("45")).toBeInTheDocument();
          await sendsNoPrice();
        });

        it("T47: the line waits at its parked price for the history read", async () => {
          await parkLineAtMemory();
          mockHistory = out;
          const view = await resume();
          expect(productReads()).toHaveLength(0);
          expect(await shows("45")).toBeInTheDocument();

          mockHistory = memory;
          refresh(view);
          await waitFor(() => expect(productReads()).toHaveLength(1));
          await flush();
          noNote();
          expect(await shows("45")).toBeInTheDocument();
          await sendsNoPrice();
        });

        it("T48: a line added after a failed read leaves the parked line alone", async () => {
          await parkLineAtMemory();
          mockHistory = failed;
          mockLayerOn = true;
          await resume();
          expect(await screen.findByTestId("prices-not-refreshed")).toBeInTheDocument();
          mockResolveProductByCode.mockResolvedValue(product("p2"));
          capturedOnScan!("222");
          await screen.findByText("Widget p2");
          await flush();
          expect(screen.getByTestId("prices-not-refreshed")).toBeInTheDocument();
          expect(await shows("45")).toBeInTheDocument();
        });

        it("T49: a memory that moved writes the note when the reads land after the resume", async () => {
          await parkLineAtMemory();
          mockHistory = out;
          const view = await resume();
          mockHistory = memoryNow;
          refresh(view);
          await waitFor(() => expect(productReads()).toHaveLength(1));
          await flush();
          expect(await shows("50")).toBeInTheDocument();
          await note("45", "50");
          await sendsNoPrice();
        });

        it("T50: the same with the reads cached", async () => {
          await parkLineAtMemory();
          mockHistory = memoryNow;
          await resume();
          await waitFor(() => expect(productReads()).toHaveLength(1));
          await flush();
          expect(await shows("50")).toBeInTheDocument();
          await note("45", "50");
          await sendsNoPrice();
        });

        it("T51: no memory now, reads cached: tier, with the note", async () => {
          await parkLineAtMemory();
          mockHistory = read({});
          await resume();
          await waitFor(() => expect(productReads()).toHaveLength(1));
          await flush();
          expect(await shows("38")).toBeInTheDocument();
          await note("45", "38");
          await sendsNoPrice();
        });

        // SA-1076: a builder line has no link now, so it waits at its parked price. An old draft's link still drops to tier first.
        it.each([
          ["45", false],
          ["38", true],
        ])(
          "T52: a failed read, then a switch to B: B's reads re-price it, the note reads from $%s (old draft's link: %s), the notice clears",
          async (from, linked) => {
            const payload = await parkLineAtMemory();
            if (linked) {
              storage = createMemoryDraftStorage();
              setDraftMirrorStorage(storage);
              await seedParked({
                ...payload,
                lineItems: [{ ...payload.lineItems[0], prefillCustomerId: "c1" }],
              });
            }
            mockHistory = failed;
            const view = await resume();
            expect(await screen.findByTestId("prices-not-refreshed")).toBeInTheDocument();

            mockHistory = out;
            fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
            fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
              target: { value: "Bet" },
            });
            fireEvent.click(await screen.findByText("Beta Bakery"));
            await flush();
            mockHistory = memoryNow;
            refresh(view);
            await waitFor(() => expect(productReads()).toHaveLength(1));
            await flush();
            expect(await shows("50")).toBeInTheDocument();
            await note(from, "50");
            expect(screen.queryByTestId("prices-not-refreshed")).not.toBeInTheDocument();
            await sendsNoPrice();
          },
        );

        it("T53 guard: a line linked to another customer still drops to tier when this customer's read fails", async () => {
          const payload = await parkLineAtMemory();
          storage = createMemoryDraftStorage();
          setDraftMirrorStorage(storage);
          await seedParked({
            ...payload,
            lineItems: [{ ...payload.lineItems[0], prefillCustomerId: "c2" }],
          });
          mockHistory = failed;
          await resume();
          expect(await screen.findByTestId("prices-not-refreshed")).toBeInTheDocument();
          expect(await shows("38")).toBeInTheDocument();
          await sendsNoPrice();
        });

        it("M28 guard: the resume ends when its re-price runs, so a line added after it reads nothing", async () => {
          await parkLineAtMemory();
          await resume();
          await waitFor(() => expect(productReads()).toHaveLength(1));
          await flush();
          mockResolveProductByCode.mockResolvedValue(product("p2"));
          capturedOnScan!("222");
          await screen.findByText("Widget p2");
          await flush();
          expect(productReads()).toHaveLength(1);
        });

        // SA-1076 T26: scan_v2 on takes the default builder's path, so SA-1068's T55 flips on purpose.
        describe("T55, scan_v2 on, the same as off", () => {
          it("T46: a failed read keeps the line as parked and says so", async () => {
            await parkLineAtMemory();
            mockScanV2 = true;
            mockHistory = failed;
            await resume();
            expect(await screen.findByTestId("prices-not-refreshed")).toBeInTheDocument();
            expect(await shows("45")).toBeInTheDocument();
          });

          it("T47: the line waits at its parked price, then the read lands", async () => {
            await parkLineAtMemory();
            mockScanV2 = true;
            mockHistory = out;
            const view = await resume();
            expect(await shows("45")).toBeInTheDocument();
            mockHistory = memory;
            refresh(view);
            await waitFor(() => expect(productReads()).toHaveLength(1));
            await flush();
            expect(await shows("45")).toBeInTheDocument();
            noNote();
          });

          it("T49: a memory that moved writes the note", async () => {
            await parkLineAtMemory();
            mockScanV2 = true;
            mockHistory = out;
            const view = await resume();
            mockHistory = memoryNow;
            refresh(view);
            await waitFor(() => expect(productReads()).toHaveLength(1));
            await flush();
            expect(await shows("50")).toBeInTheDocument();
            await note("45", "50");
          });
        });

        // SA-1076 on real reads, as review-b walked them. The test client has no retry, so a rejection is where the app's read
        // ends after its one. The memory rows, T18 to T22, are T50, T46 and the like on a line with no link, in both modes.
        describe("SA-1076: a resume on real reads", () => {
          const planGate = { response: { status: 403, data: { code: "PLAN_GATE" } } };
          const memoryAt50 = () =>
            Promise.resolve({ data: { p1: { lastPrice: 50, stickyPrice: 50 } } });
          const offline = () => Promise.reject(new Error("Network Error"));
          const state = () => ({
            price: screen.getByText(/^\$\d+\.\d{2} \/ each$/).textContent,
            note:
              screen
                .queryByTestId("price-changed-note")
                ?.textContent?.match(/\$\S+ → \$\d+\.\d+/)?.[0] ?? null,
            notice: screen.queryByTestId("prices-not-refreshed") != null,
            productReads: productReads().length,
          });
          // flush first: a row whose start already reads as its end must not pass before the read lands
          const settlesAt = async (want: ReturnType<typeof state>) => {
            await flush();
            await waitFor(() => expect(state()).toEqual(want));
          };
          const realReads = (
            prices: typeof mockPricesAnswer,
            history: typeof mockHistoryAnswer,
          ) => {
            mockRealReads = true;
            mockPricesAnswer = prices;
            mockHistoryAnswer = history;
          };
          const atNotice = {
            price: "$45.00 / each",
            note: null,
            notice: true,
            productReads: 0,
          };
          const atNote = {
            price: "$50.00 / each",
            note: "$45.00 → $50.00",
            notice: false,
            productReads: 1,
          };
          const noRows = () => Promise.resolve({ data: [] });
          const remembers = (byCustomer: Record<string, number>) => (id: string) =>
            Promise.resolve({
              data:
                byCustomer[id] == null
                  ? {}
                  : { p1: { lastPrice: byCustomer[id], stickyPrice: byCustomer[id] } },
            });
          const changeToFirst = async (name: string) => {
            fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
              target: { value: name.slice(0, 3) },
            });
            fireEvent.click(await screen.findByText(name));
          };
          const changeTo = async (name: string) => {
            fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
            await changeToFirst(name);
          };
          const held = () => {
            let release!: (answer?: unknown) => void;
            const answer = new Promise<never>((r) => (release = r as typeof release));
            return { answer, release };
          };
          const holdProductRead = () => {
            const hold = held();
            mockProductHold = hold.answer as Promise<void>;
            return hold;
          };
          const productReadIsOut = () => waitFor(() => expect(productReads()).toHaveLength(1));

          describe.each([[false], [true]])("scan_v2 %s", (scanV2) => {
            const parked = async (history: Record<string, unknown>) => {
              const payload = await parkLine(history);
              mockScanV2 = scanV2;
              return payload;
            };

            it("T18: parked at $45, memory now $50: $50, with the note", async () => {
              await parked(memory);
              realReads(noRows, remembers({ c1: 50 }));
              await resume();
              await settlesAt(atNote);
            });

            it("T19: parked at $38, a product tier 3 row since: $36, with the note", async () => {
              await parked(read({}));
              realReads(
                () => Promise.resolve({ data: [{ productId: "p1", pricingTier: 3 }] }),
                remembers({}),
              );
              await resume();
              await settlesAt({ ...atNote, price: "$36.00 / each", note: "$38.00 → $36.00" });
            });

            it("T20: parked at memory, the history read fails: as parked, under the notice", async () => {
              await parked(memory);
              realReads(noRows, offline);
              await resume();
              await settlesAt(atNotice);
            });

            it("T21: T18, then a switch to C: C's price, the note reads from the parked price", async () => {
              await parked(memory);
              realReads(noRows, remembers({ c1: 50 }));
              await resume();
              await settlesAt(atNote);
              await changeTo("Cedar Cafe");
              await settlesAt({ ...atNote, price: "$38.00 / each", note: "$45.00 → $38.00" });
            });

            it("T22 guard: an old draft's memory line carrying a link", async () => {
              const payload = await parked(memory);
              storage = createMemoryDraftStorage();
              setDraftMirrorStorage(storage);
              await seedParked({
                ...payload,
                lineItems: [{ ...payload.lineItems[0], prefillCustomerId: "c1" }],
              });
              realReads(noRows, remembers({ c1: 45 }));
              await resume();
              await settlesAt({ ...atNote, price: "$45.00 / each", note: null });
            });

            it("T27 guard: the history read fails, a switch to C finishes the resume", async () => {
              await parked(memory);
              realReads(noRows, (id) => (id === "c1" ? offline() : remembers({})(id)));
              await resume();
              await settlesAt(atNotice);
              await changeTo("Cedar Cafe");
              await settlesAt({ ...atNote, price: "$38.00 / each", note: "$45.00 → $38.00" });
            });

            it("T28 guard: the history read fails at A and at the next customer: as parked, the notice stays", async () => {
              await parked(memory);
              realReads(noRows, offline);
              await resume();
              await settlesAt(atNotice);
              await changeTo("Cedar Cafe");
              await flush();
              await settlesAt(atNotice);
            });

            it("T29 guard: a history refetch that recovers finishes the resume", async () => {
              await parked(memory);
              realReads(noRows, offline);
              const view = await resume();
              await settlesAt(atNotice);

              const hold = held();
              mockHistoryAnswer = () => hold.answer;
              await act(async () => {
                void view.queryClient.invalidateQueries({ queryKey: ["orders", "price-history"] });
              });
              await flush();
              hold.release(await remembers({ c1: 50 })("c1"));
              await settlesAt(atNote);
            });

            it("T30: the product read is out, a switch to C, it lands: C's price, no note", async () => {
              await parked(memory);
              realReads(noRows, remembers({ c1: 50 }));
              const hold = holdProductRead();
              await resume();
              await productReadIsOut();
              await changeTo("Cedar Cafe");
              await flush();
              hold.release();
              await settlesAt({ ...atNote, price: "$38.00 / each", note: null });
            });

            it("T30: the same on a tier line, A to B: B's memory, no note", async () => {
              await parked(read({}));
              realReads(noRows, remembers({ c1: 45, c2: 50 }));
              const hold = holdProductRead();
              await resume();
              await productReadIsOut();
              await changeTo("Beta Bakery");
              await flush();
              hold.release();
              await settlesAt({ ...atNote, note: null });
            });

            it("T31 guard: the product read is out, chip x, it lands, Undo: no false note", async () => {
              await parked(memory);
              realReads(noRows, remembers({ c1: 50 }));
              const hold = holdProductRead();
              await resume();
              await productReadIsOut();
              fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
              await shows("42");
              hold.release();
              await flush();
              fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
              await settlesAt({ ...atNote, note: null });
            });

            it("T32 guard: a draft parked with no customer, pick A: A's price, with the note", async () => {
              const payload = await parked(read({}));
              mockLoadedDraft = {
                id: "d1",
                kind: "ORDER",
                updatedAt: "2026-10-19T10:00:00.000Z",
                payload: {
                  ...payload,
                  customer: null,
                  lineItems: [{ ...payload.lineItems[0], unitPrice: 42 }],
                },
              };
              storage = createMemoryDraftStorage();
              setDraftMirrorStorage(storage);
              realReads(noRows, remembers({ c1: 45 }));
              renderWithProviders(
                <CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />,
              );
              await screen.findByText("Widget p1");
              await changeToFirst("Acme Foods");
              await settlesAt({ ...atNote, price: "$45.00 / each", note: "$42.00 → $45.00" });
            });

            it("T33 guard: the memory moved, every product read fails: as parked, under the notice", async () => {
              await parked(memory);
              mockProductNow = null;
              realReads(noRows, remembers({ c1: 50 }));
              await resume();
              await settlesAt({ ...atNotice, productReads: 1 });
            });

            it("T34: T30 with the catalog tier now $40: the new price, with the note", async () => {
              await parked(memory);
              mockProductNow = { p1: { id: "p1", ...columns, priceTier2: "40" } };
              realReads(noRows, remembers({ c1: 50 }));
              const hold = holdProductRead();
              await resume();
              await productReadIsOut();
              await changeTo("Cedar Cafe");
              await flush();
              hold.release();
              await settlesAt({ ...atNote, price: "$40.00 / each", note: "$38.00 → $40.00" });
            });

            it("T35: the product read lands before C's reads do: C's price, no note", async () => {
              await parked(memory);
              realReads(noRows, remembers({ c1: 50 }));
              const hold = holdProductRead();
              await resume();
              await productReadIsOut();
              const history = held();
              mockHistoryAnswer = () => history.answer;
              await changeTo("Cedar Cafe");
              await flush();
              hold.release();
              await flush();
              history.release(await remembers({})("c3"));
              await settlesAt({ ...atNote, price: "$38.00 / each", note: null });
            });
          });

          it("T38: a PLAN_GATE 403 is an empty read, so the resume runs and writes the note", async () => {
            await parkLineAtMemory();
            realReads(() => Promise.reject(planGate), memoryAt50);
            await resume();
            await settlesAt(atNote);
          });

          it("T39: PLAN_GATE 403, no memory, the catalog moved: the new price, with the note", async () => {
            await parkLine(read({}));
            mockProductNow = { p1: { id: "p1", ...columns, priceTier2: "40" } };
            realReads(
              () => Promise.reject(planGate),
              () => Promise.resolve({ data: {} }),
            );
            await resume();
            await settlesAt({
              price: "$40.00 / each",
              note: "$38.00 → $40.00",
              notice: false,
              productReads: 1,
            });
          });

          it("T36: a failed read keeps the parked price and says so", async () => {
            await parkLineAtMemory();
            realReads(offline, memoryAt50);
            await resume();
            await settlesAt(atNotice);
          });

          it("T37: fails on A and on B, B's memory lands: the notice stays up over a line linked to A", async () => {
            const payload = await parkLineAtMemory();
            storage = createMemoryDraftStorage();
            setDraftMirrorStorage(storage);
            await seedParked({
              ...payload,
              lineItems: [{ ...payload.lineItems[0], prefillCustomerId: "c1" }],
            });
            realReads(offline, memoryAt50);
            await resume();
            await settlesAt(atNotice);

            fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
            fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
              target: { value: "Bet" },
            });
            fireEvent.click(await screen.findByText("Beta Bakery"));
            await flush();
            await settlesAt({ ...atNotice, price: "$38.00 / each" });
          });

          it("T37: the same on a plain line: it waits at its parked price under the notice", async () => {
            await parkLineAtMemory();
            realReads(offline, memoryAt50);
            await resume();
            await settlesAt(atNotice);

            await changeTo("Beta Bakery");
            await flush();
            await settlesAt(atNotice);
          });

          it("T40 guard: a refetch that recovers finishes the resume and clears the notice", async () => {
            await parkLineAtMemory();
            realReads(offline, memoryAt50);
            const view = await resume();
            await settlesAt(atNotice);

            let land!: (answer: unknown) => void;
            mockPricesAnswer = () => new Promise((r) => (land = r));
            await act(async () => {
              void view.queryClient.invalidateQueries({ queryKey: ["customer-prices", "c1"] });
            });
            await flush();
            land({ data: [] });
            await settlesAt(atNote);
          });

          describe("T41 guard, scan_v2 on", () => {
            it("T36: a failed read keeps the parked price and says so", async () => {
              await parkLineAtMemory();
              mockScanV2 = true;
              realReads(offline, memoryAt50);
              await resume();
              await settlesAt(atNotice);
            });

            it("T38: a PLAN_GATE 403 is an empty read", async () => {
              await parkLineAtMemory();
              mockScanV2 = true;
              realReads(() => Promise.reject(planGate), memoryAt50);
              await resume();
              await settlesAt(atNote);
            });
          });

          it("T42 guard: a failed layer read shows the layer's copy only, one notice", async () => {
            await parkLineAtMemory();
            mockLayerFailed = true;
            realReads(() => Promise.resolve({ data: [] }), memoryAt50);
            await resume();
            await flush();
            expect(screen.getByTestId("order-price-layer-failed")).toBeInTheDocument();
            expect(screen.queryByTestId("prices-not-refreshed")).not.toBeInTheDocument();
          });
        });
      });

      // SA-1072 A-1: a tier above Retail is the tier, not a memory. List $12, tier $14, the newest row SPECIAL, so
      // `stickyPrice` is null however high `lastPrice` reads.
      describe("a line on a tier above Retail, newest row SPECIAL", () => {
        const aboveRetail = { ...customer, pricingTier: 2 };
        const parkedAtTier = () =>
          counterCartToDraftPayload(
            [{ ...tillLine, unitPrice: 14, priceType: "SPECIAL" as const }],
            aboveRetail,
          );
        const savedLine = async () => {
          const [rec] = await localRecords();
          return (rec.payload as unknown as { lineItems: Record<string, unknown>[] }).lineItems[0];
        };

        describe.each([
          ["B20, the builder", false],
          ["B21, scan_v2", true],
        ])("%s", (_, scanV2) => {
          beforeEach(() => {
            mockScanV2 = scanV2;
            mockProductNow = { p1: { id: "p1", pricePerUnit: "12", priceTier2: "14" } };
          });

          it.each([
            ["at today's tier", 14],
            ["at an older tier", 13],
          ])(
            "newest row %s: the line takes the tier, no note, no price sent",
            async (_row, last) => {
              mockHistory = {
                data: { p1: { lastPrice: last, stickyPrice: null } },
                isPending: false,
                isError: false,
              };
              await seedParked(parkedAtTier());
              await resume();
              await waitFor(() => expect(productReads()).toHaveLength(1));
              await flush();
              expect(screen.getByText("$14.00 / each")).toBeInTheDocument();
              expect(screen.queryByTestId("price-changed-note")).not.toBeInTheDocument();
              await waitFor(async () =>
                expect(await savedLine()).toMatchObject({ unitPrice: 14, priceType: "SPECIAL" }),
              );

              post.mockResolvedValue({ data: { id: "o1" } });
              fireEvent.click(createBtn());
              await waitFor(() => expect(orderPosts()).toHaveLength(1));
              expect(bodyOf(0).items[0]).not.toHaveProperty("unitPrice");
            },
          );
        });
      });
    });

    it("A6: a resumed draft keeps its own submit key", async () => {
      mockProductNow = {
        p1: { id: "p1", pricePerUnit: "10" },
        p2: { id: "p2", pricePerUnit: "12" },
      };
      await seedParked();
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await screen.findByText("Resume your unsent order?");
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await screen.findByText("Widget p1");
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
      expect(keyOf(0)).toBe("K-PARKED");
    });
  });

  describe("A6 - the same persisted key after a reload", () => {
    it("A6: submit, the response is lost, reload, resume, submit again: the SAME Idempotency-Key", async () => {
      post
        .mockRejectedValueOnce(new Error("Network Error")) // the response is lost: outcome unknown
        .mockResolvedValue({ data: { id: "o1" } });
      const first = renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      await waitForLocalCopy();
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
      await flush();
      const firstKey = keyOf(0);
      expect(firstKey).toEqual(expect.any(String));
      // the key is in the local copy, next to the cart it belongs to
      const [rec] = await localRecords();
      expect(readDraftSubmitKey(rec.payload)).toBe(firstKey);
      first.unmount(); // reload

      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await screen.findByText("Resume your unsent order?");
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await screen.findByText("Widget p1");
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(2));
      expect(keyOf(1)).toBe(firstKey);
    });

    it("A6: once the order exists the local copy is gone and the bound server draft is deleted", async () => {
      mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      fireEvent.click(createBtn());
      await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith("d1"));
      expect(await localRecords()).toEqual([]);
    });

    it("A6: resuming a docked server draft replays the key stored in it", async () => {
      mockLoadedDraft = {
        id: "d1",
        kind: "ORDER",
        updatedAt: "2026-10-19T10:00:00.000Z",
        payload: {
          customer: { id: "c1", businessName: "Acme Foods", pricingTier: 1 },
          lineItems: [
            {
              tempId: "t1",
              productId: "p1",
              productName: "Widget p1",
              unit: "each",
              listPrice: 9.99,
              unitPrice: 9.99,
              priceType: "STANDARD",
              qty: 1,
            },
          ],
          orderDiscount: "",
          shippingFee: "",
          requestedDeliveryDate: "",
          orderDate: "",
          notes: "",
          urgent: false,
          floorAcked: [],
          _submitKey: "K-FROM-SERVER",
        },
      };
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />);
      await screen.findByText("Widget p1");
      await waitFor(() => expect(createBtn()).not.toBeDisabled()); // the fulfilment settings are still loading
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1));
      expect(keyOf(0)).toBe("K-FROM-SERVER");
    });
  });

  describe("A4 - another device changed the draft", () => {
    it("A4: a 409 DRAFT_CHANGED asks 'Keep this one or open the other?'; keeping this one saves it as its own draft with a new key", async () => {
      mockCreateDraft
        .mockResolvedValueOnce({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" })
        .mockResolvedValueOnce({ id: "d2", updatedAt: "2026-10-19T10:00:09.000Z" });
      mockUpdateDraft.mockRejectedValue({
        response: {
          status: 409,
          data: {
            code: "DRAFT_CHANGED",
            current: {
              id: "d1",
              updatedAt: "2026-10-19T10:00:07.000Z",
              payload: { customer: { id: "c1", businessName: "Acme Foods" }, lineItems: [] },
            },
          },
        },
      });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      mockResolveProductByCode.mockResolvedValue(product("p2"));
      capturedOnScan!("222");
      await screen.findByText("Widget p2");

      expect(
        await screen.findByText(
          "This order was changed on another device. Keep this one or open the other?",
          {},
          { timeout: 5000 },
        ),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));

      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(2));
      const [first, second] = mockCreateDraft.mock.calls.map((c) => c[0].payload);
      expect(second.lineItems).toHaveLength(2);
      expect(second._submitKey).not.toBe(first._submitKey);
      expect(mockUpdateDraft).toHaveBeenCalledTimes(1); // the other device's draft was never overwritten
    });
  });

  describe("A6 under conflict - the key of a submit with an unknown outcome is never dropped", () => {
    const theirs = {
      id: "d1",
      updatedAt: "2026-10-19T10:00:07.000Z",
      customerId: "c1",
      customerName: "Acme Foods",
      title: "Order, Acme Foods",
      payload: {
        customer: { id: "c1", businessName: "Acme Foods" },
        lineItems: [
          {
            tempId: "tx",
            productId: "px",
            productName: "Widget from device B",
            unit: "each",
            listPrice: 5,
            unitPrice: 5,
            priceType: "STANDARD",
            qty: 1,
          },
        ],
        from: "device-b",
        _submitKey: "K-ORIGINAL",
      },
    };
    const conflict409 = () => ({
      response: { status: 409, data: { code: "DRAFT_CHANGED", current: theirs } },
    });
    const timeout = () => new Error("timeout of 30000ms exceeded");
    let onClose: jest.Mock;
    beforeEach(() => {
      onClose = jest.fn();
    });

    /**
     * K1 is sent and its outcome is unknown. The cart is still unsynced (the draft PATCHes failed offline), so when the browser
     * comes back online the PATCH meets the other device's change. `editAfter` changes the cart in between.
     */
    async function submitLostThenConflict(editAfter: boolean) {
      mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
      mockUpdateDraft.mockRejectedValue(new Error("Network Error"));
      renderWithProviders(<CreateOrderModal isOpen onClose={onClose} />);
      await pickCustomerAndScan();
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      mockResolveProductByCode.mockResolvedValue(product("p2"));
      capturedOnScan!("222");
      await screen.findByText("Widget p2");
      await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1), { timeout: 6000 });
      await waitFor(() => expect(createBtn()).not.toBeDisabled());
      if (editAfter) {
        mockResolveProductByCode.mockResolvedValue(product("p3"));
        capturedOnScan!("333");
        await screen.findByText("Widget p3");
      }
      mockUpdateDraft.mockReset();
      mockUpdateDraft
        .mockRejectedValueOnce(conflict409())
        .mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:09.000Z" });
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
    }
    const conflictCopy =
      "This order was changed on another device. Keep this one or open the other?";

    it("A6: K1 times out (the order may be committed), the draft conflicts, the cart is the one that was sent: replayed with the ORIGINAL key first - one order, no dialog", async () => {
      post.mockRejectedValueOnce(timeout()).mockResolvedValue({ data: { id: "o1" } });
      await submitLostThenConflict(false);

      await waitFor(() => expect(orderPosts()).toHaveLength(2), { timeout: 6000 });
      expect(keyOf(1)).toBe(keyOf(0));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(screen.queryByText(conflictCopy)).not.toBeInTheDocument();
    });

    it("A6: the cart CHANGED since the unknown submit: NO replay (K1 may never have reached the server), the dialog opens at once", async () => {
      post.mockRejectedValueOnce(timeout()).mockResolvedValue({ data: { id: "o1" } });
      await submitLostThenConflict(true);

      expect(await screen.findByText(conflictCopy, {}, { timeout: 6000 })).toBeInTheDocument();
      expect(orderPosts()).toHaveLength(1); // nothing was sent for the unconfirmed edit
    });

    it("A6: the replay is also lost, so the dialog opens; Keep this one keeps the SAME draft and the SAME key, and the other device's version is parked", async () => {
      post
        .mockRejectedValueOnce(timeout())
        .mockRejectedValueOnce(timeout())
        .mockResolvedValue({ data: { id: "o1" } });
      await submitLostThenConflict(false);

      await waitFor(() => expect(orderPosts()).toHaveLength(2), { timeout: 6000 });
      fireEvent.click(await screen.findByRole("button", { name: "Keep this one" }));

      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(2));
      const k1 = keyOf(0);
      // the other device's version is parked with a key of its own...
      const parked = mockCreateDraft.mock.calls[1][0].payload;
      expect(parked.from).toBe("device-b");
      expect(parked._submitKey).not.toBe(k1);
      // ...and ours is written back over the SAME draft, with K1, checked against THEIR updatedAt
      await waitFor(() => expect(mockUpdateDraft.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(mockUpdateDraft.mock.calls[1][0]).toMatchObject({
        id: "d1",
        expectedUpdatedAt: theirs.updatedAt,
      });
      expect(mockUpdateDraft.mock.calls[1][0].payload._submitKey).toBe(k1);

      // submitting after Keep this one still sends K1: exactly one order
      await waitFor(() => expect(createBtn()).not.toBeDisabled());
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(3), { timeout: 6000 });
      expect(keyOf(2)).toBe(k1);
      expect(keyOf(1)).toBe(k1);
    });

    it("A6: 'Open the other' with a maybe-used K1 mirrors Keep this one: this version stays on the ORIGINAL draft with K1, the other version is parked and opened; submitting this copy later sends K1 (one order)", async () => {
      post.mockRejectedValueOnce(timeout()).mockResolvedValue({ data: { id: "o1" } });
      await submitLostThenConflict(true); // cart changed: no replay, dialog at once
      const k1 = keyOf(0);
      mockCreateDraft.mockResolvedValueOnce({ id: "d2", updatedAt: "2026-10-19T10:00:11.000Z" });

      fireEvent.click(
        await screen.findByRole("button", { name: "Open the other" }, { timeout: 6000 }),
      );

      // the other device's version is parked as the NEW draft, with a fresh key, and is what the editor now shows
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(2));
      const parked = mockCreateDraft.mock.calls[1][0].payload;
      expect(parked.from).toBe("device-b");
      expect(parked._submitKey).not.toBe(k1);
      expect(await screen.findByText("Widget from device B")).toBeInTheDocument();
      // this device's version was written over the ORIGINAL draft d1 with K1, checked against THEIR updatedAt
      const written = mockUpdateDraft.mock.calls[1][0];
      expect(written).toMatchObject({ id: "d1", expectedUpdatedAt: theirs.updatedAt });
      expect(written.payload._submitKey).toBe(k1);
      expect(written.payload.lineItems).toHaveLength(3);

      // later: this device's copy is resumed from d1 and submitted - K1 again, so exactly one order
      cleanup();
      mockLoadedDraft = {
        id: "d1",
        kind: "ORDER",
        updatedAt: "2026-10-19T10:00:09.000Z",
        payload: written.payload,
      };
      renderWithProviders(<CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />);
      await screen.findByText("Widget p3");
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(2), { timeout: 6000 });
      expect(keyOf(1)).toBe(k1);
    });
  });

  describe("review SHOULDs and NITs", () => {
    const serverLine = {
      tempId: "t1",
      productId: "p1",
      productName: "Widget p1",
      unit: "each",
      listPrice: 9.99,
      unitPrice: 9.99,
      priceType: "STANDARD",
      qty: 1,
    };
    const serverPayload = (extra: Record<string, unknown> = {}) => ({
      customer: { id: "c1", businessName: "Acme Foods", pricingTier: 1 },
      lineItems: [serverLine],
      orderDiscount: "",
      shippingFee: "",
      requestedDeliveryDate: "",
      orderDate: "",
      notes: "",
      urgent: false,
      floorAcked: [],
      ...extra,
    });

    async function seedLocal(localId: string, serverDraftId: string | null, payload: unknown) {
      const { createDraftMirror } = await import("@/lib/order-draft/mirror");
      const m = createDraftMirror({ storage, tenantId: "t1", userId: "u1" });
      m.write({
        localId,
        serverDraftId,
        serverUpdatedAt: serverDraftId ? "2026-10-19T10:00:00.000Z" : null,
        syncedHash: null,
        customerId: "c1",
        customerName: "Acme Foods",
        payload: payload as never,
      });
      await m.flush();
    }

    it("dock resume checks the mirror: a newer local copy bound to THAT draft is offered, and resuming it shows the local lines", async () => {
      const server = {
        id: "d1",
        kind: "ORDER",
        updatedAt: "2026-10-19T10:00:00.000Z",
        payload: serverPayload({ _submitKey: "K-SRV" }),
      };
      mockLoadedDraft = server;
      mockServerDrafts = [server];
      const ahead = serverPayload({
        _submitKey: "K-SRV",
        lineItems: [
          serverLine,
          { ...serverLine, tempId: "t2", productId: "p2", productName: "Widget p2" },
        ],
      });
      await seedLocal("d1", "d1", ahead);
      renderWithProviders(<CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />);
      await screen.findByText("Widget p1");
      expect(await screen.findByText("Resume your unsent order?")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      expect(await screen.findByText("Widget p2")).toBeInTheDocument();
    });

    it("dock resume does NOT offer a local copy bound to a different draft", async () => {
      const server = {
        id: "d1",
        kind: "ORDER",
        updatedAt: "2026-10-19T10:00:00.000Z",
        payload: serverPayload({ _submitKey: "K-SRV" }),
      };
      mockLoadedDraft = server;
      mockServerDrafts = [server];
      await seedLocal("other", "d-other", serverPayload({ _submitKey: "K-OTHER" }));
      renderWithProviders(<CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />);
      await screen.findByText("Widget p1");
      await flush();
      expect(screen.queryByText("Resume your unsent order?")).not.toBeInTheDocument();
    });

    it("the local copy is keyed by the server draft id once one is bound", async () => {
      mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
      mockUpdateDraft.mockImplementation(() => NEVER()); // the next edit stays unsynced
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      mockResolveProductByCode.mockResolvedValue(product("p2"));
      capturedOnScan!("222");
      await screen.findByText("Widget p2");
      await waitFor(
        async () => expect((await localRecords()).map((r) => r.localId)).toEqual(["d1"]),
        {
          timeout: 4000,
        },
      );
    });

    it("A6: the local copy with the key is written BEFORE the order POST (the key is durable before it is sent)", async () => {
      let seenAtPost: Array<{ payload: Record<string, unknown> }> = [];
      post.mockImplementation(async () => {
        seenAtPost = await localRecords();
        return { data: { id: "o1" } };
      });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      fireEvent.click(createBtn()); // straight away: inside the 300 ms mirror debounce and the 900 ms server debounce
      await waitFor(() => expect(orderPosts()).toHaveLength(1), { timeout: 6000 });
      expect(seenAtPost).toHaveLength(1);
      expect(seenAtPost[0].payload._submitKey).toBe(keyOf(0));
    });

    it("a key-less server draft resumed: the local copy is kept until the server has the key, and the key is PATCHed in", async () => {
      mockLoadedDraft = {
        id: "d1",
        kind: "ORDER",
        updatedAt: "2026-10-19T10:00:00.000Z",
        payload: serverPayload(), // no _submitKey
      };
      renderWithProviders(<CreateOrderModal isOpen resumeDraftId="d1" onClose={jest.fn()} />);
      await screen.findByText("Widget p1");
      await waitFor(async () => expect(await localRecords()).toHaveLength(1), { timeout: 4000 });
      expect((await localRecords())[0].payload._submitKey).toEqual(expect.any(String));
      await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(mockUpdateDraft.mock.calls[0][0]).toMatchObject({
        id: "d1",
        expectedUpdatedAt: "2026-10-19T10:00:00.000Z",
      });
      expect(mockUpdateDraft.mock.calls[0][0].payload._submitKey).toEqual(expect.any(String));
    });

    it("a held-order 409 opens that order AND finishes the bound draft (no zombie draft)", async () => {
      mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
      post.mockRejectedValue({
        response: { status: 409, data: { code: "IDEMPOTENCY_KEY_CONFLICT", orderId: "ord-77" } },
      });
      const onViewOrder = jest.fn();
      renderWithProviders(
        <CreateOrderModal isOpen onClose={jest.fn()} onViewOrder={onViewOrder} />,
      );
      await pickCustomerAndScan();
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      fireEvent.click(createBtn());
      await waitFor(() => expect(onViewOrder).toHaveBeenCalledWith("ord-77"), { timeout: 6000 });
      await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalledWith("d1"));
      expect(await localRecords()).toEqual([]);
    });

    it("A3: when the browser comes back online the real 'online' listener flushes exactly one PATCH with the latest state", async () => {
      mockCreateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:00.000Z" });
      mockUpdateDraft.mockRejectedValue(new Error("Network Error")); // offline
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      mockResolveProductByCode.mockResolvedValue(product("p2"));
      capturedOnScan!("222");
      await screen.findByText("Widget p2");
      await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalledTimes(1), { timeout: 4000 });
      await waitFor(async () => expect(await localRecords()).toHaveLength(1)); // the mirror is current

      mockUpdateDraft.mockClear();
      mockUpdateDraft.mockResolvedValue({ id: "d1", updatedAt: "2026-10-19T10:00:09.000Z" });
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      await waitFor(() => expect(mockUpdateDraft).toHaveBeenCalledTimes(1));
      expect(mockUpdateDraft.mock.calls[0][0].payload.lineItems).toHaveLength(2);
      expect(mockUpdateDraft.mock.calls[0][0].expectedUpdatedAt).toBe("2026-10-19T10:00:00.000Z");
      await waitFor(async () => expect(await localRecords()).toEqual([]));
    });

    it("a hung local store (IndexedDB stalls) cannot hold the order back: the POST still goes within the budget", async () => {
      const hung = createMemoryDraftStorage();
      setDraftMirrorStorage({
        ...hung,
        put: () => new Promise<void>(() => undefined), // never resolves
        get: hung.get,
        delete: hung.delete,
        list: hung.list,
      });
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1), { timeout: 6000 });
    });

    it("a double click during the durable-save wait sends ONE POST", async () => {
      // the server draft never answers, so the submit waits out its budget before sending
      post.mockResolvedValue({ data: { id: "o1" } });
      renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
      await pickCustomerAndScan();
      fireEvent.click(createBtn());
      fireEvent.click(createBtn());
      await waitFor(() => expect(orderPosts()).toHaveLength(1), { timeout: 6000 });
      await flush();
      expect(orderPosts()).toHaveLength(1);
    });
  });
});
