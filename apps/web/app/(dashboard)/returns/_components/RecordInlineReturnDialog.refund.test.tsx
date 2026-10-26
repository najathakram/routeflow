import * as React from "react";
import { act } from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { RecordInlineReturnDialog } from "./RecordInlineReturnDialog";
import type { InlineReturnQuoteResponse, InlineReturnRefundEligibility } from "@routeflow/types";
import { REFUND_COPY, WALK_IN_REFUND_LINE, type RefundErrorKind } from "./refund-copy";

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
/** The refund error line is "Return recorded." (calm) plus what went wrong (red): two spans in one alert, so match the alert. */
const findLine = (copy: string) =>
  waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(copy));

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
  await screen.findByRole("button", { name: /take back items/i });
  return { onRecorded };
}
/** The quote step for a return that offers no take-back button (a refusal): waits for the step's heading instead. */
async function toRefusalQuote(q: RefundQuote, props: Record<string, unknown> = {}) {
  renderWithProviders(
    <RecordInlineReturnDialog
      open
      onClose={jest.fn()}
      customerId="cust-1"
      orderId="order-1"
      customerName="Walk-in"
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
  await screen.findByText(/check the return/i);
}
const captureOk = (data: unknown = RECORD) => act(() => lastCall(captureMutate)[1].onSuccess(data));
const confirmBtn = (re: RegExp) => screen.getByRole("button", { name: re });

beforeEach(() => {
  jest.clearAllMocks();
  quotePending = false;
  capturePending = false;
});

describe("choice block visibility", () => {
  it("named customer, fully paid: Store credit is the default; Refund shows the quoted amount", async () => {
    await toQuote(quote());
    expect(screen.getByText("How should the money go back to the customer?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Store credit" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Refund $12.40" })).not.toBeChecked();
    expect(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i)).toBeInTheDocument();
  });

  it("not fully paid: no choice block, today's dialog exactly", async () => {
    await toQuote(quote({ canRefund: false, paidInFull: false }));
    expect(screen.queryByText(/refund the money/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: /store credit/i })).toBeNull();
    expect(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i)).toBeInTheDocument();
  });

  it("customer-detail entry (no allowRefund): no choice block even when canRefund", async () => {
    await toQuote(quote(), { allowRefund: false, orderId: "order-1" });
    expect(screen.queryByText(/refund the money/i)).toBeNull();
    expect(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i)).toBeInTheDocument();
  });

  it("walk-in: no one-option radio; one sentence, Refund by, and the button (mm-ux #3748 fix 1)", async () => {
    await toQuote(quote({ customerIsWalkIn: true }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("group", { name: REFUND_COPY.heading })).toBeNull();
    expect(
      screen.getAllByText("Walk-in sales can't hold store credit, so refund the money."),
    ).toHaveLength(1);
    expect(screen.getByLabelText("Refund by")).toHaveValue("CASH");
    expect(confirmBtn(/^take back items and refund \$12\.40$/i)).toBeInTheDocument();
    // said once: not again as the outcome note, the radio label or the hand-back line
    expect(screen.queryByText(/goes back to the customer/i)).toBeNull();
    expect(screen.queryByText(/hand \$12\.40 back/i)).toBeNull();
    expect(screen.queryByText(/^Refund \$12\.40$/)).toBeNull();
  });

  it("W21b: the quote note follows the choice (credit note vs refund; no choice block = unchanged)", async () => {
    await toQuote(quote());
    expect(screen.getByText(/is given as store credit for/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(screen.queryByText(/store credit for/i)).toBeNull();
    // Refund: the hand-back line says it once (no second "goes back" sentence)
    expect(screen.getByText("Hand $12.40 back to the customer.")).toBeInTheDocument();
    expect(screen.queryByText(/goes back to the customer/i)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Store credit" }));
    expect(screen.getByText(/is given as store credit for/i)).toBeInTheDocument();
    expect(screen.queryByText(/hand \$12\.40 back/i)).toBeNull();
  });

  it("W-712: the note and button name the real amount and where it goes (credit vs refund)", async () => {
    await toQuote(quote());
    expect(screen.getByText("$12.40 is given as store credit for Acme Foods.")).toBeInTheDocument();
    expect(confirmBtn(/^take back items and give \$12\.40 store credit$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(screen.getByText("Hand $12.40 back to the customer.")).toBeInTheDocument();
    expect(confirmBtn(/^take back items and refund \$12\.40$/i)).toBeInTheDocument();
    expect(screen.queryByText(/credit note/i)).toBeNull();
  });

  it("W21b: with no choice block the credit line is today's", async () => {
    await toQuote(quote({ canRefund: false, paidInFull: false }));
    expect(screen.getByText(/is given as store credit for/i)).toBeInTheDocument();
  });

  it("W21b: walk-in (Refund preselected) never shows a credit line", async () => {
    await toQuote(quote({ customerIsWalkIn: true }));
    expect(screen.queryByText(/store credit for/i)).toBeNull();
    expect(screen.queryByText(/credit note/i)).toBeNull();
  });

  it("W21b: closing hands focus to onCloseAutoFocus (the opener restores it)", async () => {
    const onCloseAutoFocus = jest.fn((e: Event) => e.preventDefault());
    const props = {
      onClose: jest.fn(),
      customerId: "cust-1",
      orderId: "order-1",
      allowRefund: true,
      onCloseAutoFocus,
    };
    const { rerender } = renderWithProviders(<RecordInlineReturnDialog open {...props} />);
    await screen.findByText(/what came back/i);
    rerender(<RecordInlineReturnDialog open={false} {...props} />);
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled());
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
  it("Train 4: once the refund is confirmed the success screen offers the slip for THAT return (auto-print follows the device preference)", async () => {
    refundReturn.mockResolvedValue({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund \$12\.40$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText(
      "Refunded $12.40 to the card. Give it back on the customer's card at the terminal.",
    );
    const slip = await screen.findByTestId("slip-action");
    expect(slip).toHaveAttribute("data-return-id", "ret-1");
    expect(slip).toHaveAttribute("data-auto", "false"); // the auto-print preference is off by default
  });

  it("Train 4: no slip is offered while the refund is still pending (failed refund)", async () => {
    refundReturn.mockRejectedValue({ response: { status: 500, data: {} } });
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund \$12\.40$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await waitFor(() => expect(refundReturn).toHaveBeenCalled());
    expect(screen.queryByTestId("slip-action")).toBeNull();
  });

  it("captures with resolution REFUND then POSTs the refund with tender + expectedAmount", async () => {
    refundReturn.mockResolvedValue({});
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund \$12\.40$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].resolution).toBe("REFUND");
    captureOk();
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    expect(refundReturn).toHaveBeenCalledWith("ret-1", { tender: "CARD", expectedAmount: 12.4 });
    await screen.findByText(
      "Refunded $12.40 to the card. Give it back on the customer's card at the terminal.",
    );
    expect(onRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ret-1" }),
      expect.objectContaining({ resolution: "REFUND", tender: "CARD", amount: 12.4 }),
    );
  });

  it("cash success copy", async () => {
    refundReturn.mockResolvedValue({});
    await refundFlow(quote({ paidMethods: ["CASH"] }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalled());
    captureOk();
    await screen.findByText("Refunded $12.40 in cash. Hand it back to the customer.");
  });

  it("store credit with the block sends resolution STORE_CREDIT and never refunds", async () => {
    const { onRecorded } = await toQuote(quote());
    fireEvent.click(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].resolution).toBe("STORE_CREDIT");
    captureOk({ ...RECORD, creditNoteId: "cn-1" });
    await screen.findByText(/return recorded/i);
    expect(refundReturn).not.toHaveBeenCalled();
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ id: "ret-1" }), {
      resolution: "STORE_CREDIT",
      amount: 12.4,
    });
  });

  it("hidden block: capture request carries no resolution field (today's payload)", async () => {
    const { onRecorded } = await toQuote(quote({ canRefund: false }));
    fireEvent.click(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect("resolution" in captureMutate.mock.calls[0][0]).toBe(false);
    // a not-fully-paid sale is credited too: the caller still learns it was store credit, and how much
    captureOk({ ...RECORD, creditNoteId: "cn-1" });
    await screen.findByText(/return recorded/i);
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ id: "ret-1" }), {
      resolution: "STORE_CREDIT",
      amount: 12.4,
    });
  });

  it("double-click: one capture, one refund, same key", async () => {
    let release!: () => void;
    refundReturn.mockReturnValue(new Promise<void>((r) => (release = r)));
    await refundFlow();
    const btn = confirmBtn(/^take back items and refund/i);
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
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine("Return recorded. Refund didn't go through. Try again.");
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry refund" }));
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(captureMutate).toHaveBeenCalledTimes(1);
    expect(refundReturn.mock.calls[1]).toEqual(refundReturn.mock.calls[0]);
    await screen.findByText(/^Refunded \$12\.40/);
  });

  it("SA-749r2 #9: a cash refund over the sale's cash gets fixed copy; the clerk switches to Card and retries, or gives store credit", async () => {
    refundReturn
      .mockRejectedValueOnce(apiErr(409, "REFUND_EXCEEDS_CASH_PAID"))
      .mockResolvedValueOnce({});
    await refundFlow(quote({ paidMethods: ["CASH"] }));
    expect(screen.getByLabelText("Refund by")).toHaveValue("CASH");
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine(REFUND_COPY.exceedsCash);
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
    expect(screen.getByRole("button", { name: "Give store credit instead" })).toBeInTheDocument();
    // the tender can be changed on this refusal (it is the way out), then only the refund is re-POSTed
    const select = screen.getByLabelText("Refund by");
    expect(select).not.toBeDisabled();
    fireEvent.change(select, { target: { value: "CARD" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry refund" }));
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(refundReturn.mock.calls[1]).toEqual(["ret-1", { tender: "CARD", expectedAmount: 12.4 }]);
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("SA-750r3: a refund dated inside a closed day gets its own fixed copy; Retry is not offered, store credit is", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(409, "COUNTER_SALE_DAY_CLOSED"));
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine(REFUND_COPY.dayClosed);
    expect(REFUND_COPY.dayClosed).toBe(
      "Return recorded. This day is closed, so the refund can't be paid out now. Give store credit instead, or open the return and record the refund on a later date.",
    );
    expect(document.body.textContent).not.toContain("SERVER RAW TEXT");
    expect(document.body.textContent).not.toContain("Refund didn't go through");
    // a retry would be refused again: only store credit (or closing) is the way out
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
    expect(screen.getByRole("button", { name: "Give store credit instead" })).toBeInTheDocument();
    expect(refundReturn).toHaveBeenCalledTimes(1);
    // closing leaves the saved return reported as a pending refund (nothing was paid out)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!,
    );
    expect(onRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ret-1" }),
      expect.objectContaining({ resolution: "REFUND", pending: true }),
    );
  });

  it("SA-959 stop rule: a walk-in whose refund failed gets Retry refund and NEVER Give store credit instead (found by the error-state retake)", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(500));
    await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine(REFUND_COPY.failed);
    expect(screen.getByRole("button", { name: "Retry refund" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Give store credit instead" })).toBeNull();
    expect(storeCreditInstead).not.toHaveBeenCalled();
  });

  it("SA-959: a walk-in over the sale's cash is told to refund the rest by card or check, with no store credit offered", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(409, "REFUND_EXCEEDS_CASH_PAID"));
    await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine(REFUND_COPY.exceedsCashWalkIn);
    expect(REFUND_COPY.exceedsCashWalkIn).not.toMatch(/store credit/i);
    expect(screen.queryByRole("button", { name: "Give store credit instead" })).toBeNull();
  });

  it("SA-750r3: a walk-in (no store credit) on a closed day is told only the later date, with no store-credit button", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(409, "COUNTER_SALE_DAY_CLOSED"));
    await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] })); // a walk-in has no radio: Refund is the only way
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine(REFUND_COPY.dayClosedWalkIn);
    expect(REFUND_COPY.dayClosedWalkIn).not.toMatch(/store credit/i);
    expect(screen.queryByRole("button", { name: "Give store credit instead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Close" }).some((b) => b.textContent === "Close"),
    ).toBe(true);
  });

  it("REFUND_AMOUNT_CHANGED re-quotes and needs a fresh confirm with the new amount", async () => {
    refundReturn
      .mockRejectedValueOnce(apiErr(409, "REFUND_AMOUNT_CHANGED"))
      .mockResolvedValueOnce({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("The refund amount changed. Check it and confirm again.");
    // a fresh quote was requested; no automatic second refund
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(2));
    expect(refundReturn).toHaveBeenCalledTimes(1);
    act(() => lastCall(quoteMutate)[1].onSuccess(quote({ total: 10.0, paidMethods: ["CARD"] })));
    const btn = await screen.findByRole("button", {
      name: /^take back items and refund \$10\.00$/i,
    });
    fireEvent.click(btn);
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(refundReturn.mock.calls[1]).toEqual(["ret-1", { tender: "CARD", expectedAmount: 10 }]);
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("a 409 carrying the server amount shows it, makes no re-quote, and re-POSTs with that amount", async () => {
    refundReturn
      .mockRejectedValueOnce({
        response: { status: 409, data: { code: "REFUND_AMOUNT_CHANGED", amount: 10 } },
      })
      .mockResolvedValueOnce({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("The refund amount changed. Check it and confirm again.");
    const btn = await screen.findByRole("button", {
      name: /^take back items and refund \$10\.00$/i,
    });
    expect(quoteMutate).toHaveBeenCalledTimes(1);
    fireEvent.click(btn);
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(refundReturn.mock.calls[1]).toEqual(["ret-1", { tender: "CARD", expectedAmount: 10 }]);
    expect(captureMutate).toHaveBeenCalledTimes(1);
    expect(quoteMutate).toHaveBeenCalledTimes(1);
  });

  it("row 182: after a 409 carrying the server amount the quote's Total shows that figure too, not the stale one", async () => {
    refundReturn.mockRejectedValueOnce({
      response: { status: 409, data: { code: "REFUND_AMOUNT_CHANGED", amount: 10 } },
    });
    await refundFlow();
    expect(screen.getByText("Total").parentElement).toHaveTextContent("$12.40");
    expect(screen.getByText("Subtotal")).toBeInTheDocument();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByRole("button", { name: /^take back items and refund \$10\.00$/i });
    await waitFor(() =>
      expect(screen.getByText("Total").parentElement).toHaveTextContent("$10.00"),
    );
    expect(screen.getByText("Total").parentElement).not.toHaveTextContent("$12.40");
    // the old breakdown would no longer add up to the new total: it is hidden, never left contradicting it
    expect(screen.queryByText("Subtotal")).toBeNull();
    expect(screen.queryByText("Tax")).toBeNull();
  });

  it("a second 409 with a different amount updates the confirm again, still without a re-quote", async () => {
    const changed = (amount: number) => ({
      response: { status: 409, data: { code: "REFUND_AMOUNT_CHANGED", amount } },
    });
    refundReturn
      .mockRejectedValueOnce(changed(10))
      .mockRejectedValueOnce(changed(9.5))
      .mockResolvedValueOnce({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(
      await screen.findByRole("button", { name: /^take back items and refund \$10\.00$/i }),
    );
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    expect(refundReturn.mock.calls[1][1].expectedAmount).toBe(10);
    fireEvent.click(
      await screen.findByRole("button", { name: /^take back items and refund \$9\.50$/i }),
    );
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(3));
    expect(refundReturn.mock.calls[2][1].expectedAmount).toBe(9.5);
    expect(quoteMutate).toHaveBeenCalledTimes(1);
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("a 409 with an amount then a 409 without one re-quotes, and the re-quote beats the stale server amount", async () => {
    refundReturn
      .mockRejectedValueOnce({
        response: { status: 409, data: { code: "REFUND_AMOUNT_CHANGED", amount: 10 } },
      })
      .mockRejectedValueOnce(apiErr(409, "REFUND_AMOUNT_CHANGED"))
      .mockResolvedValueOnce({});
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(
      await screen.findByRole("button", { name: /^take back items and refund \$10\.00$/i }),
    );
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(2));
    // the second 409 carries no usable amount: fall back to a re-quote
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(2));
    act(() => lastCall(quoteMutate)[1].onSuccess(quote({ total: 9.0, paidMethods: ["CARD"] })));
    const btn = await screen.findByRole("button", {
      name: /^take back items and refund \$9\.00$/i,
    });
    fireEvent.click(btn);
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(3));
    expect(refundReturn.mock.calls[2]).toEqual(["ret-1", { tender: "CARD", expectedAmount: 9 }]);
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("RETURN_ALREADY_RESOLVED shows fixed copy and offers no retry", async () => {
    refundReturn.mockRejectedValue(apiErr(409, "RETURN_ALREADY_RESOLVED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalled());
    captureOk();
    await screen.findByText("This return is already done. Nothing more was refunded.");
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  });

  it("403 shows fixed permission copy, never the server text", async () => {
    refundReturn.mockRejectedValue(apiErr(403));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalled());
    captureOk();
    await screen.findByText("You don't have permission to refund this return.");
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
    // terminal: no retry, and no confirm that would capture again
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^take back items and refund/i })).toBeNull();
    // the footer Close (the modal X also carries aria-label "Close")
    expect(
      screen.getAllByRole("button", { name: "Close" }).some((b) => b.textContent === "Close"),
    ).toBe(true);
  });

  it.each([
    [
      "REFUND_NEEDS_PAID_INVOICE",
      "Return recorded. This sale isn't fully paid, so it can't be refunded. Give store credit from the order instead.",
    ],
    ["RETURN_REFUNDED_CASH", "This return was already refunded. Nothing more was refunded."],
    ["RETURN_NOT_REFUNDABLE", "There's nothing to refund on this return."],
  ])("409 %s shows fixed copy, no retry, Close only", async (code, copy) => {
    refundReturn.mockRejectedValue(apiErr(409, code));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine(copy);
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
    // the footer Close (the modal X also carries aria-label "Close")
    expect(
      screen.getAllByRole("button", { name: "Close" }).some((b) => b.textContent === "Close"),
    ).toBe(true);
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("after capture the refund and the receipt use the server's refundAmount, not the quote", async () => {
    refundReturn.mockResolvedValue({});
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund \$12\.40$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk({ ...RECORD, refundAmount: "11.9000" });
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    expect(refundReturn).toHaveBeenCalledWith("ret-1", { tender: "CARD", expectedAmount: 11.9 });
    await screen.findByText(
      "Refunded $11.90 to the card. Give it back on the customer's card at the terminal.",
    );
    expect(onRecorded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolution: "REFUND", amount: 11.9 }),
    );
  });

  it("store credit: the receipt credit uses the server's refundAmount when present", async () => {
    const { onRecorded } = await toQuote(quote());
    fireEvent.click(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk({ ...RECORD, creditNoteId: "cn-1", refundAmount: "11.9000" });
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    expect(onRecorded).toHaveBeenCalledWith(expect.anything(), {
      resolution: "STORE_CREDIT",
      amount: 11.9,
    });
  });

  it("closing after a saved return whose refund failed reports a pending refund", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    const onClose = jest.fn();
    const { onRecorded } = await toQuote(quote({ paidMethods: ["CARD"] }), { onClose });
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine("Return recorded. Refund didn't go through. Try again.");
    // the modal's X (aria-label "Close", no text)
    const x = screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "");
    fireEvent.click(x as HTMLElement);
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ id: "ret-1" }), {
      resolution: "REFUND",
      tender: "CARD",
      amount: 12.4,
      pending: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("Back is hidden once the return is saved", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    await refundFlow();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await findLine("Return recorded. Refund didn't go through. Try again.");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("the choice locks while the capture is in flight", async () => {
    await refundFlow();
    capturePending = true;
    fireEvent.click(screen.getByRole("radio", { name: "Store credit" }));
    expect(screen.getByRole("radio", { name: "Store credit" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^refund/i })).toBeDisabled();
  });

  it("confirm is disabled while a re-quote is in flight", async () => {
    await refundFlow();
    quotePending = true;
    fireEvent.click(screen.getByRole("radio", { name: "Store credit" }));
    expect(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i)).toBeDisabled();
  });

  it("RETURN_ALREADY_RESOLVED after a retry says to check before handing anything over", async () => {
    refundReturn
      .mockRejectedValueOnce(apiErr(500))
      .mockRejectedValueOnce(apiErr(409, "RETURN_ALREADY_RESOLVED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(await screen.findByRole("button", { name: "Retry refund" }));
    await screen.findByText(
      "This refund is already recorded. Check the return before handing anything over.",
    );
    expect(screen.queryByText(/nothing more was refunded/i)).toBeNull();
  });

  it("the choice is a fieldset with a legend", async () => {
    await refundFlow();
    expect(
      screen.getByRole("group", { name: "How should the money go back to the customer?" }),
    ).toBeInTheDocument();
  });

  it("refund pending: 'Give store credit instead' credits the saved return, never re-captures", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    storeCreditInstead.mockResolvedValue({
      ...RECORD,
      creditNoteId: "cn-1",
      refundAmount: "12.4000",
    });
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(await screen.findByRole("button", { name: "Give store credit instead" }));
    await waitFor(() => expect(storeCreditInstead).toHaveBeenCalledWith("ret-1"));
    await waitFor(() =>
      expect(onRecorded).toHaveBeenCalledWith(expect.anything(), {
        resolution: "STORE_CREDIT",
        amount: 12.4,
      }),
    );
    expect(captureMutate).toHaveBeenCalledTimes(1);
    expect(refundReturn).toHaveBeenCalledTimes(1);
  });

  it("refund pending: store credit refused as already resolved is terminal", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    storeCreditInstead.mockRejectedValue(apiErr(409, "RETURN_ALREADY_RESOLVED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(await screen.findByRole("button", { name: "Give store credit instead" }));
    await screen.findByText(
      "This refund is already recorded. Check the return before handing anything over.",
    );
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give store credit instead" })).toBeNull();
  });

  it("SA-727a: a retry answered 200 with the stored result is success (receipt + refund recorded)", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(500)).mockResolvedValueOnce({
      ...RECORD,
      refundTender: "CARD",
      refundPending: false,
    });
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk({ ...RECORD, refundAmount: null });
    fireEvent.click(await screen.findByRole("button", { name: "Retry refund" }));
    await screen.findByText(
      "Refunded $12.40 to the card. Give it back on the customer's card at the terminal.",
    );
    expect(refundReturn).toHaveBeenNthCalledWith(2, "ret-1", {
      tender: "CARD",
      expectedAmount: 12.4,
    });
    expect(onRecorded).toHaveBeenCalledWith(expect.anything(), {
      resolution: "REFUND",
      tender: "CARD",
      amount: 12.4,
    });
    expect(screen.queryByText(/already recorded|already done/i)).toBeNull();
  });

  it("refund 403 with code REFUND_NOT_ALLOWED: fixed permission copy, terminal", async () => {
    refundReturn.mockRejectedValue(apiErr(403, "REFUND_NOT_ALLOWED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("You don't have permission to refund this return.");
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  });

  it.each([
    ["coded", "REFUND_NOT_ALLOWED"],
    ["plain (guard-level)", undefined],
  ])("a %s 403 on the REFUND capture shows the fixed refund-permission copy", async (_k, code) => {
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    act(() => lastCall(captureMutate)[1].onError(apiErr(403, code)));
    await screen.findByText("You don't have permission to refund this return.");
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
    expect(screen.queryByText(/returns.*not.*enabled|not enabled/i)).toBeNull();
    expect(refundReturn).not.toHaveBeenCalled();
  });

  it("a 403 on 'Give store credit instead' is terminal with the fixed copy", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    storeCreditInstead.mockRejectedValue(apiErr(403, "REFUND_NOT_ALLOWED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(await screen.findByRole("button", { name: "Give store credit instead" }));
    await screen.findByText("You don't have permission to refund this return.");
    expect(screen.queryByRole("button", { name: "Give store credit instead" })).toBeNull();
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
  });

  it("(c) a pending REFUND capture (refundAmount null, refundPending) refunds the quoted amount", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    const onClose = jest.fn();
    const { onRecorded } = await toQuote(quote({ paidMethods: ["CASH"] }), { onClose });
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk({ ...RECORD, status: "RECEIVED", refundAmount: null, refundPending: true });
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    expect(refundReturn).toHaveBeenCalledWith("ret-1", { tender: "CASH", expectedAmount: 12.4 });
    const x = screen.getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "");
    fireEvent.click(x as HTMLElement);
    expect(onRecorded).toHaveBeenCalledWith(expect.anything(), {
      resolution: "REFUND",
      tender: "CASH",
      amount: 12.4,
      pending: true,
    });
  });

  it.each([
    ["403", apiErr(403, "REFUND_NOT_ALLOWED")],
    ["REFUND_NEEDS_PAID_INVOICE", apiErr(409, "REFUND_NEEDS_PAID_INVOICE")],
    ["RETURN_NOT_REFUNDABLE", apiErr(409, "RETURN_NOT_REFUNDABLE")],
  ])(
    "saved return + refund refused (%s): closing reports the refund as pending",
    async (_k, err) => {
      refundReturn.mockRejectedValue(err);
      const onClose = jest.fn();
      const { onRecorded } = await toQuote(quote({ paidMethods: ["CARD"] }), { onClose });
      fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
      fireEvent.click(confirmBtn(/^take back items and refund/i));
      await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
      captureOk();
      await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
      const footerClose = await screen.findAllByRole("button", { name: "Close" });
      fireEvent.click(footerClose.find((b) => b.textContent === "Close") as HTMLElement);
      expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ id: "ret-1" }), {
        resolution: "REFUND",
        tender: "CARD",
        amount: 12.4,
        pending: true,
      });
    },
  );

  it.each([
    ["REFUND_NEEDS_PAID_INVOICE", true],
    ["RETURN_NOT_REFUNDABLE", true],
    ["403", false],
  ])("after %s the saved return offers store credit instead: %s", async (code, offered) => {
    refundReturn.mockRejectedValue(code === "403" ? apiErr(403) : apiErr(409, code));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    await screen.findAllByRole("button", { name: "Close" });
    expect(!!screen.queryByRole("button", { name: "Give store credit instead" })).toBe(offered);
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  });

  it("a failed re-quote after REFUND_AMOUNT_CHANGED shows the failed copy and never re-enables confirm on the old amount", async () => {
    refundReturn.mockRejectedValue(apiErr(409, "REFUND_AMOUNT_CHANGED"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(2));
    // while the re-quote is in flight the confirm stays disabled
    expect(confirmBtn(/^take back items and refund/i)).toBeDisabled();
    act(() => lastCall(quoteMutate)[1].onError?.(new Error("network")));
    await findLine("Return recorded. Refund didn't go through. Try again.");
    const confirm = screen.queryByRole("button", { name: /^take back items and refund/i });
    expect(confirm === null || (confirm as HTMLButtonElement).disabled).toBe(true);
    expect(refundReturn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [["CREDIT_CARD"], "CARD"],
    [["CHECK", "CREDIT_CARD"], "CHECK"],
    [["CASH"], "CASH"],
    [["ACH"], "CASH"],
    [[], "CASH"],
  ])("SA-727: paidMethods %j (PaymentMethod values) preselects %s", async (methods, expected) => {
    refundReturn.mockResolvedValue({});
    await refundFlow(quote({ paidMethods: methods as string[] }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await waitFor(() => expect(refundReturn).toHaveBeenCalledTimes(1));
    expect(refundReturn.mock.calls[0][1].tender).toBe(expected);
  });

  it("F4: paidWithStoreCredit shows the refund as unavailable with fixed copy, store credit preselected", async () => {
    await toQuote(quote({ canRefund: false, paidWithStoreCredit: true }));
    expect(
      screen.getByText("Paid with store credit, so it goes back as store credit"),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Store credit" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^refund/i })).toBeDisabled();
    fireEvent.click(confirmBtn(/^take back items and give \$[\d.]+ store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    expect(captureMutate.mock.calls[0][0].resolution).toBe("STORE_CREDIT");
  });

  it("F4: a refund answered 409 REFUND_PAID_WITH_STORE_CREDIT shows the fixed copy and offers store credit", async () => {
    refundReturn.mockRejectedValue(apiErr(409, "REFUND_PAID_WITH_STORE_CREDIT"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("Paid with store credit, so it goes back as store credit");
    expect(screen.getByRole("button", { name: "Give store credit instead" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
    expect(screen.queryByText("SERVER RAW TEXT")).toBeNull();
  });

  it("SA-727 (b): a store-credit retry answered 200 with the row is success", async () => {
    refundReturn.mockRejectedValue(apiErr(500));
    storeCreditInstead
      .mockRejectedValueOnce(apiErr(500))
      .mockResolvedValueOnce({ ...RECORD, creditNoteId: "cn-1", refundAmount: "12.4000" });
    const { onRecorded } = await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    fireEvent.click(await screen.findByRole("button", { name: "Give store credit instead" }));
    await waitFor(() => expect(storeCreditInstead).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Give store credit instead" }));
    await waitFor(() =>
      expect(onRecorded).toHaveBeenCalledWith(expect.anything(), {
        resolution: "STORE_CREDIT",
        amount: 12.4,
      }),
    );
    expect(captureMutate).toHaveBeenCalledTimes(1);
  });

  it("SA-727 (c): a capture retry after a failure resends the byte-identical body (same key, same resolution)", async () => {
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    act(() => lastCall(captureMutate)[1].onError(apiErr(500)));
    fireEvent.click(await screen.findByRole("button", { name: /^back$/i }));
    // the choice is locked once a capture was sent with this key
    expect(screen.getByRole("radio", { name: "Store credit" })).toBeDisabled();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(captureMutate.mock.calls[1][0])).toBe(
      JSON.stringify(captureMutate.mock.calls[0][0]),
    );
  });
});

describe("W-712 credit words per host (SA-929)", () => {
  it("Returns page / order detail: neutral store-credit line, no 'next order' next to the apply-to choice", async () => {
    await toQuote(quote());
    expect(screen.getByText("$12.40 is given as store credit for Acme Foods.")).toBeInTheDocument();
    expect(screen.queryByText(/next order/i)).toBeNull();
  });

  it("counter (settled sale): the credit is for the next order", async () => {
    await toQuote(quote(), { sourceOrderId: "order-1" });
    expect(
      screen.getByText("$12.40 is given as store credit for Acme Foods, to use on the next order."),
    ).toBeInTheDocument();
  });

  it("names ending in s need no possessive", async () => {
    await toQuote(quote(), { customerName: "Acme Foods Inc" });
    expect(
      screen.getByText("$12.40 is given as store credit for Acme Foods Inc."),
    ).toBeInTheDocument();
  });

  it("SA-959: a walk-in that cannot be refunded is refused with the way forward: no credit note, no take-back button", async () => {
    renderWithProviders(
      <RecordInlineReturnDialog
        open
        onClose={jest.fn()}
        customerId="cust-1"
        orderId="order-1"
        customerName="Walk-in"
        allowRefund
      />,
    );
    await screen.findByText(/what came back/i);
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() =>
      lastCall(quoteMutate)[1].onSuccess(
        quote({ customerIsWalkIn: true, canRefund: false, paidInFull: false }),
      ),
    );
    expect(
      await screen.findByText("This sale can't be refunded here. Ask office staff to refund it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /take back items/i })).toBeNull();
    expect(screen.queryByText(/credit note|store credit/i)).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(captureMutate).not.toHaveBeenCalled();
  });

  it("SA-959: a walk-in on a host that offers no refund (allowRefund off) is refused the same way, never sent as store credit", async () => {
    renderWithProviders(
      <RecordInlineReturnDialog
        open
        onClose={jest.fn()}
        customerId="cust-1"
        orderId="order-1"
        customerName="Walk-in"
      />,
    );
    await screen.findByText(/what came back/i);
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
    act(() => lastCall(quoteMutate)[1].onSuccess(quote({ customerIsWalkIn: true })));
    expect(
      await screen.findByText("This sale can't be refunded here. Ask office staff to refund it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /take back items/i })).toBeNull();
  });

  it("SA-959 + mm-ux 93.8%: the refusal is the step's main message and the Reason select is gone", async () => {
    await toRefusalQuote(quote({ customerIsWalkIn: true, canRefund: false, paidInFull: false }));
    const msg = await screen.findByText(
      "This sale can't be refunded here. Ask office staff to refund it.",
    );
    expect(msg).toHaveAttribute("role", "status"); // a message, not a grey footnote under Total
    expect(msg.className).not.toMatch(/text-xs/);
    expect(screen.queryByLabelText(/^reason$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /take back items/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("mm-ux 93.8%: the named case's credit sentence sits with the radio, not under the Total", async () => {
    await toQuote(quote());
    const sentence = "$12.40 is given as store credit for Acme Foods.";
    const choice = screen.getByRole("group", { name: REFUND_COPY.heading });
    expect(within(choice).getByText(sentence)).toBeInTheDocument();
    const total = screen.getByText("Total").closest("div.rounded-lg") as HTMLElement;
    expect(within(total).queryByText(sentence)).toBeNull();
    // it follows the radio: choosing Refund replaces it with the hand-back line (one sentence, not two)
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(within(choice).queryByText(sentence)).toBeNull();
    expect(within(choice).getByText("Hand $12.40 back to the customer.")).toBeInTheDocument();
  });

  it("named customer: the Store credit / Refund choice is unchanged, with brand-coloured radios", async () => {
    await toQuote(quote());
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r.className).toMatch(/accent-brand/);
  });
});

describe("SA-929: the words after submit come from the server's answer", () => {
  it("a refund the server recorded differently (amount, tender) is what the success screen and onRecorded say", async () => {
    refundReturn.mockResolvedValue({
      ...RECORD,
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: "11.5000",
      refundTender: "CHECK",
    });
    const { onRecorded } = await refundFlow(); // client: $12.40 on CARD
    fireEvent.click(confirmBtn(/^take back items and refund \$12\.40$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("Refunded $11.50 by check. Hand it back to the customer.");
    expect(screen.queryByText(/12\.40/)).toBeNull();
    expect(onRecorded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolution: "REFUND", tender: "CHECK", amount: 11.5 }),
    );
  });

  it("a store-credit answer reads 'given as store credit' with the server's figure", async () => {
    const { onRecorded } = await toQuote(quote());
    fireEvent.click(confirmBtn(/^take back items and give \$12\.40 store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk({ ...RECORD, creditNoteId: "cn-1", refundAmount: "10.0000" });
    await screen.findByText("$10.00 given as store credit.");
    expect(onRecorded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolution: "STORE_CREDIT", amount: 10 }),
    );
  });

  it("a capture the server already refunded is worded as a refund, not as the client's store-credit choice", async () => {
    const { onRecorded } = await toQuote(quote());
    fireEvent.click(confirmBtn(/^take back items and give \$12\.40 store credit$/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk({
      ...RECORD,
      refundMethod: "EXTERNAL_REFUND",
      refundedAt: "2026-10-24T10:00:00.000Z",
      refundAmount: "12.4000",
    });
    expect(onRecorded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolution: "REFUND", amount: 12.4 }),
    );
  });

  it("409 REFUND_AMOUNT_CHANGED: the hand-back line (not only the button) shows the server's figure", async () => {
    refundReturn.mockRejectedValueOnce({
      response: { status: 409, data: { code: "REFUND_AMOUNT_CHANGED", amount: 10 } },
    });
    await refundFlow();
    expect(screen.getByText(/Give \$12\.40 back on the customer's card/)).toBeInTheDocument();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByRole("button", { name: /^take back items and refund \$10\.00$/i });
    expect(screen.getByText(/Give \$10\.00 back on the customer's card/)).toBeInTheDocument();
    expect(screen.queryByText(/Give \$12\.40 back/)).toBeNull();
  });
});

describe("mm-ux retake: error states say one thing, once", () => {
  const refusal = (message: string) => ({
    response: { status: 409, data: { code: "RETURN_EXCEEDS_SOLD", message } },
  });
  const openToLines = async (props: Record<string, unknown> = {}) => {
    renderWithProviders(
      <RecordInlineReturnDialog
        open
        onClose={jest.fn()}
        customerId="cust-1"
        orderId="order-1"
        customerName="Walk-in"
        allowRefund
        {...props}
      />,
    );
    await screen.findByText(/what came back/i);
    fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(1));
  };
  const footerButtons = (name: string) =>
    screen.queryAllByRole("button", { name }).filter((b) => b.textContent === name);

  it("a refused quote (a 409 with its own sentence) shows that sentence and Back, with no Close", async () => {
    await openToLines();
    act(() =>
      lastCall(quoteMutate)[1].onError(refusal("Cola 12oz Can: only 2 were sold on this order.")),
    );
    expect(
      await screen.findByText("Cola 12oz Can: only 2 were sold on this order."),
    ).toBeInTheDocument();
    expect(footerButtons("Back")).toHaveLength(1);
    expect(footerButtons("Close")).toHaveLength(0);
  });

  it.each([
    ["a 500", { response: { status: 500, data: { message: "Internal server error" } } }],
    ["no answer at all", new Error("Network Error")],
  ])("%s on the quote: one fixed sentence and a Try again that asks again", async (_n, err) => {
    await openToLines();
    act(() => lastCall(quoteMutate)[1].onError(err));
    expect(await screen.findByText("Couldn't get the quote. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/internal server error/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(quoteMutate).toHaveBeenCalledTimes(2));
  });

  it("'Return recorded.' is not red; only what went wrong is", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(500));
    await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    const saved = await screen.findByText("Return recorded.");
    expect(saved.className).not.toMatch(/danger/);
    expect(screen.getByText("Refund didn't go through. Try again.").className).toMatch(/danger/);
  });

  it("a closed day says WHERE to record the refund on a later date: a link to the saved return", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(409, "COUNTER_SALE_DAY_CLOSED"));
    await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] }));
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    await screen.findByText("Return recorded.");
    expect(document.body.textContent).toMatch(
      /open the return and record the refund on a later date/i,
    );
    expect(screen.getByRole("link", { name: "Open the return" })).toHaveAttribute(
      "href",
      "/returns/ret-1",
    );
  });

  it("named, Refund selected: the hand-back line stays and the duplicate 'goes back' sentence is gone", async () => {
    await toQuote(quote());
    fireEvent.click(screen.getByRole("radio", { name: "Refund $12.40" }));
    expect(screen.getByText("Hand $12.40 back to the customer.")).toBeInTheDocument();
    expect(screen.queryByText(/goes back to the customer/i)).toBeNull();
  });

  it("at 390 the confirm, Retry, Close and Back are 44 px (min-h-11 below sm)", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(500));
    await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] }));
    expect(confirmBtn(/^take back items and refund/i).className).toMatch(/min-h-11/);
    expect(screen.getByRole("button", { name: "Back" }).className).toMatch(/min-h-11/);
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    expect((await screen.findByRole("button", { name: "Retry refund" })).className).toMatch(
      /min-h-11/,
    );
  });
});

describe("SA-972: a walk-in's refund refusals never name store credit", () => {
  const NO_REFUND =
    "Return recorded. This sale can't be refunded here. Ask office staff to refund it.";
  it.each(["REFUND_NEEDS_PAID_INVOICE", "REFUND_PAID_WITH_STORE_CREDIT"])(
    "a 409 %s reads the no-refund sentence, and no store credit is offered or sent",
    async (code) => {
      refundReturn.mockRejectedValueOnce(apiErr(409, code));
      await toQuote(quote({ customerIsWalkIn: true, paidMethods: ["CASH"] }));
      fireEvent.click(confirmBtn(/^take back items and refund/i));
      await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
      captureOk();
      expect(await screen.findByRole("alert")).toHaveTextContent(NO_REFUND);
      expect(screen.getByRole("alert").textContent).not.toMatch(/store credit/i); // the explanatory line may say walk-ins cannot hold it
      expect(screen.queryByRole("button", { name: "Give store credit instead" })).toBeNull();
      expect(storeCreditInstead).not.toHaveBeenCalled();
    },
  );

  it("needsPaid still reads as before for a named customer", async () => {
    refundReturn.mockRejectedValueOnce(apiErr(409, "REFUND_NEEDS_PAID_INVOICE"));
    await refundFlow();
    fireEvent.click(confirmBtn(/^take back items and refund/i));
    await waitFor(() => expect(captureMutate).toHaveBeenCalledTimes(1));
    captureOk();
    expect(
      await screen.findByText(/give store credit from the order instead/i),
    ).toBeInTheDocument();
  });

  it("the walk-in line table is exhaustive and no line in it matches /store credit/i", () => {
    const kinds: RefundErrorKind[] = [
      "changed",
      "resolved",
      "resolvedAfterRetry",
      "forbidden",
      "readOnly",
      "needsPaid",
      "refundedCash",
      "notRefundable",
      "paidWithCredit",
      "exceedsCash",
      "dayClosed",
      "failed",
    ];
    expect(Object.keys(WALK_IN_REFUND_LINE).sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(WALK_IN_REFUND_LINE[k]).not.toMatch(/store credit/i);
  });
});
