import {
  CREDITS_PENDING_COPY,
  creditsPendingFromError,
  creditsPendingFromOrder,
} from "../lib/order-credits-pending";

// B1205: the API saved the order but its credit notes are not applied. Mirrors web's
// creditsPendingOrderId / created.creditsPending handling (B1201).
const err = (status: number, data: unknown) => ({ response: { status, data } });

describe("creditsPendingFromError", () => {
  it("503 ORDER_SAVED_CREDITS_PENDING with an orderId is a saved order", () => {
    expect(
      creditsPendingFromError(err(503, { code: "ORDER_SAVED_CREDITS_PENDING", orderId: "o1" })),
    ).toEqual({ kind: "saved-credits-pending", orderId: "o1", message: CREDITS_PENDING_COPY });
  });

  it("never surfaces the server's own message text", () => {
    const r = creditsPendingFromError(
      err(503, { code: "ORDER_SAVED_CREDITS_PENDING", orderId: "o1", message: "raw server text" }),
    );
    expect(r?.message).toBe(CREDITS_PENDING_COPY);
  });

  it("a plain 503 is unchanged", () => {
    expect(creditsPendingFromError(err(503, { code: "LOCK_UNAVAILABLE" }))).toBeNull();
    expect(creditsPendingFromError(err(503, undefined))).toBeNull();
  });

  it("the code on another status, a missing orderId, or a non-axios error is unchanged", () => {
    expect(
      creditsPendingFromError(err(500, { code: "ORDER_SAVED_CREDITS_PENDING", orderId: "o1" })),
    ).toBeNull();
    expect(creditsPendingFromError(err(503, { code: "ORDER_SAVED_CREDITS_PENDING" }))).toBeNull();
    expect(creditsPendingFromError(new Error("x"))).toBeNull();
    expect(creditsPendingFromError(null)).toBeNull();
  });
});

describe("creditsPendingFromOrder (replay hint)", () => {
  it("creditsPending true with an id shows the copy", () => {
    expect(creditsPendingFromOrder({ id: "o2", creditsPending: true })).toEqual({
      kind: "saved-credits-pending",
      orderId: "o2",
      message: CREDITS_PENDING_COPY,
    });
  });

  it("hint absent, false, or without an id shows nothing", () => {
    expect(creditsPendingFromOrder({ id: "o2" })).toBeNull();
    expect(creditsPendingFromOrder({ id: "o2", creditsPending: false })).toBeNull();
    expect(creditsPendingFromOrder({ creditsPending: true })).toBeNull();
    expect(creditsPendingFromOrder(undefined)).toBeNull();
  });
});

describe("copy", () => {
  it("is the same fixed sentence as web", () => {
    expect(CREDITS_PENDING_COPY).toBe(
      "The order was saved, but the credit notes weren't applied. Apply them on the order.",
    );
  });
});
