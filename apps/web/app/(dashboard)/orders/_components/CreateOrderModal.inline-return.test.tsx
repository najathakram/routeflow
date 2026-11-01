import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateOrderModal } from "./CreateOrderModal";
import { RETURN_SAVE_BLOCKED } from "./use-order-inline-return-save";

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

// R-1 (SA-1069 A): the Returns section is one render. A search pick adds the line at 1 piece, the reason is one
// "Reason for all items" select, and the quote is asked by itself 350 ms after the last change to the lines.
async function openReturnsAndAddLine(pieces: string) {
  fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByRole("button", { name: "Widget" }));
  setPieces(pieces);
  fireEvent.change(screen.getByLabelText(/reason for all items/i), {
    target: { value: "DAMAGED" },
  });
}

function setPieces(pieces: string) {
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: pieces } });
}

function quoteReply(pieces: number) {
  return {
    chunks: [
      {
        sourceOrderId: "order-1",
        sourceInvoiceItemId: "inv-1",
        sourceOrderItemId: "oi-1",
        productId: "prod-1",
        pieces,
        subtotal: pieces,
        taxAmount: 0,
        categoryTax: 0,
        priceSource: "SOURCE_INVOICE",
        unitPrice: 1,
      },
    ],
    subtotal: pieces,
    taxAmount: 0,
    categoryTax: 0,
    total: pieces,
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  };
}

// Waits for the debounced quote the section asks for by itself, then answers it. `answered` counts the asks already
// answered, so a second round (after a discard or an edit) waits for a NEW ask.
let answered = 0;
async function quoteIt(pieces = 5) {
  await waitFor(() => expect(quoteMutate.mock.calls.length).toBeGreaterThan(answered));
  const calls = quoteMutate.mock.calls;
  answered = calls.length;
  act(() => {
    calls[calls.length - 1][1].onSuccess(quoteReply(pieces));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  answered = 0;
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
    await quoteIt();

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
    await quoteIt();

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
    await quoteIt();

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
    await quoteIt();
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
    expect(screen.getByLabelText(/^pieces$/i)).toHaveValue(5);
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
    expect(screen.queryByLabelText(/^pieces$/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0]).not.toHaveProperty("inlineReturn");
    // BUG-A: every create carries its attempt key now (no inlineReturn => the modal's own key).
    expect(createOrderMutate.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String));
    // Re-opening starts empty — nothing from the discarded draft survives.
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    expect(screen.queryByLabelText(/^pieces$/i)).not.toBeInTheDocument();
  });

  // SA-484i: the return rides the save ONLY when the section is expanded AND quoted.
  it("never expanded ⇒ the save carries no inlineReturn", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[0][0]).not.toHaveProperty("inlineReturn");
  });

  it("expanded with the quote still pending ⇒ the save is blocked with the working-it-out message (nothing sent)", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    // the quote may be asked by now, but nothing has answered it
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).not.toHaveBeenCalled();
    expect(await screen.findByText(RETURN_SAVE_BLOCKED["needs-quote"])).toBeInTheDocument();
  });

  it("lines changed after the quote ⇒ the save is blocked until the new quote answers, then carries the new quantity", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("5");
    await quoteIt(5);
    setPieces("6"); // the quote on screen is no longer for these lines
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).not.toHaveBeenCalled();
    expect(await screen.findByText(RETURN_SAVE_BLOCKED["needs-quote"])).toBeInTheDocument();

    await quoteIt(6);
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0].inlineReturn.items).toEqual([
      { productId: "prod-1", qty: 1, boxes: 0, pieces: 6 },
    ]);
  });

  it("a draft nobody chose a reason for saves under EXCESS_ORDER", async () => {
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    fireEvent.click(screen.getByRole("button", { name: /^returns$/i }));
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
    fireEvent.click(await screen.findByRole("button", { name: "Widget" }));
    setPieces("2");
    await quoteIt(2);
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    expect(createOrderMutate.mock.calls[0][0].inlineReturn.reason).toBe("EXCESS_ORDER");
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
    expect(screen.queryByLabelText(/^pieces$/i)).not.toBeInTheDocument();
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
    await quoteIt(2);
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
    await openReturnsAndAddLine("5"); // lines + reason, but the quote is not answered
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    fireEvent.click(await screen.findByRole("button", { name: /separate/i }));
    expect(createOrderMutate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /separate/i })).not.toBeInTheDocument(),
    );
    // Back on the Returns section the operator must fix.
    expect(screen.getByLabelText(/^pieces$/i)).toBeInTheDocument();
  });
});

// ─── SA-1060 A-5: a return on a Merge ────────────────────────────────────────────────────────────────────────────
// A merge target can have a sent invoice that the merge's revert turns into a draft, so the box (priced before the
// revert) and the note (priced after it) can differ. When the prompt opens on a quoted return it asks once more, with
// `editingOrderId` set to the target, and says what merging changes. It only says; nothing waits on the answer.
describe("CreateOrderModal — a return on the merge prompt (SA-1060 A-5)", () => {
  const OPEN = {
    id: "ord-open",
    orderNumber: "ORD-OPEN-1",
    status: "PENDING",
    total: 100,
    itemCount: 1,
  };
  const chunkOf = (over: Record<string, unknown> = {}) => ({
    sourceOrderId: null,
    sourceInvoiceItemId: null,
    sourceOrderItemId: null,
    productId: "prod-1",
    pieces: 3,
    subtotal: 30,
    taxAmount: 2.4,
    categoryTax: 0,
    priceSource: "TIER",
    unitPrice: 10,
    neverSold: false,
    ...over,
  });
  const quoteOf = (total: number, chunk = chunkOf()) => ({
    ...quoteReply(3),
    chunks: [chunk],
    subtotal: 30,
    taxAmount: Math.round((total - 30) * 100) / 100,
    total,
  });
  const SOLD = () => quoteOf(32.4);
  const NEVER = () => quoteOf(30, chunkOf({ taxAmount: 0, neverSold: true }));
  const LINE = "If you merge, this return is $30.00, not added to stock.";

  /** The box's quote, answered as the section's own ask (the last call so far). */
  async function boxQuoted(reply = SOLD()) {
    await waitFor(() => expect(quoteMutate.mock.calls.length).toBeGreaterThan(answered));
    const calls = quoteMutate.mock.calls;
    answered = calls.length;
    act(() => calls[calls.length - 1][1].onSuccess(reply));
  }
  /** Opens the merge prompt from the Save-as-draft button. */
  async function openPrompt() {
    fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
    await screen.findByRole("button", { name: /merge into/i });
  }
  const mergeBtn = () => screen.getByRole("button", { name: /merge into/i });
  const separateBtn = () => screen.getByRole("button", { name: /separate/i });
  const changeLine = () => screen.queryByTestId("merge-return-change");
  const promptAsks = () =>
    quoteMutate.mock.calls.filter((c) => c[0]?.editingOrderId === "ord-open");

  async function setup() {
    mockActiveOrder = OPEN;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("3");
    await boxQuoted();
  }

  it("NS-15: the prompt asks ONE more quote with the box's own request plus editingOrderId, and says what merging changes", async () => {
    await setup();
    const boxAsk = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][0];
    expect(boxAsk).not.toHaveProperty("editingOrderId"); // the box itself never names the target
    const before = quoteMutate.mock.calls.length;

    await openPrompt();

    expect(quoteMutate.mock.calls.length).toBe(before + 1);
    const ask = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][0];
    expect(ask).toEqual({ ...boxAsk, editingOrderId: "ord-open" });
    expect(changeLine()).toBeNull(); // nothing until it answers
    // A-6: the status region is already mounted, so a screen reader announces the words when they arrive
    const status = screen.getByTestId("merge-return-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toBeEmptyDOMElement();
    act(() => quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess(NEVER()));

    const line = await screen.findByTestId("merge-return-change");
    expect(line).toHaveTextContent(LINE);
    expect(screen.getByTestId("merge-return-status")).toBe(status);
    expect(status).toContainElement(line);
    // the box does not move: its lines, its $32.40 quote and its reason are as they were
    expect(screen.getByLabelText(/^pieces$/i)).toHaveValue(3);
    expect(screen.getAllByText("$32.40").length).toBeGreaterThan(0);
    // neither button waits: both are enabled, and Merge keeps the prompt's focus
    expect(mergeBtn()).toBeEnabled();
    expect(separateBtn()).toBeEnabled();
    expect(mergeBtn()).not.toHaveTextContent(/working out/i);
    expect(separateBtn()).not.toHaveTextContent(/working out/i);
  });

  it("NS-15: Merge does not wait for the answer and sends the save at once", async () => {
    await setup();
    await openPrompt();
    fireEvent.click(mergeBtn()); // before any answer
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
    expect(createOrderMutate.mock.calls[0][0].inlineReturn).toBeDefined();
    expect(createOrderMutate.mock.calls[0][1]).toBeDefined();
  });

  it("NS-18: no return at all -> the prompt makes no quote call and shows no line", async () => {
    mockActiveOrder = OPEN;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openPrompt();
    expect(quoteMutate).not.toHaveBeenCalled();
    expect(changeLine()).toBeNull();
  });

  it("NS-18: a return that is not quoted yet -> no call from the prompt and no line", async () => {
    mockActiveOrder = OPEN;
    renderWithProviders(<CreateOrderModal isOpen onClose={jest.fn()} />);
    await pickCustomer();
    await openReturnsAndAddLine("3"); // lines, but the box's quote is not answered
    await waitFor(() => expect(quoteMutate).toHaveBeenCalled()); // the box asked; it has no answer
    const before = quoteMutate.mock.calls.length;
    await openPrompt();
    expect(quoteMutate.mock.calls.length).toBe(before);
    expect(promptAsks()).toHaveLength(0);
    expect(changeLine()).toBeNull();
  });

  it("NS-19: merging prices the return the same -> no line", async () => {
    await setup();
    await openPrompt();
    act(() => quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess(SOLD()));
    expect(promptAsks()).toHaveLength(1);
    expect(changeLine()).toBeNull();
  });

  it("NS-20: a failed quote says nothing and both buttons work", async () => {
    await setup();
    await openPrompt();
    act(() =>
      quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onError(
        Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }),
      ),
    );
    expect(changeLine()).toBeNull();
    expect(mergeBtn()).toBeEnabled();
    expect(separateBtn()).toBeEnabled();
    fireEvent.click(separateBtn());
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
  });

  it("NS-20: a refused quote says nothing and both buttons work", async () => {
    await setup();
    await openPrompt();
    act(() =>
      quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onError({
        response: { status: 400, data: { code: "SOURCE_SALE_INVALID", message: "No." } },
      }),
    );
    expect(changeLine()).toBeNull();
    expect(mergeBtn()).toBeEnabled();
    fireEvent.click(mergeBtn());
    expect(createOrderMutate).toHaveBeenCalledTimes(1);
  });

  it("NS-21: Escape leaves the box's lines and quote alone, and a late answer paints no line on the closed prompt", async () => {
    await setup();
    await openPrompt();
    const lateAnswer = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /merge into/i })).not.toBeInTheDocument(),
    );
    act(() => lateAnswer(NEVER()));
    expect(changeLine()).toBeNull();
    // the box is exactly as it was: the same lines, still quoted, no "working out" state
    expect(screen.getByLabelText(/^pieces$/i)).toHaveValue(3);
    expect(screen.getAllByText("$32.40").length).toBeGreaterThan(0);
    expect(screen.queryByText(/working out the return credit/i)).toBeNull();
  });

  it("a line shown on one opening is gone when the prompt reopens, until the new ask answers", async () => {
    await setup();
    await openPrompt();
    act(() => quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess(NEVER()));
    expect(await screen.findByTestId("merge-return-change")).toHaveTextContent(LINE);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /merge into/i })).not.toBeInTheDocument(),
    );
    await openPrompt();
    expect(changeLine()).toBeNull();
  });

  it("an answer for a prompt that was closed and reopened paints nothing; the new ask's answer does", async () => {
    await setup();
    await openPrompt();
    const firstAnswer = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /merge into/i })).not.toBeInTheDocument(),
    );
    await openPrompt(); // reopened: a second ask
    expect(promptAsks()).toHaveLength(2);
    act(() => firstAnswer(NEVER())); // the first open's answer lands late
    expect(changeLine()).toBeNull();
    act(() => quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1][1].onSuccess(NEVER()));
    expect(await screen.findByTestId("merge-return-change")).toHaveTextContent(LINE);
  });
});
