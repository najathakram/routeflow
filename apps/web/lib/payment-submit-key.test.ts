import { renderHook } from "@testing-library/react";
import {
  createPaymentKeyHolder,
  paymentSubmitFingerprint,
} from "@routeflow/types/payment-submit-key";
import { sendWithPaymentKey, usePaymentSubmitKey } from "./payment-submit-key";

/**
 * SA-824: the record-payment dialogs' Idempotency-Key rule (the shared
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

describe("SA-824 payment submit key (web)", () => {
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

  it("reset() (a fresh open) forgets the key and any unknown outcome", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle({ ok: false, error: err(502) });
    h.reset();
    expect(h.keyFor(pay)).toBe("key-2");
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

  it("usePaymentSubmitKey: one holder per mount, reset when the dialog opens again", () => {
    const { result, rerender } = renderHook(({ open }) => usePaymentSubmitKey(open), {
      initialProps: { open: true },
    });
    const holder = result.current;
    const first = holder.keyFor(pay);
    holder.settle({ ok: false, error: err() }); // unknown: kept while open
    rerender({ open: true });
    expect(result.current).toBe(holder);
    expect(holder.keyFor(pay)).toBe(first);
    rerender({ open: false });
    rerender({ open: true }); // a fresh open
    expect(holder.keyFor(pay)).not.toBe(first);
  });
});
