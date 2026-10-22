import {
  clearPaymentKeyRegistry,
  createPaymentKeyHolder,
  mountPaymentKeyHolder,
  paymentSubmitFingerprint,
  sendWithPaymentKey,
  PAYMENT_MAY_BE_RECORDED_COPY,
  paymentMayBeRecordedCopy,
  paymentKeyScope,
} from "../lib/payment-submit-key";

/**
 * SA-824: the record-payment screens' Idempotency-Key rule (the shared
 * `@routeflow/types/payment-submit-key`): one key per open, kept across retries, re-minted on a known
 * outcome or a changed amount / method / allocation.
 */
const mintSeq = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const pay = { amount: 100, method: "CASH", allocations: [{ invoiceId: "i1", amount: 100 }] };
const err = (status?: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("x"), status ? { response: { status, data } } : {});

describe("SA-824 payment submit key (mobile)", () => {
  it("a retry after an unknown outcome (network / 5xx) sends the SAME key, even after an edit", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.keyFor(pay)).toBe("key-1");
    h.settle(h.peek()!, { ok: false, error: err() }); // no response at all
    expect(h.keyFor(pay)).toBe("key-1");
    h.settle(h.peek()!, { ok: false, error: err(503) });
    expect(h.keyFor({ ...pay, amount: 90 })).toBe("key-1");
  });

  it("a success, or a definitive 4xx that wrote nothing, re-mints", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: true });
    expect(h.keyFor(pay)).toBe("key-2");
    h.settle(h.peek()!, { ok: false, error: err(400) });
    expect(h.keyFor(pay)).toBe("key-3");
  });

  it("a changed amount, method or allocation after a refused attempt re-mints; while the request is out any form keeps the key", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.keyFor(pay)).toBe("key-1");
    expect(h.keyFor({ ...pay })).toBe("key-1");
    expect(h.keyFor({ ...pay, amount: 99 })).toBe("key-1"); // still out: an edit never mints
    for (let i = 0; i < 3; i += 1) h.settle("key-1", { ok: false, error: err(400) }); // all three refused
    expect(h.peek()).toBeNull();
    expect(h.keyFor({ ...pay, amount: 99 })).toBe("key-2");
    h.settle("key-2", { ok: false, error: err(400) });
    expect(h.keyFor({ ...pay, amount: 99, method: "CHECK" })).toBe("key-3");
    h.settle("key-3", { ok: false, error: err(400) });
    expect(
      h.keyFor({
        ...pay,
        amount: 99,
        method: "CHECK",
        allocations: [{ invoiceId: "i2", amount: 99 }],
      }),
    ).toBe("key-4");
  });

  it("a changed DRAFT/PAID status after a refused attempt re-mints", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.keyFor({ ...pay, status: "DRAFT" })).toBe("key-1");
    h.settle("key-1", { ok: false, error: err(400) });
    expect(h.keyFor({ ...pay, status: "PAID" })).toBe("key-2");
  });

  it("a double submit under one key: the first refusal does not drop the key the second request is still using", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const k = h.keyFor(pay);
    expect(h.keyFor(pay)).toBe(k);
    h.settle(k, { ok: false, error: err(400) }); // the first is refused
    expect(h.peek()).toBe(k); // the twin is still out
    h.settle(k, { ok: false, error: err() }); // the twin times out
    expect(h.hasUnknown()).toBe(true);
    expect(h.peek()).toBe(k);
  });

  it("a 409 payment key conflict KEEPS the key (a payment may already exist under it), even after an edit", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    const conflict = err(409, { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "PAYMENT_MISMATCH" });
    h.settle(h.peek()!, { ok: false, error: conflict });
    expect(h.peek()).toBe("key-1");
    expect(h.keyFor({ ...pay, amount: 90 })).toBe("key-1");
    expect(paymentMayBeRecordedCopy(conflict)).toBe(PAYMENT_MAY_BE_RECORDED_COPY);
    expect(PAYMENT_MAY_BE_RECORDED_COPY).toBe(
      "This payment may already be recorded. Check the customer's payments before trying again.",
    );
    expect(paymentMayBeRecordedCopy(err(409, { code: "OTHER" }))).toBeNull();
    expect(paymentMayBeRecordedCopy(err(503))).toBeNull();
    expect(h.mayBeRecorded()).toBe(true);
  });

  it("reset() (a fresh open) forgets a settled key but NEVER an unknown outcome", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: false, error: err(502) });
    h.reset();
    expect(h.hasUnknown()).toBe(true);
    expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
    h.resolveFromStatus({ kind: "tombstoned" });
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: true });
    h.reset();
    expect(h.keyFor(pay)).toBe("key-3");
  });

  it("the screen helper: unknown -> unmount -> remount (Cancel -> reopen) keeps the SAME holder and key", () => {
    clearPaymentKeyRegistry();
    const first = mountPaymentKeyHolder("invoice:i1");
    const key = first.holder.keyFor(pay);
    first.holder.settle(first.holder.peek()!, { ok: false, error: err(503) });
    first.unmount();
    const again = mountPaymentKeyHolder("invoice:i1");
    expect(again.holder).toBe(first.holder);
    expect(again.holder.hasUnknown()).toBe(true);
    expect(again.holder.keyFor({ ...pay, amount: 3 })).toBe(key);
    expect(mountPaymentKeyHolder("invoice:i2").holder.hasUnknown()).toBe(false);
  });

  it("the screen helper: after a release the next open gets a fresh holder and key", () => {
    clearPaymentKeyRegistry();
    const first = mountPaymentKeyHolder("advance:c1");
    const key = first.holder.keyFor(pay);
    first.holder.settle(first.holder.peek()!, { ok: false, error: err(503) });
    first.holder.resolveFromStatus({ kind: "found", payment: {} });
    first.unmount();
    const again = mountPaymentKeyHolder("advance:c1");
    expect(again.holder).not.toBe(first.holder);
    expect(again.holder.keyFor(pay)).not.toBe(key);
  });

  it("the screen helper: a SETTLED attempt left in the registry starts fresh on the next open", () => {
    clearPaymentKeyRegistry();
    const first = mountPaymentKeyHolder("standalone:c1");
    const key = first.holder.keyFor(pay);
    first.holder.settle(first.holder.peek()!, { ok: true });
    first.unmount();
    expect(mountPaymentKeyHolder("standalone:c1").holder.keyFor(pay)).not.toBe(key);
  });

  it("the fingerprint ignores allocation order and float noise", () => {
    const a = {
      amount: 10,
      method: "CASH",
      allocations: [
        { invoiceId: "i1", amount: 4 },
        { invoiceId: "i2", amount: 6 },
      ],
    };
    const b = { ...a, amount: 10.000000001, allocations: [...a.allocations].reverse() };
    expect(paymentSubmitFingerprint(a)).toBe(paymentSubmitFingerprint(b));
  });

  it("sendWithPaymentKey: a holder adds the header and settles; no holder sends exactly as before", async () => {
    const h = createPaymentKeyHolder(mintSeq());
    const send = jest.fn().mockResolvedValue("ok");
    await sendWithPaymentKey(h, pay, send);
    expect(send).toHaveBeenLastCalledWith([{ headers: { "Idempotency-Key": "key-1" } }]);
    expect(h.peek()).toBeNull(); // the success settled (re-mint on the next submit)

    const failing = jest.fn().mockRejectedValue(err(504));
    await expect(sendWithPaymentKey(h, pay, failing)).rejects.toThrow();
    expect(h.peek()).toBe("key-2"); // unknown: kept for the retry

    const plain = jest.fn().mockResolvedValue("ok");
    await sendWithPaymentKey(undefined, pay, plain);
    expect(plain).toHaveBeenCalledWith([]);
  });
});

describe("SA-824 MUST-1: a request in flight is an unknown outcome (mobile)", () => {
  beforeEach(() => clearPaymentKeyRegistry());

  it("holder: reset during flight, then a timeout -> locked, SAME key, status check offered", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const k1 = h.keyFor(pay);
    expect(h.hasUnknown()).toBe(true);
    h.reset();
    h.settle(k1, { ok: false, error: err() });
    expect(h.hasUnknown()).toBe(true);
    expect(h.peek()).toBe(k1);
    expect(h.keyFor(pay)).toBe(k1);
  });

  it("the screen helper: back + reopen while the request is out, then a timeout -> locked, same key", () => {
    const first = mountPaymentKeyHolder("standalone:c9");
    const key = first.holder.keyFor(pay);
    first.unmount(); // back while the request is out: the entry is kept
    const again = mountPaymentKeyHolder("standalone:c9"); // reopen (runs reset())
    expect(again.holder).toBe(first.holder);
    expect(again.holder.hasUnknown()).toBe(true); // reopened mid-flight: the status check is offered
    first.holder.settle(key, { ok: false, error: err() }); // the first screen's request times out (15 s)
    expect(again.holder.hasUnknown()).toBe(true);
    expect(again.holder.peek()).toBe(key);
    expect(again.holder.keyFor(pay)).toBe(key);
  });

  it("a late K1 timeout does not lock K2; a late K1 success does not release K2", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const k1 = h.keyFor(pay);
    h.resolveFromStatus({ kind: "tombstoned" });
    const k2 = h.keyFor(pay);
    h.settle(k1, { ok: false, error: err() }); // K1's late timeout: ignored
    expect(h.peek()).toBe(k2);
    h.settle(k2, { ok: false, error: err(400) }); // K2's definitive refusal
    expect(h.peek()).toBeNull();

    const k3 = h.keyFor(pay);
    h.resolveFromStatus({ kind: "tombstoned" });
    const k4 = h.keyFor(pay);
    h.settle(k3, { ok: true }); // K3's late success: ignored
    expect(h.peek()).toBe(k4);
    h.settle(k4, { ok: false, error: err() }); // K4 times out
    expect(h.peek()).toBe(k4);
    expect(k3).not.toBe(k4);
  });
});

describe("SA-824 scope is writer + target (mobile)", () => {
  it("paymentKeyScope: one scope per writer + target; the three screens use these builders", () => {
    expect(paymentKeyScope.standalone("c1")).toBe("standalone:c1");
    expect(paymentKeyScope.invoice("i1")).toBe("invoice:i1");
    expect(paymentKeyScope.advance("c1")).toBe("advance:c1");
  });
});
