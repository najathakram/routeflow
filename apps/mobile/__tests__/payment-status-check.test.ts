import { createPaymentKeyHolder } from "../lib/payment-submit-key";
import {
  PAYMENT_STATUS_COPY,
  paymentByKeyPath,
  runPaymentStatusCheck,
} from "../lib/payment-status-check";

/**
 * SA-824 (SA conditions a/b): the mobile "Check payment status" step. Pure logic: the shared holder decides
 * what the GET-by-key answer means; this pins the path and the FIXED copy (never a raw server message).
 */
const mintSeq = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const pay = { amount: 100, method: "CASH" };
const err = (status?: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), status ? { response: { status, data } } : {});
const unknownHolder = () => {
  const h = createPaymentKeyHolder(mintSeq());
  h.keyFor(pay);
  h.settle({ ok: false, error: err(503) });
  return h;
};

describe("SA-824 payment status check (mobile)", () => {
  it("the path is /invoices/payments/by-key/<encoded key>", () => {
    expect(paymentByKeyPath("a/b c")).toBe("/invoices/payments/by-key/a%2Fb%20c");
  });

  it("found: 'This payment was recorded.', the key is released, the stored payment is handed back", async () => {
    const h = unknownHolder();
    const fetch = jest.fn().mockResolvedValue({ id: "adv-1" });
    const out = await runPaymentStatusCheck(h, fetch);
    expect(fetch).toHaveBeenCalledWith("key-1");
    expect(out.message).toBe("This payment was recorded.");
    expect(out.outcome).toEqual({ kind: "found", payment: { id: "adv-1" } });
    expect(h.hasUnknown()).toBe(false);
  });

  it("not found (404 PAYMENT_KEY_NOT_FOUND): 'Nothing was recorded. You can try again.', fresh key next", async () => {
    const h = unknownHolder();
    const out = await runPaymentStatusCheck(h, () =>
      Promise.reject(err(404, { code: "PAYMENT_KEY_NOT_FOUND" })),
    );
    expect(out.message).toBe("Nothing was recorded. You can try again.");
    expect(h.hasUnknown()).toBe(false);
    expect(h.keyFor(pay)).toBe("key-2");
  });

  it("any other error: the fixed 'couldn't check' copy, still unknown, same key", async () => {
    const h = unknownHolder();
    const out = await runPaymentStatusCheck(h, () => Promise.reject(err(500)));
    expect(out.message).toBe("We couldn't check right now. Try again in a moment.");
    expect(out.message).not.toMatch(/RAW/);
    expect(h.hasUnknown()).toBe(true);
    expect(h.peek()).toBe("key-1");
  });

  it("the action label", () => {
    expect(PAYMENT_STATUS_COPY.action).toBe("Check payment status");
  });
});
