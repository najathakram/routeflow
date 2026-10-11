import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RecordInlineReturnDialog } from "./RecordInlineReturnDialog";
import type { InlineReturnQuoteResponse, InlineReturnRefundEligibility } from "@routeflow/types";
import { cashBackCopy, cashRefundLimit } from "./refund-copy";

/** The quote as the POS-4b API will answer it (refund eligibility alongside the breakdown). */
type RefundQuote = InlineReturnQuoteResponse & Partial<InlineReturnRefundEligibility>;

// POS-4b: refund vs store credit in the return dialog. Mocks follow RecordInlineReturnDialog.test.tsx.
const ORDER = {
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
jest.mock("./RefundSlipAction", () => ({
  RefundSlipAction: (p: { returnId: string; autoPrint?: boolean }) => (
    <div data-testid="slip-action" data-return-id={p.returnId} data-auto={String(!!p.autoPrint)} />
  ),
}));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({ data: ORDER }),
  useOrders: () => ({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } } }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [] } }) }));

const quoteMutate = jest.fn();
const captureMutate = jest.fn();
const refundReturn = jest.fn();
const storeCreditInstead = jest.fn();
let quotePending = false;
let capturePending = false;
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: quotePending }),
  useCaptureInlineReturn: () => ({ mutate: captureMutate, isPending: capturePending }),
  refundReturn: (...a: unknown[]) => refundReturn(...a),
  storeCreditInstead: (...a: unknown[]) => storeCreditInstead(...a),
}));

function quote(extra: Partial<RefundQuote> = {}): RefundQuote {
  return {
    chunks: [
      {
        sourceOrderId: "order-1",
        sourceInvoiceItemId: "ii-1",
        sourceOrderItemId: "oi-1",
        productId: "prod-1",
        pieces: 5,
        subtotal: 11.2,
        taxAmount: 1.2,
        categoryTax: 0,
        priceSource: "SOURCE_INVOICE",
        unitPrice: 2.24,
      },
    ],
    subtotal: 11.2,
    taxAmount: 1.2,
    categoryTax: 0,
    total: 12.4,
    productBreakdown: {},
    cashRefundable: {},
    canRefund: true,
    paidInFull: true,
    paidMethods: ["CASH"],
    customerIsWalkIn: false,
    paidWithStoreCredit: false,
    ...extra,
  };
}
const RECORD = {
  id: "ret-1",
  returnNumber: "R-1",
  orderId: "order-1",
  customerId: "cust-1",
  status: "REFUNDED",
  items: [],
};
const apiErr = (status: number, code?: string) => ({
  response: { status, data: { code, message: "SERVER RAW TEXT" } },
});
const lastCall = (m: jest.Mock) => m.mock.calls[m.mock.calls.length - 1];

async function toQuote(q: RefundQuote, props: Record<string, unknown> = {}) {
  const onRecorded = jest.fn();
  renderWithProviders(
    <RecordInlineReturnDialog
      open
      onClose={jest.fn()}
      customerId="cust-1"
      orderId="order-1"
      customerName="Acme Foods"
      allowRefund
      onRecorded={onRecorded}
      {...props}
    />,
  );
  await screen.findByText(/what came back/i);
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
  act(() => lastCall(quoteMutate)[1].onSuccess(q));
  await screen.findByText(/how do you want to give the money back|issue credit note/i);
  return { onRecorded };
}
const captureOk = (data: unknown = RECORD) => act(() => lastCall(captureMutate)[1].onSuccess(data));
const confirmBtn = (re: RegExp) => screen.getByRole("button", { name: re });

beforeEach(() => {
  jest.clearAllMocks();
  quotePending = false;
  capturePending = false;
});

const refundByValue = () => (screen.getByLabelText("Refund by") as HTMLSelectElement).value;
const pickRefund = () => fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));

describe("a refund above the sale's cash defaults to Card and says how much can go back in cash (G7 item 9)", () => {
  it("refund 12.40 with 5.00 of cash left: Card is the default and 'Up to $5.00 back in cash' shows", async () => {
    await toQuote(
      quote({ cashRefundable: { "order-1": 5 }, paidMethods: ["CASH", "CREDIT_CARD"] }),
    );
    pickRefund();
    expect(refundByValue()).toBe("CARD");
    expect(screen.getByTestId("refund-cash-limit")).toHaveTextContent("Up to $5.00 back in cash");
    expect(cashBackCopy("$5.00")).toBe("Up to $5.00 back in cash");
    expect(
      screen.getByText("Give $12.40 back on the customer's card at the terminal."),
    ).toBeInTheDocument();
  });

  it("every existing control stays: Cash and Check are still offered, and picking Cash is the clerk's call", async () => {
    await toQuote(quote({ cashRefundable: { "order-1": 5 } }));
    pickRefund();
    const options = Array.from(
      (screen.getByLabelText("Refund by") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(["CASH", "CARD", "CHECK"]);
    fireEvent.change(screen.getByLabelText("Refund by"), { target: { value: "CASH" } });
    expect(refundByValue()).toBe("CASH");
    expect(screen.getByRole("radio", { name: "Store credit" })).toBeInTheDocument();
  });

  it("the refund equal to the cash left is allowed: no note, the paid method stays the default", async () => {
    await toQuote(quote({ cashRefundable: { "order-1": 12.4 } }));
    pickRefund();
    expect(refundByValue()).toBe("CASH");
    expect(screen.queryByTestId("refund-cash-limit")).toBeNull();
  });

  it("plenty of cash left, or no figure for the sale (older API): nothing changes", async () => {
    await toQuote(quote({ cashRefundable: { "order-1": 50 } }));
    pickRefund();
    expect(refundByValue()).toBe("CASH");
    expect(screen.queryByTestId("refund-cash-limit")).toBeNull();
  });

  it("no cash left at all reads 'Up to $0.00 back in cash'", async () => {
    await toQuote(quote({ cashRefundable: { "order-1": 0 }, paidMethods: ["CREDIT_CARD"] }));
    pickRefund();
    expect(refundByValue()).toBe("CARD");
    expect(screen.getByTestId("refund-cash-limit")).toHaveTextContent("Up to $0.00 back in cash");
  });

  it("a clerk's own tender choice is kept when the quote refreshes the limit", async () => {
    await toQuote(quote({ cashRefundable: { "order-1": 5 } }));
    pickRefund();
    fireEvent.change(screen.getByLabelText("Refund by"), { target: { value: "CHECK" } });
    expect(refundByValue()).toBe("CHECK");
    expect(screen.getByTestId("refund-cash-limit")).toBeInTheDocument();
  });
});

describe("cashRefundLimit: per source sale, from the quote alone", () => {
  const chunk = (sourceOrderId: string | null, subtotal: number, taxAmount = 0) => ({
    sourceOrderId,
    sourceInvoiceItemId: null,
    sourceOrderItemId: null,
    productId: "p",
    pieces: 1,
    subtotal,
    taxAmount,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE" as const,
    unitPrice: subtotal,
  });

  it("one sale: share (subtotal + tax) against its room", () => {
    const base = { chunks: [chunk("a", 11.2, 1.2)] };
    expect(cashRefundLimit({ ...base, cashRefundable: { a: 5 } })).toEqual({
      exceeds: true,
      upTo: 5,
    });
    expect(cashRefundLimit({ ...base, cashRefundable: { a: 12.4 } })).toEqual({
      exceeds: false,
      upTo: 12.4,
    });
  });

  it("two sales: exceeds if EITHER is short; up to = what each can give, summed", () => {
    const quote = { chunks: [chunk("a", 10), chunk("b", 20)] };
    expect(cashRefundLimit({ ...quote, cashRefundable: { a: 10, b: 15 } })).toEqual({
      exceeds: true,
      upTo: 25,
    });
    expect(cashRefundLimit({ ...quote, cashRefundable: { a: 10, b: 20 } })?.exceeds).toBe(false);
  });

  it("no figures, or no chunk on a sale: null (the server's cap still answers)", () => {
    expect(cashRefundLimit({ chunks: [chunk("a", 10)] })).toBeNull();
    expect(cashRefundLimit({ chunks: [chunk(null, 10)], cashRefundable: { a: 0 } })).toBeNull();
    expect(cashRefundLimit({ chunks: [chunk("a", 10)], cashRefundable: {} })).toEqual({
      exceeds: false,
      upTo: 10,
    });
  });
});
