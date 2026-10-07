import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";
import { creditOverrideProblem } from "@routeflow/returns";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

// Same mocking convention as RecordInlineReturnDialog.test.tsx (this section's own extraction
// source) — mock the hook module directly rather than apiClient.
// The entry order the section prefills its rows from (undefined = no prefill). A `mock`-prefixed
// name so the hoisted factory may read it.
let mockEntryOrder: unknown;
jest.mock("@/lib/api/orders", () => ({
  useOrder: (id: string) => ({ data: id ? mockEntryOrder : undefined }),
}));

const PRODUCT = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
let productResults: (typeof PRODUCT)[] = [];

jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: productResults } }),
}));

const quoteMutate = jest.fn();
let quoteIsPending = false;

jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: quoteIsPending }),
}));

// #2695: the credit price override is role-gated; the real AuthProvider (renderWithProviders) has
// no user, so only useOptionalAuth is swapped for a role this file controls.
let authRole: string | undefined;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (authRole ? { user: { role: authRole } } : null),
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
  };
}

function resolveNextQuote(data: InlineReturnQuoteResponse) {
  const call = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1];
  act(() => call[1].onSuccess(data));
}
function rejectNextQuote(error: unknown) {
  const call = quoteMutate.mock.calls[quoteMutate.mock.calls.length - 1];
  act(() => call[1].onError(error));
}

beforeEach(() => {
  jest.clearAllMocks();
  quoteIsPending = false;
  productResults = [PRODUCT];
  authRole = undefined;
  mockEntryOrder = undefined;
});

function renderSection(
  props: Partial<React.ComponentProps<typeof InlineReturnSection>> = {},
): InlineReturnSectionState[] {
  const states: InlineReturnSectionState[] = [];
  renderWithProviders(
    <InlineReturnSection customerId="cust-1" onStateChange={(s) => states.push(s)} {...props} />,
  );
  return states;
}

async function addProductAndQuote(pieces: string) {
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByText("Widget"));
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: pieces } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
}

describe("InlineReturnSection — lines to quote (#2406)", () => {
  it("shows 'What came back' with no products by default and a disabled Get quote", () => {
    renderSection();
    expect(screen.getByText(/what came back/i)).toBeInTheDocument();
    expect(screen.getByText(/no products yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /get quote/i })).toBeDisabled();
  });

  it("adding a product, entering qty + reason, and quoting shows covered chunks and forwards state", async () => {
    const states = renderSection();
    await addProductAndQuote("10");

    const req = quoteMutate.mock.calls[0][0];
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 10 }]);

    resolveNextQuote(quoteResponse([chunk()]));
    await screen.findByText(/from an earlier order/i);
    expect(screen.getByText("Net $20.00")).toBeInTheDocument();
    expect(screen.getByText("$22.00")).toBeInTheDocument(); // subtotal + tax

    const last = states[states.length - 1];
    expect(last.step).toBe("quote");
    expect(last.captureReason).toBe("DAMAGED");
    expect(last.quote?.chunks).toHaveLength(1);
  });

  it("an excess chunk (not on any invoice) renders with the default 'credit at current price' pick", async () => {
    renderSection();
    await addProductAndQuote("16");
    resolveNextQuote(
      quoteResponse([
        chunk({ pieces: 10 }),
        chunk({ sourceOrderId: null, sourceInvoiceItemId: null, pieces: 6, subtotal: 15 }),
      ]),
    );
    await screen.findByText(/not on any invoice/i);
    expect(screen.getByRole("radio", { name: /credit at current price/i })).toBeChecked();
  });

  it("getQuoteEnabled=false disables Get quote even with qty entered (dialog's own carrying-order gate)", async () => {
    renderSection({ getQuoteEnabled: false });
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
    fireEvent.click(await screen.findByText("Widget"));
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: /get quote/i })).toBeDisabled();
  });
});

describe("InlineReturnSection — quote refusal (#2406)", () => {
  it("shows the API's message inline AND forwards it to onQuoteRefused", async () => {
    const onQuoteRefused = jest.fn();
    renderSection({ onQuoteRefused });
    await addProductAndQuote("10");
    rejectNextQuote({ response: { status: 400, data: { message: "Cannot quote this customer" } } });
    await screen.findByText("Cannot quote this customer");
    expect(onQuoteRefused).toHaveBeenCalledWith("Cannot quote this customer");
  });

  it("without onQuoteRefused, still shows the inline error (host reads it via its own UI if it wants to)", async () => {
    renderSection();
    await addProductAndQuote("10");
    rejectNextQuote({ response: { status: 500, data: { message: "Server error" } } });
    await screen.findByText("Server error");
  });
});

describe("InlineReturnSection — resetToken (#2406)", () => {
  it("bumping resetToken clears the operator's typed lines", async () => {
    const { rerender } = renderWithProviders(
      <InlineReturnSection customerId="cust-1" resetToken={0} />,
    );
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
    fireEvent.click(await screen.findByText("Widget"));
    expect(screen.getByText("Widget")).toBeInTheDocument();

    rerender(<InlineReturnSection customerId="cust-1" resetToken={1} />);
    expect(screen.queryByText("Widget", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByText(/no products yet/i)).toBeInTheDocument();
  });
});

describe("InlineReturnSection — hidden (#2406)", () => {
  it("renders nothing while hidden", () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" hidden />);
    expect(screen.queryByText(/what came back/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /get quote/i })).not.toBeInTheDocument();
  });
});

describe("InlineReturnSection — 'return only what was bought' with nothing bought (#2693)", () => {
  it("an all-excess quote disables the option, says so in plain words, and never sends an empty re-quote", async () => {
    renderSection();
    await addProductAndQuote("6");
    resolveNextQuote(
      quoteResponse([
        chunk({ sourceOrderId: null, sourceInvoiceItemId: null, pieces: 6, subtotal: 15 }),
      ]),
    );
    await screen.findByText(/not on any invoice/i);
    const onlyBought = screen.getByRole("radio", { name: /return only what was bought/i });
    expect(onlyBought).toBeDisabled();
    expect(screen.getByText(/hasn't bought these items before/i)).toBeInTheDocument();

    fireEvent.click(onlyBought);
    expect(quoteMutate).toHaveBeenCalledTimes(1); // only the original quote, never a re-quote
    expect(screen.getByRole("radio", { name: /credit at current price/i })).toBeChecked();
    expect(screen.queryByText(/must contain at least 1 elements/i)).not.toBeInTheDocument();
  });
});

// B891 (symptom pin): every line's "Pieces" label used to share the label-derived id
// "qty-(pieces)", so line 2's label targeted LINE 1's input and line 2's input was unlabelled.
describe("InlineReturnSection — each line's labels target that line's own fields (B891)", () => {
  it("two lines ⇒ two distinct, correctly-labelled Qty inputs", async () => {
    productResults = [PRODUCT, { id: "prod-2", name: "Gadget", unit: "each", unitsPerBox: null }];
    renderSection();
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
    fireEvent.click(await screen.findByText("Widget"));
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "gad" } });
    fireEvent.click(await screen.findByText("Gadget"));

    const qty = screen.getAllByLabelText(/^pieces$/i) as HTMLInputElement[];
    expect(qty).toHaveLength(2);
    expect(qty[0]).not.toBe(qty[1]);
    expect(qty[0].id).not.toBe(qty[1].id);
    // Typing through line 2's label reaches line 2's input only.
    fireEvent.change(qty[1], { target: { value: "7" } });
    expect(qty[1].value).toBe("7");
    expect(qty[0].value).not.toBe("7");
  });
});

describe("InlineReturnSection — #2695 staff credit price override", () => {
  async function addProduct(pieces: string) {
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
    fireEvent.click(await screen.findByText("Widget"));
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: pieces } });
  }

  it.each([["DRIVER"], ["CUSTOMER"], [undefined]])(
    "is never offered to %s (the server would 400 it)",
    async (role) => {
      authRole = role;
      renderSection();
      await addProduct("4");
      expect(screen.queryByLabelText(/credit price/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/why the lower price/i)).not.toBeInTheDocument();
    },
  );

  it.each([["OPERATOR"], ["TENANT_ADMIN"]])(
    "%s: a price + reason goes on the quote request, trimmed",
    async (role) => {
      authRole = role;
      const states = renderSection();
      await addProduct("4");
      fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "3.50" } });
      fireEvent.change(screen.getByLabelText(/why the lower price/i), {
        target: { value: "  damaged box " },
      });
      fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
      await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
      expect(quoteMutate.mock.calls[0][0].items).toEqual([
        {
          productId: "prod-1",
          qty: 1,
          boxes: 0,
          pieces: 4,
          creditUnitPrice: 3.5,
          overrideReason: "damaged box",
        },
      ]);
      // The host's capture reads these same lines (buildCaptureRequest), so it sends the same override.
      expect(states[states.length - 1].lines[0]).toMatchObject({ creditUnitPrice: "3.50" });
    },
  );

  it("a price without a reason blocks Get quote and says why", async () => {
    authRole = "OPERATOR";
    renderSection();
    await addProduct("4");
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "3.50" } });
    expect(screen.getByRole("button", { name: /get quote/i })).toBeDisabled();
    expect(screen.getByText(/widget: say why the credit price is lower/i)).toBeInTheDocument();
  });

  it("the quote shows a lowered line as the server priced it: the new price, the default it replaced, and why", async () => {
    authRole = "OPERATOR";
    renderSection();
    await addProduct("4");
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "3.50" } });
    fireEvent.change(screen.getByLabelText(/why the lower price/i), {
      target: { value: "dented" },
    });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    resolveNextQuote(
      quoteResponse([
        chunk({
          pieces: 4,
          subtotal: 14,
          taxAmount: 0.7,
          priceSource: "MANUAL",
          unitPrice: 3.5,
          originalPrice: 5,
          overrideReason: "dented",
        }),
      ]),
    );
    expect(
      await screen.findByText("Credit lowered to $3.50 each from $5.00 each — dented"),
    ).toBeInTheDocument();
  });

  it("'Return only what was bought' re-quotes WITH the override", async () => {
    authRole = "OPERATOR";
    renderSection();
    await addProduct("6");
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "3.50" } });
    fireEvent.change(screen.getByLabelText(/why the lower price/i), {
      target: { value: "dented" },
    });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    resolveNextQuote(
      quoteResponse([chunk({ pieces: 4 }), chunk({ sourceOrderId: null, pieces: 2 })]),
    );
    fireEvent.click(await screen.findByLabelText(/return only what was bought/i));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(2));
    expect(quoteMutate.mock.calls[1][0].items).toEqual([
      {
        productId: "prod-1",
        qty: 1,
        boxes: 0,
        pieces: 4,
        creditUnitPrice: 3.5,
        overrideReason: "dented",
      },
    ]);
  });

  it("a RETURN_CREDIT_OVER_CAP 400 renders the server's message inline, stays on the lines step and keeps the typed override to fix", async () => {
    authRole = "OPERATOR";
    const onQuoteRefused = jest.fn();
    const states = renderSection({ onQuoteRefused });
    await addProduct("4");
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "9.99" } });
    fireEvent.change(screen.getByLabelText(/why the lower price/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    const message =
      "Widget: a credit price can only be lowered — the most this return can credit is $5.00 per unit.";
    rejectNextQuote({
      response: {
        status: 400,
        data: { code: "RETURN_CREDIT_OVER_CAP", productId: "prod-1", message },
      },
    });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(onQuoteRefused).toHaveBeenCalledWith(message);
    expect(states[states.length - 1].step).toBe("lines");
    expect(screen.getByLabelText(/credit price/i)).toHaveValue("9.99");
    expect(screen.getByRole("button", { name: /get quote/i })).toBeEnabled();
  });

  describe("two prefilled rows of ONE product (a Case line and a pack line on the source order)", () => {
    const twoRows = () => {
      mockEntryOrder = {
        id: "ord-1",
        lineItems: [
          { id: "li-1", productId: "prod-1", name: "Widget (case)", qty: 2, status: "OPEN" },
          { id: "li-2", productId: "prod-1", name: "Widget (pack)", qty: 6, status: "OPEN" },
        ],
      };
      renderSection({ entryOrderId: "ord-1" });
    };
    const qtyInputs = () => screen.getAllByLabelText(/^pieces$/i);
    const priceInputs = () => screen.getAllByLabelText(/credit price/i);
    const reasonInputs = () => screen.getAllByLabelText(/why the lower price/i);
    const quoteButton = () => screen.getByRole("button", { name: /get quote/i });

    it("two priced rows with DIFFERENT overrides disable Get quote and say why", async () => {
      authRole = "OPERATOR";
      twoRows();
      await waitFor(() => expect(qtyInputs()).toHaveLength(2));
      fireEvent.change(qtyInputs()[0], { target: { value: "1" } });
      fireEvent.change(qtyInputs()[1], { target: { value: "2" } });
      fireEvent.change(priceInputs()[0], { target: { value: "3" } });
      fireEvent.change(reasonInputs()[0], { target: { value: "dented" } });
      // The second row carries no override: one row priced, one not, on the same product.
      expect(quoteButton()).toBeDisabled();
      expect(
        screen.getByText(/two rows of this product have different credit prices/i),
      ).toBeInTheDocument();
    });

    it("the same override on both rows quotes ONE merged item carrying it", async () => {
      authRole = "OPERATOR";
      twoRows();
      await waitFor(() => expect(qtyInputs()).toHaveLength(2));
      fireEvent.change(qtyInputs()[0], { target: { value: "1" } });
      fireEvent.change(qtyInputs()[1], { target: { value: "2" } });
      for (const i of [0, 1]) {
        fireEvent.change(priceInputs()[i], { target: { value: "3" } });
        fireEvent.change(reasonInputs()[i], { target: { value: "dented" } });
      }
      expect(quoteButton()).toBeEnabled();
      fireEvent.change(screen.getAllByLabelText(/^reason$/i)[0], { target: { value: "DAMAGED" } });
      fireEvent.click(quoteButton());
      await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
      expect(quoteMutate.mock.calls[0][0].items).toEqual([
        {
          productId: "prod-1",
          qty: 1,
          boxes: 0,
          pieces: 3,
          creditUnitPrice: 3,
          overrideReason: "dented",
        },
      ]);
    });

    it("an UNTOUCHED duplicate row (no quantity) is skipped, not a blocker: the quote sends the touched row only", async () => {
      authRole = "OPERATOR";
      twoRows();
      await waitFor(() => expect(qtyInputs()).toHaveLength(2));
      fireEvent.change(qtyInputs()[0], { target: { value: "2" } });
      fireEvent.change(priceInputs()[0], { target: { value: "3" } });
      fireEvent.change(reasonInputs()[0], { target: { value: "dented" } });
      expect(
        screen.queryByText(/two rows of this product have different credit prices/i),
      ).not.toBeInTheDocument();
      expect(quoteButton()).toBeEnabled();
      fireEvent.click(quoteButton());
      await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
      expect(quoteMutate.mock.calls[0][0].items).toEqual([
        {
          productId: "prod-1",
          qty: 1,
          boxes: 0,
          pieces: 2,
          creditUnitPrice: 3,
          overrideReason: "dented",
        },
      ]);
    });
  });
});
