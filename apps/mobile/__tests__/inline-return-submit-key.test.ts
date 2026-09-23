import {
  captureOutcomeFromError,
  clearNonce,
  getOrCreateNonce,
  inlineReturnDrainSettleRecords,
  inlineReturnNonceKey,
  inlineReturnSubmitKey,
  isDefiniteInlineReturnRefusal,
  nonceSuffixFromReturnKey,
  RETURN_STATE_RACE_RETRY_MESSAGE,
  settleAfterDrain,
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

describe("shouldSettleInlineReturnNonce — B742-sibling, SA-091/SA-091a", () => {
  // Before this fix: nothing ever called markCaptureSettled from useCaptureInlineReturn, so a
  // GENUINE second return with the same quantities on the same customer/order pair derived the
  // SAME returnKey as the first and the server silently replayed the old record — no second
  // return, no credit.
  //
  // SA-091a precision: "the server answered" is not the same thing as "the outcome is known".
  // A 5xx means the request reached the server, but whether the capture COMMITTED before the
  // response failed is unknown — settling on a 5xx would let a retry mint a fresh key and
  // double-book if the first attempt actually landed. Only a DEFINITE 4xx refusal is terminal.

  it("success settles", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "success" })).toBe(true);
  });

  it("a definite 4xx refusal settles — terminal, same as success", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "error", refused: true })).toBe(true);
  });

  it("a 5xx does NOT settle — the server answered, but whether the capture committed is unknown", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "error", refused: false })).toBe(false);
  });

  it("an error with no response at all (connectivity, or killed before one arrived) does NOT settle — equally uncertain, same as a 5xx", () => {
    expect(shouldSettleInlineReturnNonce({ kind: "error", refused: false })).toBe(false);
  });

  it("end-to-end: a 500 gives the SAME nonce on the next attempt", () => {
    const key = inlineReturnNonceKey("cust-1", "order-1");
    let nonces: NonceMap = {};
    const attempt1 = getOrCreateNonce(nonces, key, () => "nonce-500-a");
    nonces = attempt1.nonces;
    if (shouldSettleInlineReturnNonce({ kind: "error", refused: false }))
      nonces = clearNonce(nonces, key);
    const attempt2 = getOrCreateNonce(nonces, key, () => "REGENERATED-NONCE-IS-A-BUG");
    expect(attempt2.nonce).toBe(attempt1.nonce);
  });

  it.each([409, 400, 422])("end-to-end: a %i gives a FRESH nonce on the next attempt", (status) => {
    const key = inlineReturnNonceKey("cust-1", "order-1");
    let nonces: NonceMap = {};
    const attempt1 = getOrCreateNonce(nonces, key, () => `nonce-${status}-a`);
    nonces = attempt1.nonces;
    const refused = status >= 400 && status < 500;
    if (shouldSettleInlineReturnNonce({ kind: "error", refused })) nonces = clearNonce(nonces, key);
    const attempt2 = getOrCreateNonce(nonces, key, () => `nonce-${status}-b`);
    expect(attempt2.nonce).not.toBe(attempt1.nonce);
  });

  it("end-to-end: success mints fresh; a connectivity error (no response) keeps the same one", () => {
    const key = inlineReturnNonceKey("cust-1", "order-1");

    // Success case.
    let nonces: NonceMap = {};
    const attempt1 = getOrCreateNonce(nonces, key, () => "nonce-A");
    nonces = attempt1.nonces;
    if (shouldSettleInlineReturnNonce({ kind: "success" })) nonces = clearNonce(nonces, key);
    const attempt2 = getOrCreateNonce(nonces, key, () => "nonce-B");
    expect(attempt2.nonce).not.toBe(attempt1.nonce);

    // Connectivity-error case, fresh map: the nonce must survive for the queue's replay.
    nonces = {};
    const b1 = getOrCreateNonce(nonces, key, () => "nonce-E");
    nonces = b1.nonces;
    if (shouldSettleInlineReturnNonce({ kind: "error", refused: false }))
      nonces = clearNonce(nonces, key);
    const b2 = getOrCreateNonce(nonces, key, () => "REGENERATED-NONCE-IS-A-BUG");
    expect(b2.nonce).toBe(b1.nonce);
  });
});

describe("isDefiniteInlineReturnRefusal — SA-091b precision", () => {
  it("a 400/422 is a definite refusal", () => {
    expect(isDefiniteInlineReturnRefusal(400, "Bad request")).toBe(true);
    expect(isDefiniteInlineReturnRefusal(422, "Unprocessable")).toBe(true);
  });

  it("a 500/503 is NOT a definite refusal — the outcome is unknown", () => {
    expect(isDefiniteInlineReturnRefusal(500, "Internal error")).toBe(false);
    expect(isDefiniteInlineReturnRefusal(503, "Service unavailable")).toBe(false);
  });

  it("no status at all is NOT a definite refusal", () => {
    expect(isDefiniteInlineReturnRefusal(undefined, undefined)).toBe(false);
  });

  it(`a 409 whose message ends in "retry" (the stuck-row race signal) is NOT a definite refusal`, () => {
    expect(isDefiniteInlineReturnRefusal(409, RETURN_STATE_RACE_RETRY_MESSAGE)).toBe(false);
  });

  it("an ORDINARY 409 (no retry suffix) IS a definite refusal", () => {
    expect(
      isDefiniteInlineReturnRefusal(409, "A different return already used this capture key"),
    ).toBe(true);
  });
});

describe("captureOutcomeFromError — axios-shaped fixtures", () => {
  it("a 400 response classifies as a definite refusal", () => {
    const err = { response: { status: 400, data: { message: "Bad request" } } };
    expect(captureOutcomeFromError(err)).toEqual({ kind: "error", refused: true });
  });

  it("a 503 response classifies as NOT a definite refusal", () => {
    const err = { response: { status: 503, data: { message: "Service unavailable" } } };
    expect(captureOutcomeFromError(err)).toEqual({ kind: "error", refused: false });
  });

  it("the retry-409 classifies as NOT a definite refusal, even though the server answered", () => {
    const err = { response: { status: 409, data: { message: RETURN_STATE_RACE_RETRY_MESSAGE } } };
    expect(captureOutcomeFromError(err)).toEqual({ kind: "error", refused: false });
  });

  it('an isOfflineQueued error classifies as "queued" — a distinct third shape, not an error at all', () => {
    const err = Object.assign(new Error("You are offline. Action queued."), {
      isOfflineQueued: true,
    });
    expect(captureOutcomeFromError(err)).toEqual({ kind: "queued" });
  });

  it("an ECONNABORTED timeout with no response classifies as NOT a definite refusal", () => {
    const err = { code: "ECONNABORTED", message: "timeout of 30000ms exceeded" };
    expect(captureOutcomeFromError(err)).toEqual({ kind: "error", refused: false });
  });
});

describe("nonceSuffixFromReturnKey", () => {
  it("is the final colon-delimited segment, regardless of how many colon-bearing item pairs precede it", () => {
    const key = inlineReturnSubmitKey(
      {
        customerId: "cust-1",
        orderId: "order-1",
        items: [
          { productId: "p1", boxes: 1, pieces: 2 },
          { productId: "p2", boxes: 0, pieces: 3 },
        ],
      },
      "nonce-XYZ",
    );
    expect(nonceSuffixFromReturnKey(key)).toBe("nonce-XYZ");
  });
});

describe("settleAfterDrain — the offline-queue's settle pass (SA-091/SA-091b)", () => {
  it("a delivered record settles when the stored nonce still matches", () => {
    const key = inlineReturnNonceKey("cust-1", "order-1");
    const nonces: NonceMap = { [key]: "nonce-A" };
    const result = settleAfterDrain(
      [{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-A" }],
      nonces,
    );
    expect(result[key]).toBeUndefined();
  });

  it("a failed-4xx record settles exactly the same as delivered", () => {
    // The caller is responsible for excluding the retry-409 and any 5xx from `records` in the
    // first place (via isDefiniteInlineReturnRefusal) — this helper only applies the equality
    // guard, so a "failed-4xx" and a "delivered" record look identical to it, on purpose.
    const key = inlineReturnNonceKey("cust-1", "order-1");
    const nonces: NonceMap = { [key]: "nonce-B" };
    const result = settleAfterDrain(
      [{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-B" }],
      nonces,
    );
    expect(result[key]).toBeUndefined();
  });

  it("a retried (still-queued) entry is never passed in, so it can never settle", () => {
    // Simulates the caller correctly omitting a retriedId from `records` entirely.
    const key = inlineReturnNonceKey("cust-1", "order-1");
    const nonces: NonceMap = { [key]: "nonce-C" };
    const result = settleAfterDrain([], nonces);
    expect(result[key]).toBe("nonce-C");
  });

  it("the equality guard: a stale record's nonceSuffix no longer matches (a NEWER attempt already re-minted) — never clears the newer one", () => {
    const key = inlineReturnNonceKey("cust-1", "order-1");
    const nonces: NonceMap = { [key]: "nonce-NEW" }; // a later attempt already re-minted
    const result = settleAfterDrain(
      [{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-OLD" }],
      nonces,
    );
    expect(result[key]).toBe("nonce-NEW");
  });

  it("multiple records for different pairs settle independently", () => {
    const keyA = inlineReturnNonceKey("cust-1", "order-1");
    const keyB = inlineReturnNonceKey("cust-2", "order-2");
    const nonces: NonceMap = { [keyA]: "nonce-A", [keyB]: "nonce-B" };
    const result = settleAfterDrain(
      [{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-A" }],
      nonces,
    );
    expect(result[keyA]).toBeUndefined();
    expect(result[keyB]).toBe("nonce-B");
  });
});

describe("inlineReturnDrainSettleRecords — bridges useNetworkSync's raw drain result into settleAfterDrain's input (SA-091b)", () => {
  // SA-091b: "a capture delivered from the OFFLINE QUEUE never settles its nonce ... The drain
  // only dequeues it (hooks/useNetworkSync.ts:83-93). Fix: after the drain, for each delivered
  // or failed /returns/inline/capture entry, settle inlineReturnNonceKey(...), but ONLY when the
  // stored nonce still equals the one embedded in body.returnKey." This helper is that decision,
  // covering all three drain classes: delivered, failed-4xx, retried (never passed in at all).
  const captureAction = (id: string, returnKey: string, overrides?: Record<string, unknown>) => ({
    id,
    endpoint: "/returns/inline/capture",
    body: { customerId: "cust-1", orderId: "order-1", returnKey, ...overrides },
  });

  it("a delivered capture entry is included, keyed off its own body", () => {
    const attempted = [captureAction("a1", "inl:cust-1:order-1:p1x3:nonce-A")];
    const result = inlineReturnDrainSettleRecords({
      delivered: ["a1"],
      failedActions: [],
      attempted,
    });
    expect(result).toEqual([{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-A" }]);
  });

  it("a failed entry with a DEFINITE 4xx refusal is included", () => {
    const attempted = [captureAction("a2", "inl:cust-1:order-1:p1x3:nonce-B")];
    const result = inlineReturnDrainSettleRecords({
      delivered: [],
      failedActions: [{ action: attempted[0], reason: "HTTP 400: Bad request" }],
      attempted,
    });
    expect(result).toEqual([{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-B" }]);
  });

  it("a failed entry that is the retry-409 (stuck-row race) is EXCLUDED — still queued/uncertain", () => {
    const attempted = [captureAction("a3", "inl:cust-1:order-1:p1x3:nonce-C")];
    const result = inlineReturnDrainSettleRecords({
      delivered: [],
      failedActions: [
        { action: attempted[0], reason: `HTTP 409: ${RETURN_STATE_RACE_RETRY_MESSAGE}` },
      ],
      attempted,
    });
    expect(result).toEqual([]);
  });

  it("a failed entry with a 5xx is EXCLUDED — outcome unknown, same as the direct onError path", () => {
    const attempted = [captureAction("a4", "inl:cust-1:order-1:p1x3:nonce-D")];
    const result = inlineReturnDrainSettleRecords({
      delivered: [],
      failedActions: [{ action: attempted[0], reason: "HTTP 503: Service unavailable" }],
      attempted,
    });
    expect(result).toEqual([]);
  });

  it("a retried (still-queued) id is simply absent from both delivered/failedActions — nothing to filter, it never appears", () => {
    const attempted = [captureAction("a5", "inl:cust-1:order-1:p1x3:nonce-E")];
    const result = inlineReturnDrainSettleRecords({
      delivered: [],
      failedActions: [],
      attempted,
    });
    expect(result).toEqual([]);
  });

  it("a non-capture endpoint (e.g. a standard-return submit) is ignored even if delivered and shaped like a capture body", () => {
    // Same body shape a capture would have (customerId/orderId/returnKey all present) — the
    // ONLY thing excluding this entry must be the endpoint check, not a missing field.
    const attempted = [
      {
        id: "b1",
        endpoint: "/returns/submit",
        body: { customerId: "cust-1", orderId: "order-1", returnKey: "std:cust-1:order-1:nonce-Z" },
      },
    ];
    const result = inlineReturnDrainSettleRecords({
      delivered: ["b1"],
      failedActions: [],
      attempted,
    });
    expect(result).toEqual([]);
  });

  it("multiple qualifying entries across delivered and failed-4xx are all included", () => {
    const attempted = [
      captureAction("c1", "inl:cust-1:order-1:p1x3:nonce-F"),
      captureAction("c2", "inl:cust-2:order-2:p1x3:nonce-G", {
        customerId: "cust-2",
        orderId: "order-2",
      }),
    ];
    const result = inlineReturnDrainSettleRecords({
      delivered: ["c1"],
      failedActions: [{ action: attempted[1], reason: "HTTP 422: Unprocessable" }],
      attempted,
    });
    expect(result).toEqual([
      { customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-F" },
      { customerId: "cust-2", orderId: "order-2", nonceSuffix: "nonce-G" },
    ]);
  });
});
