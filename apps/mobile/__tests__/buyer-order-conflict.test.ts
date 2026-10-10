import {
  BUYER_ORDER_CONFLICT_COPY,
  BUYER_ORDER_CONFLICT_NO_ID_COPY,
  buyerOrderConflict,
} from "../lib/buyer-order-conflict";

const refusal = (data: unknown, status = 409) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

describe("buyerOrderConflict (mobile)", () => {
  it.each([
    "IDEMPOTENCY_KEY_CONFLICT",
    "IDEMPOTENCY_KEY_CART_MISMATCH",
    "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
  ])("%s with an orderId returns it", (code) => {
    expect(buyerOrderConflict(refusal({ code, orderId: "o-1", message: "raw" }))).toEqual({
      orderId: "o-1",
    });
  });

  it("without a usable orderId returns an empty result", () => {
    expect(buyerOrderConflict(refusal({ code: "IDEMPOTENCY_KEY_CONFLICT" }))).toEqual({});
    expect(buyerOrderConflict(refusal({ code: "IDEMPOTENCY_KEY_CONFLICT", orderId: 7 }))).toEqual(
      {},
    );
  });

  it("returns null for other codes, statuses and non-errors", () => {
    expect(buyerOrderConflict(refusal({ code: "OTHER", orderId: "o-1" }))).toBeNull();
    expect(
      buyerOrderConflict(refusal({ code: "IDEMPOTENCY_KEY_CONFLICT", orderId: "o-1" }, 500)),
    ).toBeNull();
    expect(buyerOrderConflict(new Error("x"))).toBeNull();
    expect(buyerOrderConflict(null)).toBeNull();
  });

  it("exposes fixed copy", () => {
    expect(BUYER_ORDER_CONFLICT_COPY).toBe("Your order was already placed — open it");
    expect(BUYER_ORDER_CONFLICT_NO_ID_COPY).toBe(
      "Your order may already be placed. Check your orders.",
    );
  });
});
