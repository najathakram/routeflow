import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { RecordInlineReturnDialog } from "./RecordInlineReturnDialog";
import { RETURNS_NOT_ENABLED_MESSAGE } from "@routeflow/returns";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

// ─── Mocks — one per hook this dialog depends on, house convention (mock the hook module
// directly rather than apiClient — see CustomerFormModal.state.test.tsx). ───────────────

const ENTRY_ORDER = {
  id: "order-1",
  orderNumber: "1001",
  customerId: "cust-1",
  orderDate: "2026-09-01",
  lineItems: [
    {
      id: "li-1",
      productId: "prod-1",
      product: { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null },
      qty: 10,
      unitPrice: 2,
      status: "CONFIRMED",
    },
  ],
};

const BOXED_ENTRY_ORDER = {
  ...ENTRY_ORDER,
  id: "order-boxed",
  orderNumber: "1002",
  lineItems: [
    {
      id: "li-2",
      productId: "prod-boxed",
      product: { id: "prod-boxed", name: "Case of Soda", unit: "box", unitsPerBox: 12 },
      qty: 2,
      unitPrice: 24,
      status: "CONFIRMED",
      unitsPerBox: 12,
    },
  ],
};

const MIXED_UNIT_ENTRY_ORDER = {
  ...ENTRY_ORDER,
  id: "order-mixed",
  orderNumber: "1003",
  // SA-108: two lines of the SAME product, same pack (12) — a Case line and a plain pack
  // line that happen to agree on unitsPerBox (a genuinely mixed-pack pair is the SA-101(2)
  // conflict guard's own concern, tested server-side; this fixture isolates the DIALOG's
  // row-identity bug specifically). Before the fix, both hydrated rows shared one
  // productId-keyed identity: editing either row's Boxes field patched BOTH.
  lineItems: [
    {
      id: "li-case",
      productId: "prod-mixed",
      product: { id: "prod-mixed", name: "Widget", unit: "case", unitsPerBox: 12 },
      unitsPerBox: 12,
      qty: 1,
      unitPrice: 24,
      status: "CONFIRMED",
    },
    {
      id: "li-pack",
      productId: "prod-mixed",
      product: { id: "prod-mixed", name: "Widget", unit: "case", unitsPerBox: 12 },
      unitsPerBox: 12,
      qty: 3,
      unitPrice: 24,
      status: "CONFIRMED",
    },
  ],
};

const SOURCE_ORDER_NEWEST = { id: "order-newest", orderNumber: "2002", orderDate: "2026-09-10" };
const SOURCE_ORDER_OLDER = { id: "order-older", orderNumber: "1500", orderDate: "2026-08-01" };

let mockEntryOrder: any = ENTRY_ORDER;
const mockOrdersById: Record<string, any> = {
  [ENTRY_ORDER.id]: ENTRY_ORDER,
  [BOXED_ENTRY_ORDER.id]: BOXED_ENTRY_ORDER,
  [MIXED_UNIT_ENTRY_ORDER.id]: MIXED_UNIT_ENTRY_ORDER,
  [SOURCE_ORDER_NEWEST.id]: SOURCE_ORDER_NEWEST,
  [SOURCE_ORDER_OLDER.id]: SOURCE_ORDER_OLDER,
};

jest.mock("@/lib/api/orders", () => ({
  useOrder: (id: string) => ({ data: id ? (mockOrdersById[id] ?? mockEntryOrder) : undefined }),
  useOrders: () => ({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } } }),
}));

jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: [] } }),
}));

const quoteMutate = jest.fn();
const captureMutate = jest.fn();
let quoteIsPending = false;
let captureIsPending = false;

jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: quoteIsPending }),
  useCaptureInlineReturn: () => ({ mutate: captureMutate, isPending: captureIsPending }),
}));

function chunk(overrides: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk {
  return {
    sourceOrderId: "order-newest",
    sourceInvoiceItemId: "inv-item-1",
    sourceOrderItemId: "order-item-1",
    productId: "prod-1",
    pieces: 10,
    subtotal: 20,
    taxAmount: 2,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE",
    unitPrice: 2,
    ...overrides,
  };
}

function quoteResponse(chunks: InlineReturnQuoteChunk[]): InlineReturnQuoteResponse {
  return {
    chunks,
    subtotal: chunks.reduce((s, c) => s + c.subtotal, 0),
    taxAmount: chunks.reduce((s, c) => s + c.taxAmount, 0),
    categoryTax: chunks.reduce((s, c) => s + c.categoryTax, 0),
    total: chunks.reduce((s, c) => s + c.subtotal + c.taxAmount + c.categoryTax, 0),
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  };
}

/** Resolves the NEXT pending quote/capture mutate() call with `data`, via its onSuccess. */
function resolveNextQuote(data: InlineReturnQuoteResponse) {
  const call = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1];
  act(() => call[1].onSuccess(data));
}
function rejectNextQuote(error: unknown) {
  const call = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1];
  act(() => call[1].onError(error));
}
function resolveNextCapture(data: unknown) {
  const call = captureMutate.mock.calls[captureMutate.mock.calls.length - 1];
  act(() => call[1].onSuccess(data));
}
function rejectNextCapture(error: unknown) {
  const call = captureMutate.mock.calls[captureMutate.mock.calls.length - 1];
  act(() => call[1].onError(error));
}

async function openToStep1(orderId = "order-1") {
  renderWithProviders(
    <RecordInlineReturnDialog
      open
      onClose={jest.fn()}
      customerId="cust-1"
      orderId={orderId}
      customerName="Acme Foods"
    />,
  );
  await screen.findByText(/what came back/i);
}

/** R-1: there is no "Get quote". The quote is asked by itself 350 ms after the last change to the lines; the default
 *  1 s `waitFor` timeout covers it with real timers. */
async function enterQtyAndGetQuote(pieces: string) {
  const piecesInput = screen.getByLabelText(/^pieces$/i);
  fireEvent.change(piecesInput, { target: { value: pieces } });
  fireEvent.change(screen.getByLabelText(/reason for all items/i), {
    target: { value: "DAMAGED" },
  });
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
}

/** Waits for the NEXT live quote request (the lines changed again) to go out. */
async function waitForQuoteCall(n: number) {
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(n));
}

const TAKE_BACK = /take back items and give .* credit/i;
const optionsToggle = (name = "Widget") =>
  screen.getByRole("button", { name: new RegExp(`options for ${name}`, "i") });

beforeEach(() => {
  jest.clearAllMocks();
  mockEntryOrder = ENTRY_ORDER;
  quoteIsPending = false;
  captureIsPending = false;
});

describe("RecordInlineReturnDialog — covered chunks under the line (AC1)", () => {
  it("renders two covered chunks newest-invoice-first with components per chunk, total = sum", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");

    const newest = chunk({
      sourceOrderId: "order-newest",
      pieces: 6,
      subtotal: 12,
      taxAmount: 1.2,
    });
    const older = chunk({ sourceOrderId: "order-older", pieces: 4, subtotal: 8, taxAmount: 0.8 });
    resolveNextQuote(quoteResponse([newest, older]));

    // R-1: the chunks sit in the line's options; open them to read them.
    fireEvent.click(optionsToggle());
    await screen.findByText(/from order #2002/i);
    expect(screen.getByText(/from order #2002/i)).toBeVisible();
    const rows = screen.getAllByText(/from order #/i);
    expect(rows[0]).toHaveTextContent("2002");
    expect(rows[1]).toHaveTextContent("1500");

    // Components per chunk rendered exactly as returned.
    expect(screen.getByText("Net $12.00")).toBeInTheDocument();
    expect(screen.getByText("Tax $1.20")).toBeInTheDocument();
    expect(screen.getByText("Net $8.00")).toBeInTheDocument();
    expect(screen.getByText("Tax $0.80")).toBeInTheDocument();

    // Total = sum of the chunks' own subtotal+tax (20 subtotal + 2 tax = $22.00).
    expect(within(screen.getByTestId("return-summary")).getByText("$22.00")).toBeInTheDocument();
  });
});

describe("RecordInlineReturnDialog — excess chunk (AC2)", () => {
  it("defaults to 'credit at current price' and re-quotes without the excess on option 3", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("16");

    const covered = chunk({ sourceOrderId: "order-newest", pieces: 10 });
    const excess = chunk({
      sourceOrderId: null,
      sourceInvoiceItemId: null,
      pieces: 6,
      subtotal: 15,
    });
    resolveNextQuote(quoteResponse([covered, excess]));

    // R-1: the excess is flagged on its own line; the choice sits in that line's options.
    expect(await screen.findByTestId("return-line-flag-prod-1")).toHaveTextContent(
      "6 not on any invoice · Credit at current price",
    );
    fireEvent.click(optionsToggle());
    const currentPriceRadio = screen.getByRole("radio", { name: /credit at current price/i });
    const returnOnlyRadio = screen.getByRole("radio", { name: /return only what was bought/i });
    expect(currentPriceRadio).toBeChecked();
    expect(returnOnlyRadio).not.toBeChecked();

    fireEvent.click(returnOnlyRadio);
    // No re-quote button: the live quote follows the trimmed quantity by itself.
    await waitForQuoteCall(2);
    // The re-quote request drops the excess entirely — only the covered pieces remain.
    const requoteReq = quoteMutate.mock.calls[1][0];
    expect(requoteReq.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 10 }]);

    resolveNextQuote(quoteResponse([covered]));
    await waitFor(() => expect(screen.queryByText(/not on any invoice/i)).not.toBeInTheDocument());
  });

  it("capture sends the REDUCED quantity after option 3 — never the original over-return amount", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("16");

    const covered = chunk({ sourceOrderId: "order-newest", pieces: 4 });
    const excess = chunk({ sourceOrderId: null, sourceInvoiceItemId: null, pieces: 12 });
    resolveNextQuote(quoteResponse([covered, excess]));
    await screen.findByText(/not on any invoice/i);

    fireEvent.click(optionsToggle());
    fireEvent.click(screen.getByRole("radio", { name: /return only what was bought/i }));
    await waitForQuoteCall(2);
    resolveNextQuote(quoteResponse([covered]));
    await waitFor(() => expect(screen.queryByText(/not on any invoice/i)).not.toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "DAMAGED" },
    });
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));

    const captureReq = captureMutate.mock.calls[0][0];
    // 4 — the covered amount the re-quote settled on — never 16, the original request. No
    // per-item reason override was set, so it falls back to the capture-level reason below.
    expect(captureReq.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 4 }]);
    expect(captureReq.reason).toBe("DAMAGED");
  });
});

describe("RecordInlineReturnDialog — boxed product (AC3)", () => {
  it("renders explicit Boxes + Pieces inputs, never a bare qty field", async () => {
    mockEntryOrder = BOXED_ENTRY_ORDER;
    await openToStep1(BOXED_ENTRY_ORDER.id);

    expect(screen.getByLabelText(/^boxes$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^pieces$/i)).toBeInTheDocument();
    // A bare loose field would now ALSO be labelled "Pieces" (or the old "Qty (pieces)"), so count:
    // exactly ONE pieces control (the boxed extra-pieces input) and no Qty-labelled field.
    expect(screen.getAllByLabelText(/pieces/i)).toHaveLength(1);
    expect(screen.queryByLabelText(/^qty/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^boxes$/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "DAMAGED" },
    });

    await waitForQuoteCall(1);
    const req = quoteMutate.mock.calls[0][0];
    expect(req.items).toEqual([{ productId: "prod-boxed", qty: 1, boxes: 1, pieces: 3 }]);
  });
});

describe("RecordInlineReturnDialog — returnKey stability across a retry (AC4)", () => {
  it("reuses the SAME returnKey on a retry, and a success response renders success either time", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);

    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    const firstKey = captureMutate.mock.calls[0][0].returnKey;
    expect(typeof firstKey).toBe("string");
    expect(firstKey.length).toBeGreaterThan(0);

    // Simulate a network failure on the first attempt — no `replayed` field involved, the
    // API never sends one (SA-071a #2, corrected). The dialog goes to the refused step.
    rejectNextCapture({ response: { status: 500, data: { message: "Network error" } } });
    await screen.findByText("Network error");

    // Retry: back to the quote step, confirm again.
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(2));
    const secondKey = captureMutate.mock.calls[1][0].returnKey;

    expect(secondKey).toBe(firstKey);

    // Any 200 (even for a returnKey the server has already seen) renders success — there is
    // no `replayed` flag to special-case.
    resolveNextCapture({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      creditNoteId: "cn-1",
      refundAmount: 22,
      status: "REFUNDED",
      items: [],
    });
    await screen.findByText(/return recorded/i);
    expect(screen.getByText("#R-1")).toBeInTheDocument();
  });
});

describe("RecordInlineReturnDialog — refusals render the API's own message (AC5)", () => {
  // R-1 (meaning changed): a refused quote used to move the dialog to its "refused" screen. It now keeps the work: the
  // lines and the add box stay, the message sits under the list, and nothing can be confirmed.
  it("renders a business refusal's exact message under the list, keeps the work, with no retry loop", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");

    rejectNextQuote({
      response: {
        status: 400,
        data: { message: "Cannot capture a return against a cancelled order" },
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot capture a return against a cancelled order",
    );
    // the work is still on screen and the dialog never left the lines
    expect((screen.getByLabelText(/^pieces$/i) as HTMLInputElement).value).toBe("10");
    expect(screen.getByLabelText(/add another product/i)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
    // and nothing can be confirmed against a refused quote
    expect(screen.queryByRole("button", { name: TAKE_BACK })).toBeNull();
    await new Promise((r) => setTimeout(r, 450)); // longer than the debounce
    expect(quoteMutate).toHaveBeenCalledTimes(1); // no automatic retry
  });

  it("renders a returnKey-collision conflict message verbatim", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));

    rejectNextCapture({
      response: {
        status: 409,
        data: { message: "A different return already used this capture key" },
      },
    });
    await screen.findByText("A different return already used this capture key");
  });

  // #2647: a key-reused 409 means the earlier capture WAS recorded: link it, clear the draft.
  it("#2647: a key-reused 409 links the recorded return and starts a fresh attempt (new returnKey)", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    const firstKey = captureMutate.mock.calls[0][0].returnKey;

    rejectNextCapture({
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
    });
    const link = await screen.findByTestId("inline-return-recorded-link");
    expect(link).toHaveTextContent("Open RET-2026-0042");
    expect(link).toHaveAttribute("href", "/returns/ret-9");

    // Back lands on a FRESH draft: the section re-seeded (no quote, the typed qty cleared).
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(
      screen.queryByRole("button", { name: /take back items and give .* credit/i }),
    ).toBeNull();
    expect((screen.getByLabelText(/^pieces$/i) as HTMLInputElement).value).not.toBe("10");
    // and a new attempt is a NEW capture key (the old one was spent on the recorded return)
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "DAMAGED" },
    });
    await waitForQuoteCall(2);
    resolveNextQuote(quoteResponse([chunk()]));
    fireEvent.click(
      await screen.findByRole("button", { name: /take back items and give .* credit/i }),
    );
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(2));
    expect(captureMutate.mock.calls[1][0].returnKey).not.toBe(firstKey);
  });

  it("#2647: any other 409 shows its message but no 'Open RET' link", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    rejectNextCapture({
      response: { status: 409, data: { code: "INLINE_RETURN_KEY_CONFLICT", message: "Taken" } },
    });
    await screen.findByText("Taken");
    expect(screen.queryByTestId("inline-return-recorded-link")).toBeNull();
  });
});

describe("RecordInlineReturnDialog — 403 copy (AC6)", () => {
  it("renders the fixed 'Returns are not enabled' copy for an entitlement-gate 403", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");

    rejectNextQuote({
      response: {
        status: 403,
        data: {
          code: "ADDON_GATE",
          message: 'This feature requires the "orders_inline_returns" add-on.',
        },
      },
    });
    // R-1: shown under the list (the section keeps the work), still the fixed copy and never the server's text.
    expect(await screen.findByText(RETURNS_NOT_ENABLED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/orders_inline_returns/)).toBeNull();
  });
});

describe("RecordInlineReturnDialog — SA-108: per-row identity for two lines of one product", () => {
  // Both rows render an input LABELLED "Boxes", and the shared <Input> component derives
  // its DOM id from the label text (`label.toLowerCase().replace(/\s+/g, "-")`) rather than
  // a per-instance id — a PRE-EXISTING, unrelated limitation that collides once two rows
  // share a label, breaking getAllByLabelText's for/id association. Query by role instead:
  // each boxed row renders exactly two number inputs (Boxes, then Pieces), in DOM order.
  it("editing one row's Boxes never patches the other row, and the quote request sums only what was actually typed (not doubled)", async () => {
    mockEntryOrder = MIXED_UNIT_ENTRY_ORDER;
    await openToStep1(MIXED_UNIT_ENTRY_ORDER.id);

    const spinbuttons = screen.getAllByRole("spinbutton");
    expect(spinbuttons).toHaveLength(4); // 2 rows x (Boxes, Pieces)
    const [row1Boxes, , row2Boxes] = spinbuttons;
    expect((row1Boxes as HTMLInputElement).value).toBe("");
    expect((row2Boxes as HTMLInputElement).value).toBe("");

    fireEvent.change(row1Boxes, { target: { value: "1" } });

    // REGRESSION pin: before SA-108, both rows were keyed by productId, so updateLine
    // patched every row sharing it — the second row's Boxes field would also read "1".
    expect((row1Boxes as HTMLInputElement).value).toBe("1");
    expect((row2Boxes as HTMLInputElement).value).toBe("");

    // A per-line reason is optional; set the capture-level reason instead.
    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "DAMAGED" },
    });
    await waitForQuoteCall(1);

    const req = quoteMutate.mock.calls[0][0];
    // ONE merged item (buildQuoteRequest's own productId merge is correct here — it is
    // merging two REAL, independently-typed rows) at exactly what was typed into row 1;
    // row 2 (never touched) contributed nothing. Pre-fix this was boxes: 2 (doubled).
    expect(req.items).toEqual([{ productId: "prod-mixed", qty: 1, boxes: 1, pieces: 0 }]);
  });

  it("removing one row never removes the other row of the same product", async () => {
    mockEntryOrder = MIXED_UNIT_ENTRY_ORDER;
    await openToStep1(MIXED_UNIT_ENTRY_ORDER.id);

    expect(screen.getAllByRole("spinbutton")).toHaveLength(4);
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons).toHaveLength(2);

    fireEvent.click(removeButtons[0]);

    // REGRESSION pin: before SA-108, removeLine matched by productId and dropped BOTH rows.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
  });

  it("SA-108b, through the real drop-excess UI flow: capture sends the covered pieces ONCE, never doubled across the two rows", async () => {
    mockEntryOrder = MIXED_UNIT_ENTRY_ORDER;
    await openToStep1(MIXED_UNIT_ENTRY_ORDER.id);

    const [row1Boxes] = screen.getAllByRole("spinbutton");
    fireEvent.change(row1Boxes, { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "DAMAGED" },
    });
    await waitForQuoteCall(1);

    const covered = chunk({ productId: "prod-mixed", sourceOrderId: "order-newest", pieces: 5 });
    const excess = chunk({
      productId: "prod-mixed",
      sourceOrderId: null,
      sourceInvoiceItemId: null,
      pieces: 7,
    });
    resolveNextQuote(quoteResponse([covered, excess]));
    await screen.findByText(/not on any invoice/i);

    // the two rows are one product: the choice sits on the first row's options (both toggles read "Options for Widget")
    fireEvent.click(screen.getAllByRole("button", { name: /options for widget/i })[0]);
    fireEvent.click(screen.getByRole("radio", { name: /return only what was bought/i }));
    await waitForQuoteCall(2);
    resolveNextQuote(quoteResponse([covered]));
    await waitFor(() => expect(screen.queryByText(/not on any invoice/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    const captureReq = captureMutate.mock.calls[0][0];
    // Exactly 5, once — never 10 (5+5, the pre-fix double-count from both rows getting the
    // full covered total).
    expect(captureReq.items).toEqual([{ productId: "prod-mixed", qty: 1, boxes: 0, pieces: 5 }]);
  });

  it("shows the server's pack-conflict 409 message (B774/SA-101(2)) in the dialog, naming the product and both packs", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");

    rejectNextQuote({
      response: {
        status: 409,
        data: {
          code: "INLINE_RETURN_PACK_CONFLICT",
          message:
            "Widget is packed at more than one size in this customer's recent history " +
            "(4, 12) — return these lines from the order page's standard return instead.",
        },
      },
    });
    await screen.findByText(
      "Widget is packed at more than one size in this customer's recent history " +
        "(4, 12) — return these lines from the order page's standard return instead.",
    );
  });
});

describe("RecordInlineReturnDialog — office capture never sends routeRunStopId (AC7)", () => {
  it("never includes routeRunStopId on the quote or capture request, and renders success even if a response carried holdReason", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    expect(quoteMutate.mock.calls[0][0]).not.toHaveProperty("routeRunStopId");

    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0]).not.toHaveProperty("routeRunStopId");

    // Defensive: this PR's dialog has no code path that reads holdReason, so even a
    // (should-never-happen for an office capture) held response renders plain success —
    // never a held/approve/reject UI, which is PR 2's scope.
    resolveNextCapture({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      holdReason: "DRIVER_CAP",
      heldAmount: 22,
      status: "RECEIVED",
      items: [],
    });
    await screen.findByText(/return recorded/i);
    expect(screen.queryByText(/held/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/approve/i)).not.toBeInTheDocument();
  });
});

// ─── SA-740 (row 190): a counter return names the sale it is from ───────────────────────────

describe("RecordInlineReturnDialog — SA-740: sourceOrderId rides on the quote AND the capture", () => {
  async function openWithSource(sourceOrderId?: string) {
    renderWithProviders(
      <RecordInlineReturnDialog
        open
        onClose={jest.fn()}
        customerId="cust-1"
        orderId="order-1"
        customerName="Walk-in"
        sourceOrderId={sourceOrderId}
      />,
    );
    await screen.findByText(/what came back/i);
  }

  it("a dialog opened from a sale sends that sale as sourceOrderId on the quote and the capture", async () => {
    await openWithSource("order-1");
    await enterQtyAndGetQuote("10");
    expect(quoteMutate.mock.calls[0][0]).toMatchObject({ sourceOrderId: "order-1" });
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0]).toMatchObject({
      orderId: "order-1",
      sourceOrderId: "order-1",
    });
  });

  it("without the prop (named customer, order detail / customer detail) neither request carries one", async () => {
    await openWithSource(undefined);
    await enterQtyAndGetQuote("10");
    expect(quoteMutate.mock.calls[0][0]).not.toHaveProperty("sourceOrderId");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0]).not.toHaveProperty("sourceOrderId");
  });
});

// ─── #2097 — the result's credit amount, and the excess option across a re-quote ───────────

const captureResult = (over: Record<string, unknown> = {}) => ({
  id: "ret-1",
  returnNumber: "R-1",
  orderId: "order-1",
  customerId: "cust-1",
  creditNoteId: "cn-1",
  status: "REFUNDED",
  items: [],
  ...over,
});

async function captureWith(result: unknown) {
  await openToStep1();
  await enterQtyAndGetQuote("10");
  resolveNextQuote(quoteResponse([chunk()]));
  await screen.findByText(/take back items and give .* credit/i);
  fireEvent.change(screen.getByLabelText(/reason for all items/i), {
    target: { value: "DAMAGED" },
  });
  fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
  await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
  resolveNextCapture(result);
  await screen.findByText(/return recorded/i);
}

describe("RecordInlineReturnDialog — the credit amount on the result (#2097)", () => {
  it("shows the credit amount when refundAmount arrives as a Decimal STRING (what the API sends)", async () => {
    await captureWith(captureResult({ refundAmount: "22.5000" }));
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("$22.50")).toBeInTheDocument();
  });

  it("still shows a numeric refundAmount", async () => {
    await captureWith(captureResult({ refundAmount: 22 }));
    expect(screen.getByText("$22.00")).toBeInTheDocument();
  });

  it.each([[null], [undefined], [""], ["not-a-number"]])(
    "shows no Amount row for an absent or unparseable refundAmount (%p)",
    async (refundAmount) => {
      await captureWith(captureResult({ refundAmount }));
      expect(screen.queryByText("Amount")).not.toBeInTheDocument();
      expect(screen.queryByText("$NaN")).not.toBeInTheDocument();
    },
  );
});

describe("RecordInlineReturnDialog — the excess choice follows the live quote (#2097)", () => {
  const covered = () => chunk({ sourceOrderId: "order-newest", pieces: 10 });
  const excess = (pieces = 6, subtotal = 15) =>
    chunk({ sourceOrderId: null, sourceInvoiceItemId: null, pieces, subtotal });

  // R-1 (meaning changed): there is no Back to the items and no "Get quote" to ask again. Typing a different number on
  // the trimmed line ends the "only what was bought" choice by itself, and the next live quote starts on the default.
  it("after option 3, typing a bigger quantity ends the choice: the new quote starts on 'credit at current price'", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("16");
    resolveNextQuote(quoteResponse([covered(), excess()]));
    await screen.findByText(/not on any invoice/i);
    fireEvent.click(optionsToggle());

    fireEvent.click(screen.getByRole("radio", { name: /return only what was bought/i }));
    await waitForQuoteCall(2);
    resolveNextQuote(quoteResponse([covered()]));
    await waitFor(() => expect(screen.queryByText(/not on any invoice/i)).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /return only what was bought/i })).toBeChecked();

    // Raise the quantity: the live quote asks again by itself, and the new quote credits the excess.
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "20" } });
    await waitForQuoteCall(3);
    expect(quoteMutate.mock.calls[2][0].items).toEqual([
      { productId: "prod-1", qty: 1, boxes: 0, pieces: 20 },
    ]);
    resolveNextQuote(
      quoteResponse([
        covered(),
        chunk({ sourceOrderId: null, sourceInvoiceItemId: null, pieces: 10, subtotal: 25 }),
      ]),
    );
    await screen.findByText(/not on any invoice/i);

    // The highlighted option must match what the quote does: it credits the excess.
    expect(screen.getByRole("radio", { name: /credit at current price/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /return only what was bought/i })).not.toBeChecked();
  });

  it("picking option 3 sticks through the re-quote it triggers: still checked when that quote still shows an excess, and capture sends the covered pieces", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("16");
    resolveNextQuote(quoteResponse([covered(), excess()]));
    await screen.findByText(/not on any invoice/i);
    fireEvent.click(optionsToggle());

    fireEvent.click(screen.getByRole("radio", { name: /return only what was bought/i }));
    await waitForQuoteCall(2);
    // The re-quote comes back still carrying a (smaller) excess, so the radios stay on screen: the
    // pick must not have been reset by the re-quote it triggered.
    resolveNextQuote(
      quoteResponse([
        covered(),
        chunk({ sourceOrderId: null, sourceInvoiceItemId: null, pieces: 2, subtotal: 5 }),
      ]),
    );
    await screen.findByText(/not on any invoice/i);
    expect(screen.getByRole("radio", { name: /return only what was bought/i })).toBeChecked();
    fireEvent.change(screen.getByLabelText(/reason for all items/i), {
      target: { value: "DAMAGED" },
    });
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].items).toEqual([
      expect.objectContaining({ productId: "prod-1", pieces: 10 }),
    ]);
  });

  // R-1 (meaning changed): the old test pressed Back after a FAILED option-3 re-quote and found the old quote with the
  // default radio. There is no old quote to go back to now; the equivalent is that a refused follow-up quote leaves
  // nothing confirmable, and choosing 'Credit at current price' puts the typed quantity back and asks again.
  it("a REFUSED option-3 re-quote leaves nothing to confirm, and 'Credit at current price' puts the quantity back", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("16");
    resolveNextQuote(quoteResponse([covered(), excess()]));
    await screen.findByText(/not on any invoice/i);
    fireEvent.click(optionsToggle());

    fireEvent.click(screen.getByRole("radio", { name: /return only what was bought/i }));
    await waitForQuoteCall(2);
    rejectNextQuote({ response: { status: 409, data: { message: "Quote failed" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Quote failed");
    // the old quote is gone: it can neither be confirmed nor be shown as the current one
    expect(
      screen.queryByRole("button", { name: /take back items and give .* credit/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /credit at current price/i }));
    expect((screen.getByLabelText(/^pieces$/i) as HTMLInputElement).value).toBe("16");
    await waitForQuoteCall(3);
    expect(quoteMutate.mock.calls[2][0].items).toEqual([
      { productId: "prod-1", qty: 1, boxes: 0, pieces: 16 },
    ]);
    resolveNextQuote(quoteResponse([covered(), excess()]));
    expect(
      await screen.findByRole("button", { name: /take back items and give .* credit/i }),
    ).toBeInTheDocument();
  });

  // R-1 (meaning changed): was "a FAILED Step-1 quote clears the old quote: Back returns to the items". There is no
  // Back; a quote is current only for the exact lines on screen, so a change drops it at once and a refusal of the new one
  // never leaves the old one confirmable.
  it("changing a quantity drops the old quote at once, and a refusal of the new one never leaves the old one to confirm", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);

    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "12" } });
    // dropped at once, before the new quote is even asked
    expect(
      screen.queryByRole("button", { name: /take back items and give .* credit/i }),
    ).not.toBeInTheDocument();
    expect(quoteMutate).toHaveBeenCalledTimes(1);
    await waitForQuoteCall(2);
    expect(quoteMutate.mock.calls[1][0].items[0].pieces).toBe(12);
    rejectNextQuote({ response: { status: 409, data: { message: "Quote failed" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Quote failed");

    expect(
      screen.queryByRole("button", { name: /take back items and give .* credit/i }),
    ).not.toBeInTheDocument();
    expect((screen.getByLabelText(/^pieces$/i) as HTMLInputElement).value).toBe("12");
  });
});

describe("RecordInlineReturnDialog — B735: a parked ledger reversal must be visible", () => {
  async function captureToSuccess(response: unknown) {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    resolveNextCapture(response);
    await screen.findByText(/return recorded/i);
  }

  it("REG-B735-web-dialog-parked-warning: a response carrying parkedReversals renders a visible warning naming the piece count, heading unchanged", async () => {
    await captureToSuccess({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      status: "RECEIVED",
      parkedReversals: { count: 2, pieces: 5 },
      items: [],
    });

    const warning = screen.getByTestId("inline-return-parked-warning");
    expect(warning).toHaveTextContent(/parked/i);
    expect(warning).toHaveTextContent("5");
    // Operator words: what happened, why, the consequence, and the next step.
    expect(warning).toHaveTextContent(/pack size is unknown/i);
    expect(warning).toHaveTextContent(/cannot be filed until/i);
    expect(warning).toHaveTextContent(/next step/i);
    // Still the same heading and shape as any other success — this is additive, not a
    // replacement UI (that distinction is what separates B735 from a DRIVER_CAP hold).
    expect(screen.getByText(/return recorded/i)).toBeInTheDocument();
  });

  it("REG-B735-web-dialog-no-field-no-warning: a response with no parkedReversals field (or null) renders no warning", async () => {
    await captureToSuccess({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      status: "RECEIVED",
      parkedReversals: null,
      items: [],
    });

    expect(screen.queryByTestId("inline-return-parked-warning")).not.toBeInTheDocument();
    expect(screen.queryByText(/parked/i)).not.toBeInTheDocument();
  });

  it("REG-B735-web-dialog-absent-field-no-claim: an ABSENT parkedReversals (server could not check) renders no warning and no 'clean' claim", async () => {
    await captureToSuccess({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      status: "RECEIVED",
      items: [],
    });

    expect(screen.queryByTestId("inline-return-parked-warning")).not.toBeInTheDocument();
    expect(screen.queryByText(/ledger|clean|reconciled/i)).not.toBeInTheDocument();
  });

  it("PIN-B735-web-dialog-replay-shows-warning-both-times: a retry of a parked capture must not lose the warning on the replay response", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("10");
    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));

    // First attempt: network failure AFTER the server actually committed and parked (the
    // dialog never learns this — it only sees the dropped connection).
    rejectNextCapture({ response: { status: 500, data: { message: "Network error" } } });
    await screen.findByText("Network error");
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    await screen.findByText(/take back items and give .* credit/i);
    fireEvent.click(screen.getByRole("button", { name: /take back items and give .* credit/i }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(2));

    // The retry replays the SAME returnKey — the server's fresh-DB-read design (B735) means
    // the replay response still carries the park, unlike a value threaded only through the
    // original reversal call.
    expect(captureMutate.mock.calls[1][0].returnKey).toBe(captureMutate.mock.calls[0][0].returnKey);
    resolveNextCapture({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      status: "RECEIVED",
      parkedReversals: { count: 1, pieces: 3 },
      items: [],
    });
    await screen.findByText(/return recorded/i);
    expect(screen.getByTestId("inline-return-parked-warning")).toHaveTextContent("3");
  });

  it("PIN-B735-web-dialog-holdreason-still-plain: a DRIVER_CAP hold response with parkedReversals: null still shows plain success, no held/approve/parked text", async () => {
    await captureToSuccess({
      id: "ret-1",
      returnNumber: "R-1",
      orderId: "order-1",
      customerId: "cust-1",
      holdReason: "DRIVER_CAP",
      heldAmount: 22,
      status: "RECEIVED",
      parkedReversals: null,
      items: [],
    });

    expect(screen.queryByText(/held/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/approve/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("inline-return-parked-warning")).not.toBeInTheDocument();
  });
});
// R-1 M7 (meaning changed): there is no faded Return button and no "Choose a reason to continue" any more. The reason
// starts on the server's own default, so the button is ready as soon as the quote is current.
describe("RecordInlineReturnDialog — the reason starts on the server's default (R-1 M7)", () => {
  it("one 'Reason for all items' on EXCESS_ORDER, no placeholder, no hint; the button is enabled and capture sends it", async () => {
    await openToStep1();
    const reason = screen.getByLabelText(/reason for all items/i);
    expect(reason).toHaveValue("EXCESS_ORDER");
    expect(within(reason).queryByText(/choose a reason/i)).toBeNull();
    expect(screen.queryByText("Choose a reason to continue")).toBeNull();
    expect(reason).not.toHaveAttribute("aria-describedby");

    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "10" } });
    await waitForQuoteCall(1);
    resolveNextQuote(quoteResponse([chunk()]));
    const button = await screen.findByRole("button", { name: /take back items/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].reason).toBe("EXCESS_ORDER");
  });
});

describe("RecordInlineReturnDialog — phone tap targets (W-890)", () => {
  const small = (el: HTMLElement) => expect(el.className).toMatch(/max-lg:(min-)?h-11/);

  it("every control on the lines is 44 px below lg: close, Remove, fields, Reasons, options, Cancel", async () => {
    await openToStep1();
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("max-lg:min-h-11");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("max-lg:min-w-11");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("max-lg:min-h-11");
    // R-1: "Get quote" is gone; the line's options row is the control that takes its place
    expect(screen.queryByRole("button", { name: "Get quote" })).toBeNull();
    expect(optionsToggle()).toHaveClass("min-h-11");
    const remove = screen.getByRole("button", { name: "Remove" });
    small(remove);
    expect(remove).toHaveClass("max-lg:min-w-11");
    small(screen.getByLabelText(/^pieces$/i));
    small(screen.getByLabelText(/Note \(optional\)/));
    small(screen.getByLabelText(/Reason \(optional\)/));
    small(screen.getByLabelText("Reason for all items"));
  });

  it("the take-back button is 44 px below lg once the quote is current, and so is the capture refusal's Back", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("1");
    resolveNextQuote(quoteResponse([chunk({ sourceOrderId: "order-newest", pieces: 1 })]));
    const takeBack = await screen.findByRole("button", { name: TAKE_BACK });
    expect(takeBack).toHaveClass("max-lg:min-h-11");
    fireEvent.click(takeBack);
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    rejectNextCapture({ response: { status: 500, data: { message: "Network error" } } });
    expect(await screen.findByRole("button", { name: "Back" })).toHaveClass("max-lg:min-h-11");
  });

  it("a quote that did not come back offers a 44 px Try again", async () => {
    await openToStep1();
    await enterQtyAndGetQuote("1");
    rejectNextQuote(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }));
    expect(await screen.findByRole("button", { name: /try again/i })).toHaveClass(
      "max-lg:min-h-11",
    );
  });
});
