import {
  createPaymentKeyHolder,
  PAYMENT_KEY_RESOLVED_COPY,
  PAYMENT_MAY_BE_RECORDED_COPY,
  PAYMENT_STATUS_COPY,
  paymentKeyRefusalCopy,
  paymentStatusCopy,
} from "@routeflow/types/payment-submit-key";
import { genericToastCopy } from "./generic-toast-copy";

/**
 * SA-824 (SA conditions a/b + race ruling 5): "Check payment status". While a payment's outcome is unknown the
 * holder keeps and locks its key; the RESOLVE by key (POST .../by-key/:key/resolve) is the only way out besides
 * a 2xx. The key is released ONLY on { state: "found" } or { state: "tombstoned" }. A 404 (even
 * PAYMENT_KEY_NOT_FOUND), a 409 PAYMENT_KEY_IN_FLIGHT and any other error keep it locked.
 */
const mintSeq = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const pay = { amount: 100, method: "CASH", allocations: [{ invoiceId: "i1", amount: 100 }] };
const err = (status?: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("x"), status ? { response: { status, data } } : {});
const resolvedOnSave = () => err(409, { code: "PAYMENT_KEY_RESOLVED", message: "RAW" });
const inFlight = () => err(409, { code: "PAYMENT_KEY_IN_FLIGHT", message: "RAW" });
const conflict = () => err(409, { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "PAYMENT_MISMATCH" });
const unknownHolder = () => {
  const h = createPaymentKeyHolder(mintSeq());
  h.keyFor(pay);
  h.settle(h.peek()!, { ok: false, error: err(503) });
  return h;
};

describe("SA-824 payment status check (shared holder, resolve)", () => {
  it("hasUnknown: false fresh, true after an unknown outcome, false after a success; reset() never clears it", () => {
    const h = createPaymentKeyHolder(mintSeq());
    expect(h.hasUnknown()).toBe(false);
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: false, error: err() });
    expect(h.hasUnknown()).toBe(true);
    h.reset(); // a reopen must not drop the unknown outcome
    expect(h.hasUnknown()).toBe(true);
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: true });
    expect(h.hasUnknown()).toBe(false);
  });

  it("a definitive 4xx on a FIRST attempt is not unknown and takes a fresh key (condition c)", () => {
    const h = createPaymentKeyHolder(mintSeq());
    h.keyFor(pay);
    h.settle(h.peek()!, { ok: false, error: err(400) });
    expect(h.hasUnknown()).toBe(false);
    expect(h.keyFor(pay)).toBe("key-2");
  });

  it("a 4xx on a retry after an unknown outcome keeps the key and stays unknown (condition a)", () => {
    const h = unknownHolder();
    h.settle(h.peek()!, { ok: false, error: err(422) });
    expect(h.hasUnknown()).toBe(true);
    expect(h.keyFor({ ...pay, amount: 5 })).toBe("key-1"); // pinned: an edit never mints
  });

  it("found: the resolve is by the HELD key; settles as a success and hands the stored payment back", async () => {
    const h = unknownHolder();
    const body = { state: "found", paymentGroupId: "g1", scope: "STANDALONE_PAYMENT" };
    const resolve = jest.fn().mockResolvedValue(body);
    const out = await h.checkStatus(resolve);
    expect(resolve).toHaveBeenCalledWith("key-1");
    expect(out).toEqual({ kind: "found", payment: body });
    expect(h.hasUnknown()).toBe(false);
    expect(h.peek()).toBeNull();
    expect(h.mayBeRecorded()).toBe(false);
  });

  it("tombstoned: releases the key; the next attempt mints a fresh one", async () => {
    const h = unknownHolder();
    const out = await h.checkStatus(() => Promise.resolve({ state: "tombstoned" }));
    expect(out).toEqual({ kind: "tombstoned" });
    expect(h.hasUnknown()).toBe(false);
    expect(h.keyFor(pay)).toBe("key-2");
  });

  it("a found or tombstoned answer releases a payment-key-conflict lock too (the resolve is definitive)", async () => {
    for (const answer of [{ state: "tombstoned" }, { state: "found", id: "inv-1" }]) {
      const h = createPaymentKeyHolder(mintSeq());
      h.keyFor(pay);
      h.settle(h.peek()!, { ok: false, error: conflict() });
      expect(h.mayBeRecorded()).toBe(true);
      await h.checkStatus(() => Promise.resolve(answer));
      expect(h.mayBeRecorded()).toBe(false);
      expect(h.hasUnknown()).toBe(false);
    }
  });

  it("409 PAYMENT_KEY_IN_FLIGHT: 'inFlight' (retryable), still unknown and locked on the SAME key", async () => {
    const h = unknownHolder();
    const out = await h.checkStatus(() => Promise.reject(inFlight()));
    expect(out).toEqual({ kind: "inFlight" });
    expect(h.hasUnknown()).toBe(true);
    expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
  });

  it.each([
    [
      "a 404 PAYMENT_KEY_NOT_FOUND (ruling 5: a 404 never releases)",
      err(404, { code: "PAYMENT_KEY_NOT_FOUND" }),
    ],
    ["a 404 without a code (a server without the resolve route)", err(404)],
    ["a network error", err()],
    ["a 5xx", err(503)],
    ["a 401", err(401)],
    ["a 429", err(429)],
  ])("checkStatus %s: 'error', stays unknown and locked on the SAME key", async (_n, error) => {
    const h = unknownHolder();
    const out = await h.checkStatus(() => Promise.reject(error));
    expect(out).toEqual({ kind: "error" });
    expect(h.hasUnknown()).toBe(true);
    expect(h.peek()).toBe("key-1");
    expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
  });

  it.each([[{}], [{ state: "nope" }], [null], [{ paymentGroupId: "g1" }]])(
    "a 2xx body that is neither found nor tombstoned (%p) is no answer: 'error', still locked",
    async (body) => {
      const h = unknownHolder();
      expect(await h.checkStatus(() => Promise.resolve(body))).toEqual({ kind: "error" });
      expect(h.hasUnknown()).toBe(true);
    },
  );

  it("checkStatus with nothing unknown asks nothing and answers idle", async () => {
    const h = createPaymentKeyHolder(mintSeq());
    const resolve = jest.fn();
    expect(await h.checkStatus(resolve)).toEqual({ kind: "idle" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolveFromStatus applies an already-fetched result by the same rule", () => {
    for (const keep of [{ kind: "error" }, { kind: "inFlight" }] as const) {
      const h = unknownHolder();
      expect(h.resolveFromStatus(keep)).toEqual(keep);
      expect(h.hasUnknown()).toBe(true);
    }
    const h = unknownHolder();
    h.resolveFromStatus({ kind: "tombstoned" });
    expect(h.hasUnknown()).toBe(false);
    const h2 = unknownHolder();
    h2.resolveFromStatus({ kind: "found", payment: { id: "p" } });
    expect(h2.peek()).toBeNull();
  });

  describe("Save outcomes the resolve introduces", () => {
    it("409 PAYMENT_KEY_RESOLVED on Save RELEASES the key (nothing was written under it), even while locked", () => {
      const h = unknownHolder();
      h.settle(h.peek()!, { ok: false, error: resolvedOnSave() });
      expect(h.hasUnknown()).toBe(false);
      expect(h.mayBeRecorded()).toBe(false);
      expect(h.keyFor(pay)).toBe("key-2");
    });

    it("409 PAYMENT_KEY_IN_FLIGHT on Save keeps the key locked (unknown), never a fresh key", () => {
      const h = createPaymentKeyHolder(mintSeq());
      h.keyFor(pay);
      h.settle(h.peek()!, { ok: false, error: inFlight() });
      expect(h.hasUnknown()).toBe(true);
      expect(h.keyFor({ ...pay, amount: 1 })).toBe("key-1");
    });

    it("a coded 409 day-closed refusal on a FIRST attempt is definitive (the writer's claim rolled back with it)", () => {
      for (const code of ["COUNTER_SALE_DAY_CLOSED", "DAY_CLOSED_FOR_PAYMENT_DATE"]) {
        const h = createPaymentKeyHolder(mintSeq());
        h.keyFor(pay);
        h.settle(h.peek()!, { ok: false, error: err(409, { code }) });
        expect({ code, unknown: h.hasUnknown() }).toEqual({ code, unknown: false });
        expect(h.keyFor(pay)).toBe("key-2");
      }
    });

    it("a day-closed refusal on a RETRY after an unknown outcome keeps the key (the first attempt may have recorded)", () => {
      const h = unknownHolder();
      h.settle(h.peek()!, { ok: false, error: err(409, { code: "COUNTER_SALE_DAY_CLOSED" }) });
      expect(h.hasUnknown()).toBe(true);
      expect(h.keyFor(pay)).toBe("key-1");
    });

    it("a day-closed body that names a committed order or invoice is still unknown", () => {
      const h = createPaymentKeyHolder(mintSeq());
      h.keyFor(pay);
      h.settle(h.peek()!, {
        ok: false,
        error: err(409, { code: "COUNTER_SALE_DAY_CLOSED", invoiceId: "inv-1" }),
      });
      expect(h.hasUnknown()).toBe(true);
    });
  });

  it("paymentKeyRefusalCopy: the fixed copy per code (never the raw server text), null otherwise", () => {
    expect(PAYMENT_KEY_RESOLVED_COPY).toBe(
      "This payment attempt was cancelled — nothing was charged. Start a new payment.",
    );
    expect(paymentKeyRefusalCopy(resolvedOnSave())).toBe(PAYMENT_KEY_RESOLVED_COPY);
    expect(paymentKeyRefusalCopy(inFlight())).toBe(PAYMENT_STATUS_COPY.inFlight);
    expect(paymentKeyRefusalCopy(conflict())).toBe(PAYMENT_MAY_BE_RECORDED_COPY);
    expect(paymentKeyRefusalCopy(err(409, { code: "OTHER" }))).toBeNull();
    expect(paymentKeyRefusalCopy(err(503))).toBeNull();
    // the app-wide toast carries the same fixed lines
    expect(genericToastCopy(resolvedOnSave())).toBe(PAYMENT_KEY_RESOLVED_COPY);
    expect(genericToastCopy(inFlight())).toBe(PAYMENT_STATUS_COPY.inFlight);
  });

  it("fixed copy only", () => {
    expect(PAYMENT_STATUS_COPY.action).toBe("Check payment status");
    expect(paymentStatusCopy({ kind: "found", payment: {} })).toBe("This payment was recorded.");
    expect(paymentStatusCopy({ kind: "tombstoned" })).toBe(PAYMENT_KEY_RESOLVED_COPY);
    expect(paymentStatusCopy({ kind: "inFlight" })).toBe(
      "This payment is still being recorded. Check its status again in a moment.",
    );
    expect(paymentStatusCopy({ kind: "idle" })).toBe("Nothing was recorded. You can try again.");
    expect(paymentStatusCopy({ kind: "error" })).toBe(
      "We couldn't check right now. Try again in a moment.",
    );
  });
});
