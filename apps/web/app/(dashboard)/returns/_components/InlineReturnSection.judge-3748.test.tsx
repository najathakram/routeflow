import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { InlineReturnSection } from "./InlineReturnSection";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

// #3748 judge pass (mm-ux 2026-10-25): the words and the one conditional the return form was scored down for.
//  - a sold line reads "2 sold", not "Sold 2 each" (which reads like a price); a piece count says "2 pcs"
//  - there is no separate "Check the return" step in the one-step UI (R-1): the summary sits under the list; the
//    "more than one earlier order" helper shows only when the quote's lines really come from more than one order
//  - the placeholders carry no ellipsis (W-785)
//  - "Why the lower price?" appears only once a credit price has been typed; no "(optional)" on the credit price
const mockEntryOrder = {
  id: "order-entry",
  orderNumber: "ORD-7",
  orderDate: "2026-10-01T12:00:00.000Z",
  lineItems: [
    {
      id: "li-1",
      productId: "prod-1",
      product: { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null },
      qty: 2,
      status: "DELIVERED",
    },
  ],
};
jest.mock("@/lib/api/orders", () => ({
  useOrder: (id: string) => ({ data: id ? mockEntryOrder : undefined }),
}));
const PRODUCT = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [PRODUCT] } }) }));
const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));
let authRole: string | undefined;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (authRole ? { user: { role: authRole } } : null),
}));

const chunk = (over: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk => ({
  sourceOrderId: "order-a",
  sourceInvoiceItemId: "inv-item-1",
  sourceOrderItemId: "order-item-1",
  productId: "prod-1",
  pieces: 2,
  subtotal: 4,
  taxAmount: 0.4,
  categoryTax: 0,
  priceSource: "SOURCE_INVOICE",
  unitPrice: 2,
  ...over,
});
const quoteOf = (chunks: InlineReturnQuoteChunk[]): InlineReturnQuoteResponse => ({
  chunks,
  subtotal: 4,
  taxAmount: 0.4,
  categoryTax: 0,
  total: 4.4,
  productBreakdown: {},
  canRefund: false,
  paidInFull: false,
  paidMethods: [],
  paidWithStoreCredit: false,
  customerIsWalkIn: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  authRole = undefined;
});

// real timers: the quote is asked by itself 350 ms after the last change, inside waitFor's default window
async function toQuote(chunks: InlineReturnQuoteChunk[]) {
  renderWithProviders(<InlineReturnSection customerId="cust-1" entryOrderId="order-entry" />);
  fireEvent.change(await screen.findByLabelText(/^pieces$/i), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText(/reason for all items/i), {
    target: { value: "DAMAGED" },
  });
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
  act(() => quoteMutate.mock.calls[0][1].onSuccess(quoteOf(chunks)));
  await screen.findByTestId("return-summary");
}

describe("#3748 judge pass: words", () => {
  it("a sold line reads '2 sold', never 'Sold 2 each'", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" entryOrderId="order-entry" />);
    expect(await screen.findByText("2 sold")).toBeInTheDocument();
    expect(screen.queryByText(/^Sold \d/)).toBeNull();
  });

  it("the placeholders carry no ellipsis", async () => {
    renderWithProviders(<InlineReturnSection customerId="cust-1" entryOrderId="order-entry" />);
    expect(await screen.findByPlaceholderText("Search or scan a product")).toBeInTheDocument();
    // the reason list starts on a real reason: there is no "Choose a reason" placeholder option any more
    expect(screen.queryByRole("option", { name: "Choose a reason" })).toBeNull();
    expect(screen.queryByText(/…|\.\.\./)).toBeNull();
  });

  it("a quote row's count reads '2 pcs' (and '1 pc')", async () => {
    await toQuote([chunk({ pieces: 2 }), chunk({ pieces: 1, sourceInvoiceItemId: "inv-item-2" })]);
    expect(screen.getByText("2 pcs")).toBeInTheDocument();
    expect(screen.getByText("1 pc")).toBeInTheDocument();
    expect(screen.queryByText("2 pc")).toBeNull();
  });
});

describe("#3748 judge pass: the quote", () => {
  it("has no 'Check the return' step or 'Quote' title: the summary sits under the same list", async () => {
    await toQuote([chunk()]);
    expect(screen.queryByRole("heading", { name: "Check the return" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Quote" })).toBeNull();
    expect(screen.getByRole("heading", { name: "What came back" })).toBeInTheDocument();
    expect(screen.getByTestId("return-summary")).toHaveTextContent("Total$4.40");
  });

  it("the 'more than one earlier order' helper is absent when every line came from one order", async () => {
    await toQuote([chunk(), chunk({ sourceInvoiceItemId: "inv-item-2" })]);
    expect(screen.queryByText(/more than one earlier order/i)).toBeNull();
  });

  it("the helper shows when the lines come from more than one order", async () => {
    await toQuote([
      chunk(),
      chunk({ sourceOrderId: "order-b", sourceInvoiceItemId: "inv-item-2" }),
    ]);
    expect(screen.getByText(/more than one earlier order/i)).toBeInTheDocument();
  });
});

describe("#3748 judge pass: the staff credit price", () => {
  async function openMore() {
    authRole = "OPERATOR";
    renderWithProviders(<InlineReturnSection customerId="cust-1" entryOrderId="order-entry" />);
    fireEvent.click(await screen.findByRole("button", { name: /^options for /i }));
  }

  it("'Why the lower price?' is absent until a credit price is typed, then appears with its question mark", async () => {
    await openMore();
    expect(screen.queryByLabelText(/why the lower price/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "1.50" } });
    expect(screen.getByLabelText("Why the lower price?")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "" } });
    expect(screen.queryByLabelText(/why the lower price/i)).toBeNull();
  });

  it("the credit price label is short: no '(optional)'", async () => {
    await openMore();
    expect(screen.getByLabelText("Credit price")).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/\(optional\)/i, { selector: "[inputmode=decimal]" }),
    ).toBeNull();
  });
});
