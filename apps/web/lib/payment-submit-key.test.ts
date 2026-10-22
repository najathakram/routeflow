import { act, renderHook } from "@testing-library/react";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  createPaymentKeyHolder,
  finishFoundPayment,
  forgetPaymentProof,
  recordedPaymentId,
  releasePaymentKeyHolder,
  rememberPaymentProof,
  PAYMENT_PHOTO_LATER_COPY,
  paymentSubmitFingerprint,
  PAYMENT_MAY_BE_RECORDED_COPY,
  paymentMayBeRecordedCopy,
} from "@routeflow/types/payment-submit-key";
import { sendWithPaymentKey, usePaymentSubmitKey } from "./payment-submit-key";
import { genericToastCopy } from "./generic-toast-copy";
import { useHolderUnknown } from "./use-payment-status-check";

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
    // Every dialog's toast (and the app-wide one) shows the recovery copy, never a "nothing recorded" line.
    expect(genericToastCopy(conflict)).toBe(PAYMENT_MAY_BE_RECORDED_COPY);
    expect(h.mayBeRecorded()).toBe(true);
  });

  it("reset() (a fresh open) forgets a settled key but NEVER an unknown outcome", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: false, error: err(502) });
    h.reset(); // unknown: the key and the lock survive
    expect(h.hasUnknown()).toBe(true);
    expect(h.peek()).toBe("key-1");
    expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
    h.resolveFromStatus({ kind: "tombstoned" }); // released
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: true });
    h.reset();
    expect(h.keyFor(pay)).toBe("key-3");
  });

  it("a payment key conflict also survives reset() (it is unknown too)", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle(h.peek()!, {
      ok: false,
      error: err(409, { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "PAYMENT_MISMATCH" }),
    });
    h.reset();
    expect(h.mayBeRecorded()).toBe(true);
    expect(h.peek()).toBe("key-1");
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

  it("usePaymentSubmitKey: a fresh open after a SETTLED attempt gets a fresh key", () => {
    clearPaymentKeyRegistry();
    const { result, rerender } = renderHook(({ open }) => usePaymentSubmitKey(open, "s:a"), {
      initialProps: { open: true },
    });
    const first = result.current.keyFor(pay);
    result.current.settle(result.current.peek()!, { ok: true });
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.keyFor(pay)).not.toBe(first);
  });

  it("usePaymentSubmitKey: unknown -> close -> reopen (and unmount -> remount) keeps the SAME key, still unknown", () => {
    clearPaymentKeyRegistry();
    const a = renderHook(({ open }) => usePaymentSubmitKey(open, "s:b"), {
      initialProps: { open: true },
    });
    const first = a.result.current.keyFor(pay);
    a.result.current.settle(a.result.current.peek()!, { ok: false, error: err(503) });
    a.rerender({ open: false });
    a.rerender({ open: true });
    expect(a.result.current.hasUnknown()).toBe(true);
    expect(a.result.current.keyFor(pay)).toBe(first);
    a.unmount(); // a per-mount dialog closing
    const b = renderHook(() => usePaymentSubmitKey(true, "s:b"));
    expect(b.result.current.hasUnknown()).toBe(true);
    expect(b.result.current.keyFor({ ...pay, amount: 5 })).toBe(first);
    // a different payment target is independent
    const c = renderHook(() => usePaymentSubmitKey(true, "s:other"));
    expect(c.result.current.hasUnknown()).toBe(false);
    // after a release, the next open is fresh
    b.result.current.resolveFromStatus({ kind: "tombstoned" });
    b.unmount();
    const d = renderHook(() => usePaymentSubmitKey(true, "s:b"));
    expect(d.result.current.hasUnknown()).toBe(false);
    expect(d.result.current.keyFor(pay)).not.toBe(first);
  });
});

describe("SA-824 holder registry, recorded payment id and the found-path photo", () => {
  beforeEach(() => clearPaymentKeyRegistry());

  it("acquire returns the SAME holder per scope; release keeps an unknown one, drops a settled one", () => {
    const h = acquirePaymentKeyHolder("x:1", mintSeq());
    expect(acquirePaymentKeyHolder("x:1")).toBe(h);
    expect(acquirePaymentKeyHolder("x:2")).not.toBe(h);
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: false, error: err(500) });
    releasePaymentKeyHolder("x:1");
    expect(acquirePaymentKeyHolder("x:1")).toBe(h);
    h.resolveFromStatus({ kind: "found", payment: {} });
    releasePaymentKeyHolder("x:1");
    expect(acquirePaymentKeyHolder("x:1")).not.toBe(h);
  });

  it("release never drops a holder with a request in flight (a key held, no outcome yet)", () => {
    const h = acquirePaymentKeyHolder("x:3", mintSeq());
    h.keyFor(pay);
    releasePaymentKeyHolder("x:3");
    expect(acquirePaymentKeyHolder("x:3")).toBe(h);
  });

  it("recordedPaymentId: createdPaymentId (invoice scope), payments[0].id (standalone), else null", () => {
    expect(recordedPaymentId({ createdPaymentId: "p9", payments: [{ id: "old" }] })).toBe("p9");
    expect(
      recordedPaymentId({
        scope: "STANDALONE_PAYMENT",
        paymentGroupId: "g",
        payments: [{ id: "p1" }, { id: "p2" }],
      }),
    ).toBe("p1");
    // an invoice-scope result without createdPaymentId: payments[] is the invoice's whole history -> not derivable
    expect(
      recordedPaymentId({ scope: "INVOICE_PAYMENT", id: "inv", payments: [{ id: "p0" }] }),
    ).toBeNull();
    expect(
      recordedPaymentId({ scope: "STANDALONE_PAYMENT", paymentGroupId: "g", payments: [] }),
    ).toBeNull();
    expect(recordedPaymentId(null)).toBeNull();
    expect(recordedPaymentId("x")).toBeNull();
  });

  it("finishFoundPayment: no proof -> none; derivable -> uploaded against that id; failure -> failed; not derivable -> later", async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const stand = { scope: "STANDALONE_PAYMENT", paymentGroupId: "g", payments: [{ id: "p1" }] };
    expect(await finishFoundPayment("p:1", stand, upload)).toBe("none");
    expect(upload).not.toHaveBeenCalled();

    rememberPaymentProof("p:1", "PHOTO");
    expect(await finishFoundPayment("p:1", stand, upload)).toBe("uploaded");
    expect(upload).toHaveBeenCalledWith("p1", "PHOTO");
    expect(await finishFoundPayment("p:1", stand, upload)).toBe("none"); // taken once

    rememberPaymentProof("p:1", "PHOTO");
    upload.mockRejectedValueOnce(new Error("boom"));
    expect(await finishFoundPayment("p:1", stand, upload)).toBe("failed");

    rememberPaymentProof("p:1", "PHOTO");
    expect(await finishFoundPayment("p:1", { scope: "ADVANCE_PAYMENT", id: "a" }, upload)).toBe(
      "later",
    );
    expect(PAYMENT_PHOTO_LATER_COPY).toBe(
      "The payment was recorded. Add the photo from the payment.",
    );
    forgetPaymentProof("p:1");
    expect(await finishFoundPayment("p:1", stand, upload)).toBe("none");
  });

  it("releasing a holder drops its remembered proof", async () => {
    const h = acquirePaymentKeyHolder("p:2", mintSeq());
    rememberPaymentProof("p:2", "PHOTO");
    releasePaymentKeyHolder("p:2");
    expect(h).toBeTruthy();
    expect(
      await finishFoundPayment("p:2", { paymentGroupId: "g", payments: [{ id: "p" }] }, jest.fn()),
    ).toBe("none");
  });
});

describe("SA-824 MUST-1: a request in flight is an unknown outcome (holder)", () => {
  beforeEach(() => clearPaymentKeyRegistry());

  it("reset during flight, then a timeout -> locked, SAME key, status check offered", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const k1 = h.keyFor(pay);
    expect(h.hasUnknown()).toBe(true); // the request is out: no outcome yet
    h.reset(); // a dialog reopened while the request is still out
    expect(h.peek()).toBe(k1);
    h.settle(h.peek()!, { ok: false, error: err() }); // the 15 s timeout: no response at all
    expect(h.hasUnknown()).toBe(true); // Save stays off, "Check payment status" is offered
    expect(h.peek()).toBe(k1);
    expect(h.keyFor(pay)).toBe(k1); // the next submit would reuse K1, never mint K2
  });

  it("a late K1 timeout does not lock K2", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const k1 = h.keyFor(pay);
    h.resolveFromStatus({ kind: "tombstoned" }); // the status check closed K1 while its request was out
    const k2 = h.keyFor(pay);
    expect(k2).not.toBe(k1);
    h.settle(k1, { ok: false, error: err() }); // K1's late timeout: not K2's outcome, ignored
    expect(h.peek()).toBe(k2);
    h.settle(k2, { ok: false, error: err(400) }); // K2's own definitive refusal
    expect(h.peek()).toBeNull(); // K2 was never locked: it is released
  });

  it("a late K1 success does not release K2", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const k1 = h.keyFor(pay);
    h.resolveFromStatus({ kind: "tombstoned" });
    const k2 = h.keyFor(pay);
    h.settle(k1, { ok: true }); // K1's late success: ignored, K2 is still out
    expect(h.peek()).toBe(k2);
    expect(h.hasUnknown()).toBe(true);
    h.settle(k2, { ok: false, error: err() }); // K2 times out
    expect(h.peek()).toBe(k2);
    expect(h.hasUnknown()).toBe(true);
    expect(k1).not.toBe(k2);
  });

  it("useHolderUnknown: the sender is not 'unknown' while its own Save is pending, a remount is; a late settle re-renders both", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const sender = renderHook(() => useHolderUnknown(h));
    let k1 = "";
    act(() => {
      k1 = h.keyFor(pay);
    });
    const remount = renderHook(() => useHolderUnknown(h)); // Cancel -> reopen mid-flight
    expect(sender.result.current).toBe(false); // its own button already reads Saving...
    expect(remount.result.current).toBe(true); // Save off, "Check payment status" offered
    act(() => h.settle(k1, { ok: false, error: err() })); // the timeout lands
    expect(sender.result.current).toBe(true);
    expect(remount.result.current).toBe(true);
    act(() => void h.resolveFromStatus({ kind: "found", payment: {} })); // released
    expect(sender.result.current).toBe(false);
    expect(remount.result.current).toBe(false); // no stale lock on the reopened dialog
  });
});
