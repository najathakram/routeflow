import {
  clearNonce,
  getOrCreateNonce,
  inlineReturnNonceKey,
  inlineReturnSubmitKey,
  shouldSettleInlineReturnNonce,
  type NonceMap,
} from "../lib/inline-return-submit-key";

describe("inlineReturnSubmitKey", () => {
  it("is stable regardless of the order items were entered in (sorted internally)", () => {
    const a = inlineReturnSubmitKey(
      {
        customerId: "cust-1",
        orderId: "order-1",
        items: [
          { productId: "p2", boxes: 0, pieces: 3 },
          { productId: "p1", boxes: 1, pieces: 0 },
        ],
      },
      "nonce-A",
    );
    const b = inlineReturnSubmitKey(
      {
        customerId: "cust-1",
        orderId: "order-1",
        items: [
          { productId: "p1", boxes: 1, pieces: 0 },
          { productId: "p2", boxes: 0, pieces: 3 },
        ],
      },
      "nonce-A",
    );
    expect(a).toBe(b);
  });

  it("changes when the quantities change — a re-quote is a NEW attempt, not a replay (SA-071b §8.1a(5))", () => {
    const base = { customerId: "cust-1", orderId: "order-1" };
    const before = inlineReturnSubmitKey(
      { ...base, items: [{ productId: "p1", boxes: 0, pieces: 10 }] },
      "nonce-A",
    );
    const afterRequote = inlineReturnSubmitKey(
      { ...base, items: [{ productId: "p1", boxes: 0, pieces: 4 }] },
      "nonce-A",
    );
    expect(afterRequote).not.toBe(before);
  });

  it("changes when the nonce changes, even for identical items", () => {
    const payload = {
      customerId: "cust-1",
      orderId: "order-1",
      items: [{ productId: "p1", boxes: 0, pieces: 3 }],
    };
    expect(inlineReturnSubmitKey(payload, "nonce-A")).not.toBe(
      inlineReturnSubmitKey(payload, "nonce-B"),
    );
  });

  it("scopes by customer and order — different orders never collide", () => {
    const items = [{ productId: "p1", boxes: 0, pieces: 3 }];
    const a = inlineReturnSubmitKey({ customerId: "cust-1", orderId: "order-1", items }, "n");
    const b = inlineReturnSubmitKey({ customerId: "cust-1", orderId: "order-2", items }, "n");
    expect(a).not.toBe(b);
  });
});

describe("inlineReturnNonceKey", () => {
  it("is the plain customerId:orderId pair", () => {
    expect(inlineReturnNonceKey("cust-1", "order-1")).toBe("cust-1:order-1");
  });
});

describe("idempotency property — the whole reason this file exists", () => {
  // This is the property Gate mattered on: web's PR 1 used a plain useRef UUID, which is
  // correct for web (no offline queue) but would be a duplicate-credit defect on mobile,
  // where an app kill + relaunch + offline-queue replay must reuse the SAME returnKey. Pinned
  // here via the pure reducer only — no AsyncStorage/zustand needed, since
  // inlineReturnSubmissionStore.ts is a thin, untested pass-through of these exact functions
  // (same split as returnSubmissionStore.ts / returns-logic.ts).

  it("survives a simulated relaunch: re-reading the SAME (persisted) nonce map returns the identical nonce and returnKey", () => {
    let nonces: NonceMap = {};
    const key = inlineReturnNonceKey("cust-1", "order-1");
    const items = [{ productId: "p1", boxes: 0, pieces: 3 }];

    // Attempt 1 mints a nonce and derives the returnKey sent on the wire.
    const first = getOrCreateNonce(nonces, key, () => "nonce-A");
    nonces = first.nonces;
    const returnKey1 = inlineReturnSubmitKey(
      { customerId: "cust-1", orderId: "order-1", items },
      first.nonce,
    );

    // Simulate an app kill + relaunch: a FRESH call against the same (persisted) map — the
    // `mint` callback deliberately returns a value that must NEVER be used, so this test fails
    // loudly if the reducer regenerates instead of reusing.
    const afterRelaunch = getOrCreateNonce(nonces, key, () => "REGENERATED-NONCE-IS-A-BUG");
    const returnKey2 = inlineReturnSubmitKey(
      { customerId: "cust-1", orderId: "order-1", items },
      afterRelaunch.nonce,
    );

    expect(afterRelaunch.nonce).toBe(first.nonce);
    expect(returnKey2).toBe(returnKey1);
  });

  it("a terminal state clears the nonce, so the NEXT attempt mints a genuinely fresh one", () => {
    let nonces: NonceMap = {};
    const key = inlineReturnNonceKey("cust-1", "order-1");

    const first = getOrCreateNonce(nonces, key, () => "nonce-A");
    nonces = first.nonces;

    // The attempt landed (or was definitively refused) — clear it.
    nonces = clearNonce(nonces, key);
    expect(nonces[key]).toBeUndefined();

    const next = getOrCreateNonce(nonces, key, () => "nonce-B");
    expect(next.nonce).not.toBe(first.nonce);
    expect(next.nonce).toBe("nonce-B");
  });

  it("clearing a key with no nonce is a no-op (never throws, never mutates unrelated keys)", () => {
    const nonces: NonceMap = { "cust-2:order-2": "nonce-other" };
    const result = clearNonce(nonces, "cust-1:order-1");
    expect(result).toEqual(nonces);
  });

  it("two different (customer, order) pairs never share a nonce", () => {
    let nonces: NonceMap = {};
    const a = getOrCreateNonce(nonces, inlineReturnNonceKey("cust-1", "order-1"), () => "nonce-A");
    nonces = a.nonces;
    const b = getOrCreateNonce(nonces, inlineReturnNonceKey("cust-1", "order-2"), () => "nonce-B");
    expect(b.nonce).toBe("nonce-B");
    expect(b.nonce).not.toBe(a.nonce);
  });
});

describe("shouldSettleInlineReturnNonce — B742-sibling, SA-091", () => {
  // Before this fix: nothing ever called markCaptureSettled from useCaptureInlineReturn, so a
  // GENUINE second return with the same quantities on the same customer/order pair derived the
  // SAME returnKey as the first and the server silently replayed the old record — no second
  // return, no credit. These three cases are the whole fix.

  it("success settles", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "success" })).toBe(true);
  });

  it("an error the server actually responded to (a refusal) settles — it is terminal, same as success", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "error", reachedServer: true })).toBe(true);
  });

  it("an error with no response at all (connectivity, or killed before one arrived) does NOT settle — the offline queue must replay with the SAME key", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "error", reachedServer: false })).toBe(false);
  });

  it("end-to-end: settling after success/a 4xx mints a genuinely fresh nonce for the next attempt; not settling after a connectivity error keeps the same one", () => {
    const key = inlineReturnNonceKey("cust-1", "order-1");

    // Success case.
    let nonces: NonceMap = {};
    const attempt1 = getOrCreateNonce(nonces, key, () => "nonce-A");
    nonces = attempt1.nonces;
    if (shouldSettleInlineReturnNonce({ kind: "success" })) nonces = clearNonce(nonces, key);
    const attempt2 = getOrCreateNonce(nonces, key, () => "nonce-B");
    expect(attempt2.nonce).not.toBe(attempt1.nonce);

    // 4xx case, fresh map.
    nonces = {};
    const a1 = getOrCreateNonce(nonces, key, () => "nonce-C");
    nonces = a1.nonces;
    if (shouldSettleInlineReturnNonce({ kind: "error", reachedServer: true }))
      nonces = clearNonce(nonces, key);
    const a2 = getOrCreateNonce(nonces, key, () => "nonce-D");
    expect(a2.nonce).not.toBe(a1.nonce);

    // Connectivity-error case, fresh map: the nonce must survive for the queue's replay.
    nonces = {};
    const b1 = getOrCreateNonce(nonces, key, () => "nonce-E");
    nonces = b1.nonces;
    if (shouldSettleInlineReturnNonce({ kind: "error", reachedServer: false }))
      nonces = clearNonce(nonces, key);
    const b2 = getOrCreateNonce(nonces, key, () => "REGENERATED-NONCE-IS-A-BUG");
    expect(b2.nonce).toBe(b1.nonce);
  });
});
