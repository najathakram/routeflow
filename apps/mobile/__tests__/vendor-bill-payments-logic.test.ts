/**
 * B288 mobile parity (row 667): a void refused with 409 BILL_HAS_PAYMENTS shows FIXED copy built from
 * the structured `amount` (never the server's message) and offers "Move payments to credit", which posts
 * to POST /vendor-bills/:id/payments/:paymentId/move-to-credit for cash payments only. Mirrors
 * apps/web/lib/api/vendor-bills.bill-has-payments.test.tsx (web copy + endpoint).
 */
import {
  billHasPaymentsCopy,
  canOfferMoveAll,
  billHasPaymentsRefusal,
  isMovableBillPayment,
  movablePayments,
  moveToCreditRequest,
  moveToCreditFailureCopy,
  movePaymentConfirmCopy,
  movePaymentsConfirmCopy,
  movedToCreditCopy,
  voidRefusalCopy,
} from "../lib/vendor-bill-payments-logic";

const refusal = (data: Record<string, unknown>) => ({
  response: {
    status: 409,
    data: { code: "BILL_HAS_PAYMENTS", message: "raw server text", ...data },
  },
});

describe("billHasPaymentsRefusal", () => {
  it("recognises the coded refusal and carries the structured amount", () => {
    expect(billHasPaymentsRefusal(refusal({ amount: 200 }))).toEqual({
      kind: "has-payments",
      amount: 200,
    });
  });

  it("degrades to a null amount when the body has no usable number", () => {
    for (const amount of [undefined, "200", -5, Number.NaN, null]) {
      expect(billHasPaymentsRefusal(refusal({ amount }))).toEqual({
        kind: "has-payments",
        amount: null,
      });
    }
  });

  it("is generic for every other error shape", () => {
    expect(billHasPaymentsRefusal({ response: { status: 409, data: { code: "OTHER" } } })).toEqual({
      kind: "other",
    });
    expect(billHasPaymentsRefusal({ response: { status: 500 } })).toEqual({ kind: "other" });
    expect(billHasPaymentsRefusal(new Error("boom"))).toEqual({ kind: "other" });
    expect(billHasPaymentsRefusal(null)).toEqual({ kind: "other" });
    expect(billHasPaymentsRefusal(undefined)).toEqual({ kind: "other" });
  });
});

describe("billHasPaymentsCopy", () => {
  it("is the web sentence with the amount to the cent", () => {
    expect(billHasPaymentsCopy(200)).toBe(
      "This bill has $200.00 in payments. Move them to a supplier credit first.",
    );
    expect(billHasPaymentsCopy(1234.5)).toBe(
      "This bill has $1234.50 in payments. Move them to a supplier credit first.",
    );
  });

  it("drops the amount when there is none", () => {
    expect(billHasPaymentsCopy(null)).toBe(
      "This bill has payments. Move them to a supplier credit first.",
    );
  });
});

describe("voidRefusalCopy", () => {
  it("never renders the server's message for the has-payments refusal", () => {
    const copy = voidRefusalCopy(refusal({ amount: 200 }));
    expect(copy).toBe("This bill has $200.00 in payments. Move them to a supplier credit first.");
    expect(copy).not.toContain("raw server text");
  });

  it("keeps today's behaviour for other errors: server message, then error message, then fallback", () => {
    expect(voidRefusalCopy({ response: { data: { message: "Server says no" } } })).toBe(
      "Server says no",
    );
    expect(voidRefusalCopy(new Error("Network Error"))).toBe("Network Error");
    expect(voidRefusalCopy({})).toBe("Try again.");
  });
});

describe("isMovableBillPayment", () => {
  it("is offered for cash payments only, never for a credit draw", () => {
    expect(isMovableBillPayment({ method: "CHECK", supplierCreditId: null })).toBe(true);
    expect(isMovableBillPayment({ method: "CASH" })).toBe(true);
    expect(isMovableBillPayment({ method: "CREDIT_NOTE", supplierCreditId: "credit-1" })).toBe(
      false,
    );
    expect(isMovableBillPayment({ method: "CHECK", supplierCreditId: "credit-1" })).toBe(false);
  });

  it("movablePayments filters a list and tolerates a missing one", () => {
    const cash = { id: "p1", amount: 80, method: "CASH", createdAt: "2026-10-01T00:00:00Z" };
    const draw = {
      id: "p2",
      amount: 20,
      method: "CREDIT_NOTE",
      supplierCreditId: "c1",
      createdAt: "2026-10-02T00:00:00Z",
    };
    expect(movablePayments([cash, draw])).toEqual([cash]);
    expect(movablePayments(undefined)).toEqual([]);
  });
});

describe("moveToCreditRequest", () => {
  it("is a bodyless POST to the move-to-credit endpoint web uses", () => {
    expect(moveToCreditRequest("bill-1", "pay-1")).toEqual({
      method: "post",
      url: "/vendor-bills/bill-1/payments/pay-1/move-to-credit",
    });
  });
});

describe("move-to-credit copy", () => {
  it("per-payment confirm names the amount and date, and the next-bill consequence by status", () => {
    const payment = { id: "p1", amount: 200, method: "CASH", createdAt: "2026-10-01T00:00:00Z" };
    const live = movePaymentConfirmCopy(payment, "RECEIVED", "Oct 1, 2026");
    expect(live.title).toBe("Move to supplier credit?");
    expect(live.confirmText).toBe("Move to credit");
    expect(live.message).toContain(
      "$200.00 paid on Oct 1, 2026 comes off this bill and becomes credit with the supplier, dated the same day.",
    );
    expect(live.message).toContain("This bill owes that amount again.");
    const voided = movePaymentConfirmCopy(payment, "VOID", "Oct 1, 2026");
    expect(voided.message).toContain("The credit goes to the next bill from this supplier.");
    expect(voided.message).not.toContain("owes that amount again");
  });

  it("refusal confirm sums the movable payments and uses the action label", () => {
    const copy = movePaymentsConfirmCopy([
      { id: "p1", amount: 80, method: "CASH", createdAt: "2026-10-01T00:00:00Z" },
      { id: "p2", amount: "120.5", method: "CHECK", createdAt: "2026-10-02T00:00:00Z" },
    ]);
    expect(copy.title).toBe("Move payments to credit?");
    expect(copy.confirmText).toBe("Move payments to credit");
    expect(copy.message).toContain("$200.50");
    expect(copy.message).toContain("then void the bill again");
  });

  it("success copy is singular/plural and carries the total", () => {
    expect(movedToCreditCopy(1, 200)).toBe("Payment moved to supplier credit ($200.00)");
    expect(movedToCreditCopy(2, 200.5)).toBe("2 payments moved to supplier credit ($200.50)");
  });

  it("failure copy is fixed for the two coded refusals and never the server message", () => {
    expect(
      moveToCreditFailureCopy({
        response: { data: { code: "BILL_PAYMENT_NOT_CASH", message: "raw" } },
      }),
    ).toBe(
      "That payment is a draw of supplier credit. Voiding or deleting the bill hands it back.",
    );
    expect(
      moveToCreditFailureCopy({
        response: { data: { code: "BILL_PAYMENT_NO_SUPPLIER", message: "raw" } },
      }),
    ).toBe("This bill has no supplier, so there is no account to hold the credit.");
    expect(moveToCreditFailureCopy({ response: { data: { message: "raw" } } })).toBe(
      "Couldn't move the payment. Try again.",
    );
    expect(moveToCreditFailureCopy(new Error("boom"))).toBe(
      "Couldn't move the payment. Try again.",
    );
  });
});

describe("rounding and mixed payments (review nits)", () => {
  it("rounds half-cents through roundMoney, not toFixed", () => {
    expect(movedToCreditCopy(1, 1.005)).toBe("Payment moved to supplier credit ($1.01)");
  });

  const mixed = [
    { id: "a", amount: 80, method: "CASH", supplierCreditId: null },
    { id: "b", amount: 50, method: "CREDIT_NOTE", supplierCreditId: "sc1" },
    { id: "c", amount: "20.25", method: "CHECK", supplierCreditId: null },
  ];

  it("movablePayments drops supplier-credit draws and the confirm total excludes them", () => {
    const movable = movablePayments(mixed);
    expect(movable.map((p) => p.id)).toEqual(["a", "c"]);
    expect(movePaymentsConfirmCopy(movable).message).toContain("$100.25 in payments");
  });

  it("offers move-all only when the cash total equals the server amount", () => {
    const movable = movablePayments(mixed);
    expect(canOfferMoveAll(movable, 100.25)).toBe(true);
    expect(canOfferMoveAll(movable, 150.25)).toBe(false);
    expect(canOfferMoveAll(movable, null)).toBe(false);
    expect(canOfferMoveAll([], 0)).toBe(false);
  });
});
