import {
  clearPaymentKeyRegistry,
  createPaymentKeyHolder,
  mountPaymentKeyHolder,
  paymentSubmitFingerprint,
  sendWithPaymentKey,
  PAYMENT_MAY_BE_RECORDED_COPY,
  paymentMayBeRecordedCopy,
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
    h.settle({ ok: false, error: err() }); // no response at all
    expect(h.keyFor(pay)).toBe("key-1");
    h.settle({ ok: false, error: err(503) });
    expect(h.keyFor({ ...pay, amount: 90 })).toBe("key-1");
  });

  it("a success, or a definitive 4xx that wrote nothing, re-mints", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle({ ok: true });
    expect(h.keyFor(pay)).toBe("key-2");
    h.settle({ ok: false, error: err(400) });
    expect(h.keyFor(pay)).toBe("key-3");
  });

  it("a changed amount, method or allocation with nothing pending re-mints; the same form keeps the key", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.keyFor(pay)).toBe("key-1");
    expect(h.keyFor({ ...pay })).toBe("key-1");
    expect(h.keyFor({ ...pay, amount: 99 })).toBe("key-2");
    expect(h.keyFor({ ...pay, amount: 99, method: "CHECK" })).toBe("key-3");
    expect(
      h.keyFor({
        ...pay,
        amount: 99,
        method: "CHECK",
        allocations: [{ invoiceId: "i2", amount: 99 }],
      }),
    ).toBe("key-4");
  });

  it("a changed DRAFT/PAID status with nothing pending re-mints", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.keyFor({ ...pay, status: "DRAFT" })).toBe("key-1");
    expect(h.keyFor({ ...pay, status: "PAID" })).toBe("key-2");
  });

  it("a 409 payment key conflict KEEPS the key (a payment may already exist under it), even after an edit", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    const conflict = err(409, { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "PAYMENT_MISMATCH" });
    h.settle({ ok: false, error: conflict });
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
    h.settle({ ok: false, error: err(502) });
    h.reset();
    expect(h.hasUnknown()).toBe(true);
    expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
    h.resolveFromStatus({ kind: "notFound" });
    h.keyFor(pay);
    h.settle({ ok: true });
    h.reset();
    expect(h.keyFor(pay)).toBe("key-3");
  });

  it("the screen helper: unknown -> unmount -> remount (Cancel -> reopen) keeps the SAME holder and key", () => {
    clearPaymentKeyRegistry();
    const first = mountPaymentKeyHolder("invoice:i1");
    const key = first.holder.keyFor(pay);
    first.holder.settle({ ok: false, error: err(503) });
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
    first.holder.settle({ ok: false, error: err(503) });
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
    first.holder.settle({ ok: true });
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
