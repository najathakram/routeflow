import {
  createPaymentKeyHolder,
  isPaymentKeyNotFound,
  PAYMENT_STATUS_COPY,
  paymentStatusCopy,
} from "@routeflow/types/payment-submit-key";

/**
 * SA-824 (SA conditions a/b): "Check payment status". While a payment's outcome is unknown the holder
 * keeps and locks its key; a status read BY KEY is the only way out besides a 2xx: found settles as a
 * success, 404 PAYMENT_KEY_NOT_FOUND releases the key, any other error stays unknown.
 */
const mintSeq = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const pay = { amount: 100, method: "CASH", allocations: [{ invoiceId: "i1", amount: 100 }] };
const err = (status?: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("x"), status ? { response: { status, data } } : {});
const notFound = () => err(404, { code: "PAYMENT_KEY_NOT_FOUND" });
const unknownHolder = () => {
  const h = createPaymentKeyHolder(mintSeq());
  h.keyFor(pay);
  h.settle({ ok: false, error: err(503) });
  return h;
};

describe("SA-824 payment status check (shared holder)", () => {
  it("hasUnknown: false fresh, true after an unknown outcome, false after a success or reset", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.hasUnknown()).toBe(false);
    h.keyFor(pay);
    h.settle({ ok: false, error: err() });
    expect(h.hasUnknown()).toBe(true);
    h.reset();
    expect(h.hasUnknown()).toBe(false);
    h.keyFor(pay);
    h.settle({ ok: true });
    expect(h.hasUnknown()).toBe(false);
  });

  it("a definitive 4xx on a FIRST attempt is not unknown and takes a fresh key (condition c)", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle({ ok: false, error: err(400) });
    expect(h.hasUnknown()).toBe(false);
    expect(h.keyFor(pay)).toBe("key-2");
  });

  it("a 4xx on a retry after an unknown outcome keeps the key and stays unknown (condition a)", () => {
    const h = unknownHolder();
    h.settle({ ok: false, error: err(422) });
    expect(h.hasUnknown()).toBe(true);
    expect(h.keyFor({ ...pay, amount: 5 })).toBe("key-1"); // pinned: an edit never mints
  });

  it("checkStatus found: settles as a success, releases the key and hands the stored payment back", async () => {
    const h = unknownHolder();
    const fetch = jest.fn().mockResolvedValue({ paymentGroupId: "g1" });
    const out = await h.checkStatus(fetch);
    expect(fetch).toHaveBeenCalledWith("key-1");
    expect(out).toEqual({ kind: "found", payment: { paymentGroupId: "g1" } });
    expect(h.hasUnknown()).toBe(false);
    expect(h.peek()).toBeNull();
    expect(h.mayBeRecorded()).toBe(false);
  });

  it("checkStatus 404 PAYMENT_KEY_NOT_FOUND: releases the key; the next attempt mints a fresh one", async () => {
    const h = unknownHolder();
    const out = await h.checkStatus(() => Promise.reject(notFound()));
    expect(out).toEqual({ kind: "notFound" });
    expect(h.hasUnknown()).toBe(false);
    expect(h.keyFor(pay)).toBe("key-2");
  });

  it("checkStatus releases a payment-key-conflict lock too (the read is definitive)", async () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle({
      ok: false,
      error: err(409, { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "PAYMENT_MISMATCH" }),
    });
    expect(h.mayBeRecorded()).toBe(true);
    await h.checkStatus(() => Promise.reject(notFound()));
    expect(h.mayBeRecorded()).toBe(false);
    expect(h.hasUnknown()).toBe(false);
  });

  it.each([
    ["a network error", err()],
    ["a 5xx", err(503)],
    ["a 404 without the code", err(404, { code: "OTHER" })],
    ["a 401", err(401)],
    ["a 429", err(429)],
  ])("checkStatus %s: stays unknown and locked on the SAME key", async (_n, error) => {
    const h = unknownHolder();
    const out = await h.checkStatus(() => Promise.reject(error));
    expect(out).toEqual({ kind: "error" });
    expect(h.hasUnknown()).toBe(true);
    expect(h.peek()).toBe("key-1");
    expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
  });

  it("checkStatus with nothing unknown asks nothing and answers notFound", async () => {
    const h = createPaymentKeyHolder(mintSeq());
    const fetch = jest.fn();
    expect(await h.checkStatus(fetch)).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolveFromStatus applies an already-fetched result by the same rule", () => {
    const h = unknownHolder();
    expect(h.resolveFromStatus({ kind: "error" })).toEqual({ kind: "error" });
    expect(h.hasUnknown()).toBe(true);
    h.resolveFromStatus({ kind: "notFound" });
    expect(h.hasUnknown()).toBe(false);
    const h2 = unknownHolder();
    h2.resolveFromStatus({ kind: "found", payment: { id: "p" } });
    expect(h2.peek()).toBeNull();
  });

  it("isPaymentKeyNotFound: only a 404 carrying PAYMENT_KEY_NOT_FOUND", () => {
    expect(isPaymentKeyNotFound(notFound())).toBe(true);
    expect(isPaymentKeyNotFound(err(404, { code: "COUNTER_SALE_NOT_FOUND" }))).toBe(false);
    expect(isPaymentKeyNotFound(err(409, { code: "PAYMENT_KEY_NOT_FOUND" }))).toBe(false);
    expect(isPaymentKeyNotFound(undefined)).toBe(false);
  });

  it("fixed copy only", () => {
    expect(PAYMENT_STATUS_COPY.action).toBe("Check payment status");
    expect(paymentStatusCopy({ kind: "found", payment: {} })).toBe("This payment was recorded.");
    expect(paymentStatusCopy({ kind: "notFound" })).toBe(
      "Nothing was recorded. You can try again.",
    );
    expect(paymentStatusCopy({ kind: "error" })).toBe(
      "We couldn't check right now. Try again in a moment.",
    );
  });
});
