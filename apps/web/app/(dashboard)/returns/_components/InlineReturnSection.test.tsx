import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

// Same mocking convention as RecordInlineReturnDialog.test.tsx (this section's own extraction
// source) — mock the hook module directly rather than apiClient.
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({ data: undefined }),
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
  fireEvent.change(screen.getByLabelText(/qty \(pieces\)/i), { target: { value: pieces } });
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
    fireEvent.change(screen.getByLabelText(/qty \(pieces\)/i), { target: { value: "5" } });
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
