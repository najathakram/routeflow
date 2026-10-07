import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";

// #2406 — CreateOrderModal host: the Returns section, and the returnKey/refusal lifecycle
// around a create-order save that carries an inline return. Modeled on CreateOrderModal.test.tsx
// (same mock set) and RecordInlineReturnDialog.test.tsx (the InlineReturnSection mocks).
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const createOrderMutate = jest.fn();
let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
  useCustomer: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  // Backs BOTH the modal's own product search (unused by these tests) and
  // InlineReturnSection's "Add another product" search.
  useProducts: () => ({
    data: { data: [{ id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null }] },
  }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  useCreateOrder: () => ({
    mutate: createOrderMutate,
    isPending: false,
    error: null,
    reset: jest.fn(),
  }),
  useActiveOrderForCustomer: () => ({ data: mockActiveOrder }),
  useCustomerPriceHistory: () => ({ data: undefined }),
  // InlineReturnSection's own entryOrderId hydration — CreateOrderModal never passes one, so
  // this is always called with "".
  useOrder: () => ({ data: undefined }),
}));
let mockActiveOrder: unknown = undefined;
const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
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
let hasInlineReturns = true;
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => hasInlineReturns }));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: (props: { title?: string }) => (
    <button type="button" aria-label={props.title}>
      {props.title}
    </button>
  ),
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useScanV2: () => false,
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
jest.mock("@/lib/barcode-resolve", () => ({ resolveProductByCode: jest.fn() }));
jest.mock("@/lib/refocus-scanner", () => ({
  scheduleScannerRefocus: jest.fn(),
  isTextEntryActive: () => false,
}));

const acme = { id: "c1", businessName: "Acme Foods", pricingTier: 1 };

async function pickCustomer() {
  fireEvent.change(screen.getByPlaceholderText("Search by business name…"), {
    target: { value: "Acm" },
  });
  fireEvent.click(await screen.findByText("Acme Foods"));
}

async function openReturnsAndAddLine(pieces: string) {
  fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByText("Widget"));
  fireEvent.change(screen.getByLabelText(/qty \(pieces\)/i), { target: { value: pieces } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
}

async function quoteIt() {
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  await waitFor(() => expect(quoteMutate).toHaveBeenCalled());
  act(() => {
    quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess({
      chunks: [],
      subtotal: 0,
      taxAmount: 0,
      categoryTax: 0,
      total: 0,
      productBreakdown: {},
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveOrder = undefined;
  mockCustomers = [acme];
  hasInlineReturns = true;
});

describe("CreateOrderModal — Returns section gate (#2406)", () => {
  it("addon off ⇒ no Returns section", async () => {
    hasInlineReturns = false;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    expect(screen.queryByRole("button", { name: /^returns$/i })).not.toBeInTheDocument();
  });

  it("addon on ⇒ collapsed Returns section is available for the selected customer", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    expect(screen.getByRole("button", { name: /^returns$/i })).toBeInTheDocument();
  });
});

describe("CreateOrderModal — inline return payload on save (#2406)", () => {
  it("a quoted return is carried as inlineReturn with items + returnKey and WITHOUT customerId/orderId", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() => {
      quoteMutate.mock.calls[0][1].onSuccess({
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    const dto = createOrderMutate.mock.calls[0][0];
    expect(dto.inlineReturn).toBeDefined();
    expect(dto.inlineReturn.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }]);
    expect(dto.inlineReturn.reason).toBe("DAMAGED");
    expect(typeof dto.inlineReturn.returnKey).toBe("string");
    expect(dto.inlineReturn.returnKey.length).toBeGreaterThan(0);
    expect(dto.inlineReturn).not.toHaveProperty("customerId");
    expect(dto.inlineReturn).not.toHaveProperty("orderId");
  });

  it("a retry after a network error resends the SAME returnKey", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() => {
      quoteMutate.mock.calls[0][1].onSuccess({
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const firstKey = createOrderMutate.mock.calls[0][0].inlineReturn.returnKey;

    // A network failure (5xx / no clean business refusal) is a RETRY of the same attempt —
    // never a 4xx, so no fresh key is minted (mirrors the standalone dialog's own AC4: only
    // an actual server REFUSAL, a 4xx, starts a new attempt).
    createOrderMutate.mock.calls[0][1].onError({
      response: { status: 500, data: { message: "Network error" } },
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(2);
    const secondKey = createOrderMutate.mock.calls[1][0].inlineReturn.returnKey;
    expect(secondKey).toBe(firstKey);
    // SA-484a: the create's Idempotency-Key rides with it — present, distinct, and the SAME on
    // the retry, so the server replays the attempt instead of minting a second order + return.
    const [idem1, idem2] = [0, 1].map((i) => createOrderMutate.mock.calls[i][0].idempotencyKey);
    expect(typeof idem1).toBe("string");
    expect(idem1).not.toBe(firstKey);
    expect(idem2).toBe(idem1);
    expect(createOrderMutate.mock.calls[0][0].inlineReturn).not.toHaveProperty("idempotencyKey");
  });

  it("after a 4xx refusal, the next submit mints a NEW returnKey", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() => {
      quoteMutate.mock.calls[0][1].onSuccess({
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const firstKey = createOrderMutate.mock.calls[0][0].inlineReturn.returnKey;
    createOrderMutate.mock.calls[0][1].onError({
      response: { status: 409, data: { message: "returnKey already used" } },
    });
    await screen.findByText("returnKey already used");

    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const secondKey = createOrderMutate.mock.calls[1][0].inlineReturn.returnKey;
    expect(secondKey).not.toBe(firstKey);
    // SA-484a: a new attempt mints BOTH keys fresh.
    expect(createOrderMutate.mock.calls[1][0].idempotencyKey).not.toBe(
      createOrderMutate.mock.calls[0][0].idempotencyKey,
    );
  });

  // #2647: the order-level key-reused 409 (the earlier return WAS recorded): link it and clear
  // the draft, so the same goods are not re-entered as a "new" return and credited twice.
  it("#2647: a key-reused 409 links the recorded return and clears the return draft", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() => {
      quoteMutate.mock.calls[0][1].onSuccess({
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    act(() =>
      createOrderMutate.mock.calls[0][1].onError({
        response: {
          status: 409,
          data: {
            code: "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
            returnId: "ret-9",
            returnNumber: "RET-2026-0042",
            message:
              "Return RET-2026-0042 was already recorded with this capture key, with different items.",
          },
        },
      }),
    );

    const link = await screen.findByTestId("order-return-recorded-link");
    expect(link).toHaveTextContent("Open RET-2026-0042");
    expect(link).toHaveAttribute("href", "/returns/ret-9");
    // the draft is gone: the next save carries no inline return
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[1][0].inlineReturn).toBeUndefined();
  });
});

// Lead fold on #2601: SAVE captures only the return the operator can SEE. Collapsing a section
// with lines entered asks to discard; a discarded (or collapsed) return never rides the save.
describe("CreateOrderModal — collapsing the Returns section (#2406)", () => {
  it("collapse with lines asks first; Keep editing keeps the lines and they are saved", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/discard this return/i);
    fireEvent.click(screen.getByRole("button", { name: /keep editing/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/qty \(pieces\)/i)).toHaveValue(5);
    await quoteIt();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[0][0].inlineReturn).toBeDefined();
  });

  it("Discard return collapses, clears, and the save carries NO inlineReturn", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    fireEvent.click(screen.getByRole("button", { name: /discard return/i }));
    expect(screen.queryByLabelText(/qty \(pieces\)/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).not.toHaveProperty("inlineReturn");
    // BUG-A: every create carries its attempt key now (no inlineReturn => the modal's own key).
    expect(createOrderMutate.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String));
    // Re-opening starts empty — nothing from the discarded draft survives.
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    expect(screen.queryByLabelText(/qty \(pieces\)/i)).not.toBeInTheDocument();
  });

  // SA-484i: the return rides the save ONLY when the section is expanded AND quoted.
  it("never expanded ⇒ the save carries no inlineReturn", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[0][0]).not.toHaveProperty("inlineReturn");
  });

  it("expanded but NOT quoted ⇒ the save is blocked (nothing sent)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).not.toHaveBeenCalled();
  });

  it("expanded → quoted → discarded ⇒ no inlineReturn, and re-expanding shows an empty section", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    await quoteIt();
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    fireEvent.click(screen.getByRole("button", { name: /discard return/i }));
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[0][0]).not.toHaveProperty("inlineReturn");
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    expect(screen.queryByLabelText(/qty \(pieces\)/i)).not.toBeInTheDocument();
  });

  it("a discard after an UNKNOWN outcome: a fresh returnKey, but the attempt key is KEPT (the first save may have been written)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    await quoteIt();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const first = createOrderMutate.mock.calls[0][0];
    // A network failure keeps the pair for a retry of the SAME attempt …
    act(() => createOrderMutate.mock.calls[0][1].onError({ response: { status: 500 } }));
    // … but the operator discards that return and builds a new one.
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    fireEvent.click(screen.getByRole("button", { name: /discard return/i }));
    await openReturnsAndAddLine("2");
    await quoteIt();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    const second = createOrderMutate.mock.calls[1][0];
    expect(second.inlineReturn.returnKey).not.toBe(first.inlineReturn.returnKey);
    // One key per attempt (BUG-A): a 500 is unknown, so the key survives the edit. If the first save did
    // land, the server refuses this return under that key (assertReplayCarriesReturnKey, a loud 409)
    // rather than writing a second order.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("a blocked return save closes the merge-vs-separate prompt that led to it", async () => {
    mockActiveOrder = {
      id: "ord-open",
      orderNumber: "ORD-OPEN-1",
      status: "PENDING",
      total: 10,
      itemCount: 1,
    };
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5"); // lines + reason, but NOT quoted
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    fireEvent.click(await screen.findByRole("button", { name: /separate/i }));
    expect(createOrderMutate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /separate/i })).not.toBeInTheDocument(),
    );
    // Back on the Returns section the operator must fix.
    expect(screen.getByLabelText(/qty \(pieces\)/i)).toBeInTheDocument();
  });
});
