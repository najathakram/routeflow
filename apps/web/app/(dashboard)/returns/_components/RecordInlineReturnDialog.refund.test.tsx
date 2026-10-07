import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RecordInlineReturnDialog } from "./RecordInlineReturnDialog";
import type { InlineReturnQuoteResponse } from "@routeflow/types";

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
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({ data: ORDER }),
  useOrders: () => ({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } } }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [] } }) }));

const quoteMutate = jest.fn();
const captureMutate = jest.fn();
const refundReturn = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
  useCaptureInlineReturn: () => ({ mutate: captureMutate, isPending: false }),
  refundReturn: (...a: unknown[]) => refundReturn(...a),
}));

function quote(extra: Partial<InlineReturnQuoteResponse> = {}): InlineReturnQuoteResponse {
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

async function toQuote(q: InlineReturnQuoteResponse, props: Record<string, unknown> = {}) {
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
  fireEvent.change(screen.getByLabelText(/qty \(pieces\)/i), { target: { value: "5" } });
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
});

describe("choice block visibility", () => {
  it("named customer, fully paid: Store credit is the default; Refund shows the quoted amount", async () => {
    await toQuote(quote());
    expect(screen.getByText("How do you want to give the money back?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Store credit" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Refund $12.40" })).not.toBeChecked();
    expect(confirmBtn(/^return & issue store credit$/i)).toBeInTheDocument();
  });

  it("not fully paid: no choice block, today's dialog exactly", async () => {
    await toQuote(quote({ canRefund: false, paidInFull: false }));
    expect(screen.queryByText(/give the money back/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: /store credit/i })).toBeNull();
    expect(confirmBtn(/^issue credit note and receive goods$/i)).toBeInTheDocument();
  });

  it("customer-detail entry (no allowRefund): no choice block even when canRefund", async () => {
    await toQuote(quote(), { allowRefund: false, orderId: "order-1" });
    expect(screen.queryByText(/give the money back/i)).toBeNull();
    expect(confirmBtn(/^issue credit note and receive goods$/i)).toBeInTheDocument();
  });

  it("walk-in: only Refund, preselected, with the explanatory line", async () => {
    await toQuote(quote({ customerIsWalkIn: true }));
    expect(screen.queryByRole("radio", { name: "Store credit" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Refund $12.40" })).toBeChecked();
    expect(
      screen.getByText("Walk-in sales can't hold store credit, so you'll give the money back."),
    ).toBeInTheDocument();
    expect(confirmBtn(/^return & refund \$12\.40$/i)).toBeInTheDocument();
  });

  it("Refund by is preselected from paidMethods[0], falling back to Cash", async () => {
    await toQuote(quote({ paidMethods: ["CARD", "CASH"] }));
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(screen.getByLabelText("Refund by")).toHaveValue("CARD");
  });
  it("falls back to Cash when no paid method is known", async () => {
    await toQuote(quote({ paidMethods: [] }));
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(screen.getByLabelText("Refund by")).toHaveValue("CASH");
  });
});

describe("summary lines", () => {
  it("cash / check: hand it back", async () => {
    await toQuote(quote({ paidMethods: ["CHECK"] }));
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(screen.getByText("Hand $12.40 back to the customer.")).toBeInTheDocument();
  });
  it("card: give it back on the card at the terminal", async () => {
    await toQuote(quote({ paidMethods: ["CARD"] }));
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(
      screen.getByText("Give $12.40 back on the customer's card at the terminal."),
    ).toBeInTheDocument();
  });
});

async function refundFlow(q = quote({ paidMethods: ["CARD"] })) {
  const ctx = await toQuote(q);
  fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
  return ctx;
}

describe("refund flow", () => {
  it("captures with resolution REFUND then POSTs the refund with tender + expectedAmount", async () => {
    refundReturn.mockResolvedValue({});
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^return & refund \$12\.40$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].resolution).toBe("REFUND");
    captureOk();
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    expect(refundReturn).toHaveBeenCalledWith("ret-1", { tender: "CARD", expectedAmount: 12.4 });
    await screen.findByText(
      "Refund recorded. Give $12.40 back on the customer's card at the terminal.",
    );
    expect(onRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ret-1" }),
      expect.objectContaining({ resolution: "REFUND", tender: "CARD", amount: 12.4 }),
    );
  });

  it("cash success copy", async () => {
    refundReturn.mockResolvedValue({});
    await refundFlow(quote({ paidMethods: ["CASH"] }));
    fireEvent.click(confirmBtn(/^return & refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalled());
    captureOk();
    await screen.findByText("Refund recorded. Hand $12.40 back to the customer.");
  });

  it("store credit with the block sends resolution STORE_CREDIT and never refunds", async () => {
    const { onRecorded } = await toQuote(quote());
    fireEvent.click(confirmBtn(/^return & issue store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].resolution).toBe("STORE_CREDIT");
    captureOk({ ...RECORD, creditNoteId: "cn-1" });
    await screen.findByText(/return recorded/i);
    expect(refundReturn).not.toHaveBeenCalled();
    expect(onRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ret-1" }),
      expect.objectContaining({ resolution: "STORE_CREDIT" }),
    );
  });

  it("hidden block: capture request carries no resolution field (today's payload)", async () => {
    await toQuote(quote({ canRefund: false }));
    fireEvent.click(confirmBtn(/^issue credit note and receive goods$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect("resolution" in captureMutate.mock.calls[0][0]).toBe(false);
  });

  it("double-click: one capture, one refund, same key", async () => {
    let release!: () => void;
    refundReturn.mockReturnValue(new Promise<void>((r) => (release = r)));
    await refundFlow();
    const btn = confirmBtn(/^return & refund/i);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Refunding…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refunding…" }));
    expect(refundReturn).toHaveBeenCalledTimes(1);
    expect(captureMutate).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("refund failure: saved copy + Retry refund re-POSTs only the refund (no re-capture)", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(500)).mockResolvedValueOnce({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^return & refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("Return saved. Refund didn't go through. Try again.");
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry refund" }));
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(captureMutate).toHaveBeenCalledTimes(1);
    expect(refundReturn.mock.calls[1]).toEqual(refundReturn.mock.calls[0]);
    await screen.findByText(/^Refund recorded\./);
  });

  it("REFUND_AMOUNT_CHANGED re-quotes and needs a fresh confirm with the new amount", async () => {
    refundReturn
      .mockRejectedValueOnce(apiErr(409, "REFUND_AMOUNT_CHANGED"))
      .mockResolvedValueOnce({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^return & refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("The refund amount changed. Check it and confirm again.");
    // a fresh quote was requested; no automatic second refund
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(2));
    expect(refundReturn).toHaveBeenCalledTimes(1);
    act(() => lastCall(quoteMutate)[1].onSuccess(quote({ total: 10.0, paidMethods: ["CARD"] })));
    const btn = await screen.findByRole("button", { name: /^return & refund \$10\.00$/i });
    fireEvent.click(btn);
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(refundReturn.mock.calls[1]).toEqual(["ret-1", { tender: "CARD", expectedAmount: 10 }]);
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("RETURN_ALREADY_RESOLVED shows fixed copy and offers no retry", async () => {
    refundReturn.mockRejectedValue(apiErr(409, "RETURN_ALREADY_RESOLVED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^return & refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalled());
    captureOk();
    await screen.findByText("This return is already done. Nothing more was refunded.");
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  });

  it("403 shows fixed permission copy, never the server text", async () => {
    refundReturn.mockRejectedValue(apiErr(403));
    await refundFlow();
    fireEvent.click(confirmBtn(/^return & refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalled());
    captureOk();
    await screen.findByText("You don't have permission to refund this return.");
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
  });
});
