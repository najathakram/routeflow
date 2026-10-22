import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RecordInlineReturnDialog } from "./RecordInlineReturnDialog";
import type { InlineReturnQuoteResponse, InlineReturnRefundEligibility } from "@routeflow/types";
import { REFUND_COPY } from "./refund-copy";

/** The quote as the POS-4b API will answer it (refund eligibility alongside the breakdown). */
type RefundQuote = InlineReturnQuoteResponse & Partial<InlineReturnRefundEligibility>;

// UX wave 2 (row 538): store-credit wording (F25), refund-only as plain text (say-no #2), done state (P29/P30).
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
  renderWithProviders(
    <RecordInlineReturnDialog
      open
      onClose={jest.fn()}
      customerId="cust-1"
      orderId="order-1"
      customerName="Acme Foods"
      allowRefund
      {...props}
    />,
  );
  await screen.findByText(/what came back/i);
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
  await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
  act(() => lastCall(quoteMutate)[1].onSuccess(q));
  await screen.findByText(/^quote$/i);
}
const captureOk = (data: unknown = RECORD) => act(() => lastCall(captureMutate)[1].onSuccess(data));

beforeEach(() => {
  jest.clearAllMocks();
  quotePending = false;
  capturePending = false;
});

describe("F25 — store credit, the word the statements use", () => {
  it("no choice block: the note and the button say store credit, never credit note", async () => {
    await toQuote(quote({ canRefund: false, paidInFull: false }));
    expect(
      screen.getByText("This will be added to the customer's store credit."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return & issue store credit" })).toBeInTheDocument();
    expect(screen.queryByText(/credit note/i)).toBeNull();
  });

  it("with the choice block and Store credit picked: same note", async () => {
    await toQuote(quote());
    expect(
      screen.getByText("This will be added to the customer's store credit."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/credit note/i)).toBeNull();
  });
});

describe("say-no #2 — refund as the only option is plain text with ONE statement", () => {
  it("walk-in: no one-option radio; Refund by stays; the amount is stated once", async () => {
    await toQuote(quote({ customerIsWalkIn: true }));
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText("Refund $12.40")).toBeInTheDocument();
    expect(screen.getByLabelText("Refund by")).toHaveValue("CASH");
    expect(screen.getAllByText(/back to the customer/i)).toHaveLength(1);
    expect(screen.getByText("Hand $12.40 back to the customer.")).toBeInTheDocument();
    expect(screen.queryByText(/can't hold store credit/i)).toBeNull();
    expect(screen.queryByText(/not added to their balance/i)).toBeNull();
    expect(screen.queryByText(/credit note/i)).toBeNull();
  });

  it("walk-in: the tender can still be changed and the sentence follows it", async () => {
    await toQuote(quote({ customerIsWalkIn: true }));
    fireEvent.change(screen.getByLabelText("Refund by"), { target: { value: "CARD" } });
    expect(
      screen.getByText("Give $12.40 back on the customer's card at the terminal."),
    ).toBeInTheDocument();
  });

  it("walk-in: the confirm button still names the action and the amount", async () => {
    await toQuote(quote({ customerIsWalkIn: true }));
    expect(screen.getByRole("button", { name: "Return & refund $12.40" })).toBeInTheDocument();
  });

  it("a named customer keeps both options as radios", async () => {
    await toQuote(quote());
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });
});

describe("P29/P30 — the done state", () => {
  async function recorded(data: unknown) {
    await toQuote(quote());
    fireEvent.click(screen.getByRole("button", { name: "Return & issue store credit" }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk(data);
  }

  it("states the result in one success status, with no duplicate label", async () => {
    await recorded({ ...RECORD, creditNoteId: "cn-1" });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Return recorded");
    expect(screen.queryByText("Return")).toBeNull();
    expect(screen.queryByText("Credit note")).toBeNull();
    expect(screen.queryByText("Order")).toBeNull();
  });

  it("return, credit note and order are links of one pattern, each to its own page", async () => {
    await recorded({ ...RECORD, creditNoteId: "cn-1" });
    const ret = await screen.findByRole("link", { name: "View return #R-1" });
    const cn = screen.getByRole("link", { name: "View credit note" });
    const ord = screen.getByRole("link", { name: "View order" });
    expect(ret).toHaveAttribute("href", "/returns/ret-1");
    expect(cn).toHaveAttribute("href", "/credit-notes/cn-1");
    expect(ord).toHaveAttribute("href", "/orders/order-1");
    expect(cn.className).toBe(ret.className);
    expect(ord.className).toBe(ret.className);
  });

  it("without a credit note or a number the other links stay and nothing is blank", async () => {
    await recorded({ ...RECORD, returnNumber: null });
    expect(await screen.findByRole("link", { name: "View return" })).toHaveAttribute(
      "href",
      "/returns/ret-1",
    );
    expect(screen.queryByRole("link", { name: /credit note/i })).toBeNull();
    expect(screen.getByRole("link", { name: "View order" })).toBeInTheDocument();
  });

  it("a refund keeps the one hand-back statement inside the same status", async () => {
    refundReturn.mockResolvedValue({});
    await toQuote(quote({ customerIsWalkIn: true }));
    fireEvent.click(screen.getByRole("button", { name: "Return & refund $12.40" }));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Hand $12.40 back to the customer."));
    expect(status).toHaveTextContent("Return recorded");
  });
});
