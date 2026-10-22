import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { InlineReturnSection } from "./InlineReturnSection";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

// UX wave 2 (row 538): named quote lines (F22), per-line "More" (F23), account-credit wording (F25).
// A `mock`-prefixed map so the hoisted factory may read it; ids not in it have no order.
const mockOrders: Record<string, unknown> = {};
jest.mock("@/lib/api/orders", () => ({
  useOrder: (id: string) => ({ data: id ? mockOrders[id] : undefined }),
}));

const PRODUCTS = [
  { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null },
  { id: "prod-2", name: "Gadget", unit: "each", unitsPerBox: null },
];
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: { data: PRODUCTS } }),
}));

const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));

let authRole: string | undefined;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (authRole ? { user: { role: authRole } } : null),
}));

function chunk(overrides: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk {
  return {
    sourceOrderId: "order-a",
    sourceInvoiceItemId: "inv-item-1",
    sourceOrderItemId: "order-item-1",
    productId: "prod-1",
    pieces: 1,
    subtotal: 5,
    taxAmount: 0,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE",
    unitPrice: 5,
    ...overrides,
  };
}

function quoteResponse(chunks: InlineReturnQuoteChunk[]): InlineReturnQuoteResponse {
  return {
    chunks,
    subtotal: chunks.reduce((s, c) => s + c.subtotal, 0),
    taxAmount: 0,
    categoryTax: 0,
    total: chunks.reduce((s, c) => s + c.subtotal, 0),
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  authRole = undefined;
  for (const k of Object.keys(mockOrders)) delete mockOrders[k];
  mockOrders["order-a"] = { id: "order-a", orderNumber: "ORD-12", orderDate: "2026-10-01" };
  mockOrders["order-b"] = { id: "order-b", orderNumber: "ORD-15", orderDate: "2026-10-03" };
});

async function addProduct(name: string, search: string, pieces: string) {
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: search } });
  fireEvent.click(await screen.findByRole("button", { name }));
  const inputs = screen.getAllByLabelText(/^pieces$/i);
  fireEvent.change(inputs[inputs.length - 1], { target: { value: pieces } });
}

async function quoteWith(chunks: InlineReturnQuoteChunk[], products = ["Widget"]) {
  renderWithProviders(<InlineReturnSection customerId="cust-1" />);
  for (const [i, name] of products.entries()) {
    await addProduct(name, name.slice(0, 3).toLowerCase(), "1");
    if (i === 0) {
      fireEvent.change(screen.getAllByLabelText(/^reason$/i)[0], { target: { value: "DAMAGED" } });
    }
  }
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
  act(() => quoteMutate.mock.calls[0][1].onSuccess(quoteResponse(chunks)));
}

describe("F22 — each quote line is titled with its product", () => {
  it("two lines of one product from one order: both named, the order shown once", async () => {
    await quoteWith([
      chunk({ pieces: 1, subtotal: 5, unitPrice: 5 }),
      chunk({ sourceInvoiceItemId: "inv-item-2", pieces: 1, subtotal: 4.75, unitPrice: 4.75 }),
    ]);
    expect(await screen.findAllByText("Widget")).toHaveLength(2);
    expect(screen.getAllByText(/from order #ORD-12/i)).toHaveLength(1);
  });

  it("lines from different orders name the product AND their own order", async () => {
    await quoteWith(
      [
        chunk({ productId: "prod-1" }),
        chunk({ productId: "prod-2", sourceOrderId: "order-b", sourceInvoiceItemId: "inv-2" }),
      ],
      ["Widget", "Gadget"],
    );
    const rows = await screen.findAllByTestId("return-quote-line");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Widget")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/from order #ORD-12/i)).toBeInTheDocument();
    expect(within(rows[1]).getByText("Gadget")).toBeInTheDocument();
    expect(within(rows[1]).getByText(/from order #ORD-15/i)).toBeInTheDocument();
  });

  it("keeps the piece count and the net/tax figures on every line", async () => {
    await quoteWith([chunk({ pieces: 3, subtotal: 15, taxAmount: 1.5 })]);
    const row = await screen.findByTestId("return-quote-line");
    expect(within(row).getByText("3 pc")).toBeInTheDocument();
    expect(within(row).getByText("Net $15.00")).toBeInTheDocument();
    expect(within(row).getByText("Tax $1.50")).toBeInTheDocument();
  });
});
