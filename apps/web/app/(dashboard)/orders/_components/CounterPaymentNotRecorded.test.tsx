import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CounterSaleRequest, CounterSaleResponse } from "@routeflow/types";
import { forgetCounterSale, rememberCounterSale } from "@/lib/counter-last-sale";
import { CounterPaymentNotRecorded } from "./CounterPaymentNotRecorded";

/**
 * SA-837b item 3: the till's escape from a duplicate payment reference. The panel shows only for that cause, names the
 * existing payment in the one shared sentence, and "Record anyway" (staff roles) re-sends the SAME sale (same key, same
 * cart) with the generic `payment.recordAnyway` flag; the answer replaces the receipt.
 */
let mockRole: string | undefined = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u1", role: mockRole } }),
}));
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
}));

const SENTENCE =
  "A payment with this reference was already recorded on Oct 1, 2026 for $2.50 (INV-0042).";
const dto: CounterSaleRequest = {
  walkIn: true,
  items: [{ productId: "p1", qty: 1 }],
  payment: { method: "CHECK", reference: "1042" },
};
const dup = (over: Partial<CounterSaleResponse> = {}): CounterSaleResponse =>
  ({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5,
    paid: 0,
    balanceDue: 2.5,
    method: "CHECK",
    paymentRecorded: false,
    paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
    paymentCauseCode: "DUPLICATE_PAYMENT_REF",
    existingPayment: {
      id: "pay-1",
      paymentNumber: "PAY-A-0001",
      paidAt: "2026-10-01T12:00:00.000Z",
      amount: 2.5,
      invoiceId: "inv-9",
      invoiceNumber: "INV-0042",
    },
    ...over,
  }) as CounterSaleResponse;

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "OPERATOR";
  forgetCounterSale();
  rememberCounterSale("o1", "key-1", dto);
});

describe("CounterPaymentNotRecorded", () => {
  it("shows the shared sentence and Record anyway; the click re-sends the SAME key and cart with payment.recordAnyway", async () => {
    const onReceipt = jest.fn();
    const paid = { ...dup(), paid: 2.5, balanceDue: 0, paymentRecorded: true };
    mutateAsync.mockResolvedValueOnce(paid);
    render(<CounterPaymentNotRecorded receipt={dup()} onReceipt={onReceipt} />);

    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record anyway" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.idempotencyKey).toBe("key-1");
    expect(arg.dto.items).toEqual(dto.items);
    expect(arg.dto.payment).toEqual({ method: "CHECK", reference: "1042", recordAnyway: true });
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining(paid)));
  });

  it("a role that may not use the flag is shown the sentence and no action", () => {
    mockRole = "DRIVER";
    render(<CounterPaymentNotRecorded receipt={dup()} onReceipt={jest.fn()} />);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record anyway" })).toBeNull();
  });

  it("no remembered sale for this receipt (another order's): the sentence shows, there is nothing to re-send", () => {
    render(
      <CounterPaymentNotRecorded receipt={dup({ orderId: "o-other" })} onReceipt={jest.fn()} />,
    );
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record anyway" })).toBeNull();
  });

  it("a failed resend says so, keeps the receipt, and leaves the action to try again", async () => {
    const onReceipt = jest.fn();
    mutateAsync.mockRejectedValueOnce(new Error("boom"));
    render(<CounterPaymentNotRecorded receipt={dup()} onReceipt={onReceipt} />);
    fireEvent.click(screen.getByRole("button", { name: "Record anyway" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be recorded");
    expect(onReceipt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record anyway" })).toBeEnabled();
  });

  it.each([
    ["a recorded payment", dup({ paymentRecorded: true })],
    ["another cause", dup({ paymentCauseCode: undefined, existingPayment: undefined })],
  ])("renders nothing for %s", (_n, receipt) => {
    const { container } = render(
      <CounterPaymentNotRecorded receipt={receipt} onReceipt={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
