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
  noncesFromQueues,
  pruneSettledKeys,
  SETTLED_KEY_MAX_AGE_MS,
  SETTLED_KEY_CAP,
  settleAfterDrain,
  settleDirectCapture,
  clearNonceIf,
  captureSettleHandlers,
  directFailureActionId,
  directFailureRecord,
  shouldSettleInlineReturnNonce,
  type NonceMap,
} from "../lib/inline-return-submit-key";

describe("inlineReturnSubmitKey", () => {
  it("is independent of the quantities — ONE key per capture ATTEMPT, stable across edits and re-quotes (Opus review of #1270, point 1)", () => {
    // A capture that timed out AFTER the server committed, then edited (12 -> 10) or re-quoted
    // ("return only what was bought"), must resend the SAME key so the server collapses it onto
    // the committed Return. A quantity-derived key minted a second Return, credit and restock.
    const base = { customerId: "cust-1", orderId: "order-1" };
    const before = inlineReturnSubmitKey(
      { ...base, items: [{ productId: "p1", boxes: 0, pieces: 12 }] } as any,
      "nonce-A",
    );
    const afterEdit = inlineReturnSubmitKey(
      { ...base, items: [{ productId: "p1", boxes: 0, pieces: 10 }] } as any,
      "nonce-A",
    );
    const noItems = inlineReturnSubmitKey(base, "nonce-A");
    expect(afterEdit).toBe(before);
    expect(noItems).toBe(before);
  });

  it("changes when the nonce changes", () => {
    const payload = { customerId: "cust-1", orderId: "order-1" };
    expect(inlineReturnSubmitKey(payload, "nonce-A")).not.toBe(
      inlineReturnSubmitKey(payload, "nonce-B"),
    );
  });

  it("scopes by customer and order — different orders never collide", () => {
    const a = inlineReturnSubmitKey({ customerId: "cust-1", orderId: "order-1" }, "n");
    const b = inlineReturnSubmitKey({ customerId: "cust-1", orderId: "order-2" }, "n");
    expect(a).not.toBe(b);
  });

  it("round-trips its nonce through nonceSuffixFromReturnKey", () => {
    const key = inlineReturnSubmitKey({ customerId: "c", orderId: "o" }, "0a1b-2c3d");
    expect(nonceSuffixFromReturnKey(key)).toBe("0a1b-2c3d");
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

    // Attempt 1 mints a nonce and derives the returnKey sent on the wire.
    const first = getOrCreateNonce(nonces, key, () => "nonce-A");
    nonces = first.nonces;
    const returnKey1 = inlineReturnSubmitKey(
      { customerId: "cust-1", orderId: "order-1" },
      first.nonce,
    );

    // Simulate an app kill + relaunch: a FRESH call against the same (persisted) map — the
    // `mint` callback deliberately returns a value that must NEVER be used, so this test fails
    // loudly if the reducer regenerates instead of reusing.
    const afterRelaunch = getOrCreateNonce(nonces, key, () => "REGENERATED-NONCE-IS-A-BUG");
    const returnKey2 = inlineReturnSubmitKey(
      { customerId: "cust-1", orderId: "order-1" },
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

  // The REAL classifier (captureOutcomeFromError over an axios-shaped error) decides refused —
  // the test never derives "refused" itself.
  it.each([
    [400, "Bad request", undefined, false], // code-less 400 (the validation pipe) KEEPS
    [401, "Unauthorized", undefined, false],
    [403, "Forbidden", undefined, false], // SA-204: a 403 KEEPS (permission may be restored)
    [408, "Timeout", undefined, false],
    [429, "Too many", undefined, false],
    [409, RETURN_STATE_RACE_RETRY_MESSAGE, undefined, false],
    [500, "boom", undefined, false],
    [
      400,
      "Cannot capture a return against a cancelled order",
      "INLINE_RETURN_ORDER_CANCELLED",
      true,
    ],
    [409, "A different return already used this capture key", "INLINE_RETURN_KEY_CONFLICT", true],
    [404, "Order not found", "INLINE_RETURN_ORDER_NOT_FOUND", true],
    [403, "This feature requires the add-on", "ADDON_GATE", false], // another guard's code: KEEPS
  ])(
    "end-to-end: a real %i (%s, code %s) -> fresh nonce next attempt is %s",
    (status, message, code, fresh) => {
      const key = inlineReturnNonceKey("cust-1", "order-1");
      const nonces0 = getOrCreateNonce({}, key, () => "nonce-a").nonces;
      const err = { response: { status, data: { message, code } } };
      const after = settleDirectCapture(
        nonces0,
        {
          customerId: "cust-1",
          orderId: "order-1",
          returnKey: inlineReturnSubmitKey({ customerId: "cust-1", orderId: "order-1" }, "nonce-a"),
        },
        captureOutcomeFromError(err),
      );
      const attempt2 = getOrCreateNonce(after, key, () => "nonce-b");
      expect(attempt2.nonce).toBe(fresh ? "nonce-b" : "nonce-a");
    },
  );

  it("a 403 AFTER an uncertain timeout keeps the same nonce, and the retry after permission is restored resends the SAME key", () => {
    const key = inlineReturnNonceKey("c", "o");
    const nonces0 = getOrCreateNonce({}, key, () => "nonce-a").nonces;
    const v = {
      customerId: "c",
      orderId: "o",
      returnKey: inlineReturnSubmitKey({ customerId: "c", orderId: "o" }, "nonce-a"),
    };
    let nonces = settleDirectCapture(nonces0, v, captureOutcomeFromError({ code: "ECONNABORTED" }));
    nonces = settleDirectCapture(
      nonces,
      v,
      captureOutcomeFromError({ response: { status: 403, data: {} } }),
    );
    const retry = getOrCreateNonce(nonces, key, () => "REGENERATED-IS-A-BUG");
    expect(inlineReturnSubmitKey({ customerId: "c", orderId: "o" }, retry.nonce)).toBe(v.returnKey);
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

describe("isDefiniteInlineReturnRefusal — SA-204: a 4xx settles ONLY with the capture service's own code", () => {
  it.each([
    "INLINE_RETURN_ORDER_NOT_FOUND",
    "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
    "INLINE_RETURN_ORDER_CANCELLED",
    "INLINE_RETURN_KEY_CONFLICT",
    "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
  ])("a 4xx carrying %s is a definite refusal", (code) => {
    expect(isDefiniteInlineReturnRefusal(400, code)).toBe(true);
    expect(isDefiniteInlineReturnRefusal(409, code)).toBe(true);
  });

  it.each([400, 401, 403, 404, 408, 409, 422, 429])("a code-less %i KEEPS", (status) => {
    expect(isDefiniteInlineReturnRefusal(status, undefined)).toBe(false);
  });

  it("another component's code (guards, throttler) is not the capture service's own: KEEPS", () => {
    expect(isDefiniteInlineReturnRefusal(403, "ADDON_GATE")).toBe(false);
    expect(isDefiniteInlineReturnRefusal(400, "VALIDATION")).toBe(false);
  });

  it("a 5xx or no status never settles, even with a code", () => {
    expect(isDefiniteInlineReturnRefusal(500, "INLINE_RETURN_ORDER_CANCELLED")).toBe(false);
    expect(isDefiniteInlineReturnRefusal(undefined, undefined)).toBe(false);
  });

  it("the retry-409 keeps even if it ever carried a code", () => {
    expect(
      isDefiniteInlineReturnRefusal(
        409,
        "INLINE_RETURN_KEY_CONFLICT",
        RETURN_STATE_RACE_RETRY_MESSAGE,
      ),
    ).toBe(false);
  });
});

describe("captureOutcomeFromError — axios-shaped fixtures", () => {
  it("a coded 400 response classifies as a definite refusal; a code-less 400 does not", () => {
    const coded = {
      response: { status: 400, data: { message: "x", code: "INLINE_RETURN_ORDER_CANCELLED" } },
    };
    expect(captureOutcomeFromError(coded)).toEqual({ kind: "error", refused: true });
    const plain = { response: { status: 400, data: { message: "Bad request" } } };
    expect(captureOutcomeFromError(plain)).toEqual({ kind: "error", refused: false });
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
  it("is the final colon-delimited segment, regardless of how many colon-bearing segments precede it", () => {
    const key = inlineReturnSubmitKey({ customerId: "cust-1", orderId: "order-1" }, "nonce-XYZ");
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
      failedActions: [
        {
          action: attempted[0],
          reason: "HTTP 400: Bad request",
          code: "INLINE_RETURN_ORDER_CANCELLED",
        },
      ],
      attempted,
    });
    expect(result).toEqual([{ customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-B" }]);
  });

  it("a failed entry that is the retry-409 (stuck-row race) is EXCLUDED - uncertain, nonce kept (drainQueue drops the 409 into failedActions; it is not still queued)", () => {
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
      failedActions: [
        { action: attempted[1], reason: "HTTP 409: dup", code: "INLINE_RETURN_KEY_CONFLICT" },
      ],
      attempted,
    });
    expect(result).toEqual([
      { customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-F" },
      { customerId: "cust-2", orderId: "order-2", nonceSuffix: "nonce-G" },
    ]);
  });
});

describe("clearNonceIf — a settle clears only its OWN nonce (Opus review of #1270, point 2)", () => {
  it("clears when the stored nonce equals the settling attempt's", () => {
    expect(clearNonceIf({ "c:o": "n1" }, "c:o", "n1")).toEqual({});
  });
  it("leaves a NEWER attempt's nonce (or another key) alone", () => {
    const m: NonceMap = { "c:o": "n2", "c:o2": "n9" };
    expect(clearNonceIf(m, "c:o", "n1")).toBe(m);
  });
});

describe("settleDirectCapture / captureSettleHandlers — behavioural wiring", () => {
  const vars = (nonce: string) => ({
    customerId: "c",
    orderId: "o",
    returnKey: inlineReturnSubmitKey({ customerId: "c", orderId: "o" }, nonce),
  });

  it("a late settle from an OLD attempt never clears a newer attempt's nonce", () => {
    const after = settleDirectCapture({ "c:o": "n2" }, vars("n1"), { kind: "success" });
    expect(after).toEqual({ "c:o": "n2" });
  });

  it("a queued outcome never settles", () => {
    expect(settleDirectCapture({ "c:o": "n1" }, vars("n1"), { kind: "queued" })).toEqual({
      "c:o": "n1",
    });
  });

  it("handlers: onSuccess settles with success; onError classifies the raw error", () => {
    const calls: Array<[unknown, unknown]> = [];
    const h = captureSettleHandlers((v, o) => calls.push([v, o]));
    h.onSuccess(undefined, vars("n1"));
    h.onError({ response: { status: 403, data: {} } }, vars("n1"));
    h.onError({ response: { status: 503, data: {} } }, vars("n1"));
    h.onError({ isOfflineQueued: true }, vars("n1"));
    expect(calls.map(([, o]) => o)).toEqual([
      { kind: "success" },
      { kind: "error", refused: false }, // a 403 KEEPS (SA-204)
      { kind: "error", refused: false },
      { kind: "queued" },
    ]);
    expect(calls[0]![0]).toEqual(vars("n1"));
  });
});

describe("429 and 408 are NOT final refusals — the nonce is kept (Opus review of #1270)", () => {
  // The global throttler (429) and a request timeout (408) answer BEFORE the returnKey lookup,
  // so nothing was written and nothing about the capture is settled: a retry must resend the
  // SAME key.
  it.each([429, 408])("a %i is not a definite refusal", (status) => {
    expect(isDefiniteInlineReturnRefusal(status, "INLINE_RETURN_ORDER_CANCELLED")).toBe(false);
    expect(captureOutcomeFromError({ response: { status, data: { message: "x" } } })).toEqual({
      kind: "error",
      refused: false,
    });
  });
  it("a queued capture that the drain moves to failedActions with HTTP 429 does not settle", () => {
    const attempted = [
      {
        id: "t1",
        endpoint: "/returns/inline/capture",
        body: { customerId: "c", orderId: "o", returnKey: "inl:c:o:n1" },
      },
    ];
    expect(
      inlineReturnDrainSettleRecords({
        delivered: [],
        failedActions: [{ action: attempted[0]!, reason: "HTTP 429: Too Many Requests" }],
        attempted,
      }),
    ).toEqual([]);
  });
});

describe("noncesFromQueues — rebuild the signed-in user's nonces from THEIR OWN queue + failed list", () => {
  const cap = (nonce: string, over: Record<string, unknown> = {}) => ({
    endpoint: "/returns/inline/capture",
    body: { customerId: "c", orderId: "o", returnKey: `inl:c:o:${nonce}` },
    ...over,
  });
  const failed = (action: ReturnType<typeof cap>, reason: string) => ({ action, reason });

  it("takes the nonce of a still-queued capture", () => {
    expect(noncesFromQueues([cap("n1")], [], "u1")).toEqual({ "c:o": "n1" });
  });
  it("keeps the nonce of a FAILED-ACTIONS capture with an uncertain outcome (5xx / 409-retry / retries exhausted)", () => {
    expect(noncesFromQueues([], [failed(cap("n2"), "HTTP 503: down")], "u1")).toEqual({
      "c:o": "n2",
    });
    expect(noncesFromQueues([], [failed(cap("n3"), "Retries exhausted")], "u1")).toEqual({
      "c:o": "n3",
    });
    expect(
      noncesFromQueues(
        [],
        [failed(cap("n4"), `HTTP 409: ${RETURN_STATE_RACE_RETRY_MESSAGE}`)],
        "u1",
      ),
    ).toEqual({ "c:o": "n4" });
  });
  it("drops a failed capture that was a DEFINITE refusal (terminal) and 429/408 are kept", () => {
    expect(
      noncesFromQueues(
        [],
        [{ ...failed(cap("n5"), "HTTP 400: bad"), code: "INLINE_RETURN_ORDER_CANCELLED" }],
        "u1",
      ),
    ).toEqual({});
    expect(noncesFromQueues([], [failed(cap("n5b"), "HTTP 400: bad")], "u1")).toEqual({
      "c:o": "n5b",
    }); // a code-less 400 (validation pipe) KEEPS
    expect(noncesFromQueues([], [failed(cap("n5c"), "HTTP 403: Forbidden")], "u1")).toEqual({
      "c:o": "n5c",
    });
    expect(noncesFromQueues([], [failed(cap("n6"), "HTTP 429: slow")], "u1")).toEqual({
      "c:o": "n6",
    });
  });
  it("only the signed-in user's own entries (other users' and non-capture entries are ignored)", () => {
    const mine = cap("n7", { userId: "u1" });
    const theirs = cap("n8", {
      userId: "u2",
      body: { customerId: "c", orderId: "o2", returnKey: "inl:c:o2:n8" },
    });
    const other = cap("n9", { endpoint: "/returns/submit" });
    expect(noncesFromQueues([mine, theirs, other], [failed(theirs, "HTTP 500: x")], "u1")).toEqual({
      "c:o": "n7",
    });
  });
  it("a legacy unstamped entry is adopted; the live queue wins over a failed record for the same pair", () => {
    expect(noncesFromQueues([cap("nQ")], [failed(cap("nF"), "HTTP 500: x")], "u1")).toEqual({
      "c:o": "nQ",
    });
  });
});

describe("directFailureRecord — an uncertain DIRECT capture must survive sign-out (SA-198)", () => {
  const req = {
    customerId: "c",
    orderId: "o",
    returnKey: "inl:c:o:n1",
    reason: "DAMAGED",
    items: [{ productId: "p1", qty: 1, boxes: 0, pieces: 3 }],
  } as any;
  const now = 1_700_000_000_000;

  it.each([
    [{ response: { status: 503, data: { message: "down" } } }, "HTTP 503: down"],
    [{ response: { status: 403, data: { message: "no access" } } }, "HTTP 403: no access"],
    [{ response: { status: 400, data: { message: "validation" } } }, "HTTP 400: validation"],
    [{ response: { status: 401, data: {} } }, "HTTP 401: "],
    [{ response: { status: 408, data: {} } }, "HTTP 408: "],
    [{ response: { status: 429, data: { message: "slow" } } }, "HTTP 429: slow"],
    [
      { response: { status: 409, data: { message: RETURN_STATE_RACE_RETRY_MESSAGE } } },
      `HTTP 409: ${RETURN_STATE_RACE_RETRY_MESSAGE}`,
    ],
    [{ code: "ECONNABORTED", message: "timeout" }, "No response: timeout"],
  ])("a nonce-keeping outcome %j is persisted as a failed action (%s)", (err, reason) => {
    const rec = directFailureRecord(req, err, now)!;
    expect(rec.reason).toBe(reason);
    expect(rec.action).toMatchObject({
      endpoint: "/returns/inline/capture",
      method: "POST",
      body: req,
      id: directFailureActionId(req.returnKey),
    });
    // ...and the sign-in seed reads exactly that record back into the SAME nonce.
    expect(noncesFromQueues([], [rec], "u1")).toEqual({ "c:o": "n1" });
  });

  it.each([
    [{ response: { status: 400, data: { message: "x", code: "INLINE_RETURN_ORDER_CANCELLED" } } }],
    [{ response: { status: 409, data: { message: "x", code: "INLINE_RETURN_KEY_CONFLICT" } } }],
    [{ isOfflineQueued: true }],
  ])("a coded business refusal / an offline-queued capture (%j) is NOT persisted here", (err) => {
    expect(directFailureRecord(req, err, now)).toBeNull();
  });
});

describe("captureSettleHandlers — failed-action persistence", () => {
  const vars = { customerId: "c", orderId: "o", returnKey: "inl:c:o:n1" } as any;
  const mk = () => {
    const failed = { add: jest.fn() };
    const h = captureSettleHandlers(jest.fn(), failed);
    return { failed, h };
  };
  it("a kept-nonce error records the attempt (503, timeout, plain network error with no response)", () => {
    const { failed, h } = mk();
    h.onError({ response: { status: 503, data: {} } }, vars);
    h.onError({ code: "ECONNABORTED", message: "timeout" }, vars);
    h.onError({ message: "Network Error" }, vars);
    expect(failed.add).toHaveBeenCalledTimes(3);
  });
  it("success, a definite refusal and a queued outcome record nothing (the store's settle removes records)", () => {
    const { failed, h } = mk();
    h.onSuccess(undefined, vars);
    h.onError({ response: { status: 400, data: { code: "INLINE_RETURN_ORDER_CANCELLED" } } }, vars);
    h.onError({ isOfflineQueued: true }, vars);
    expect(failed.add).not.toHaveBeenCalled();
  });
});

describe("pruneSettledKeys — tombstones are bounded but never evict a still-referenced key (SA-206/SA-220)", () => {
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;
  it("drops tombstones older than 90 days, keeps the rest in order", () => {
    expect(SETTLED_KEY_MAX_AGE_MS).toBe(90 * DAY);
    const list = [
      { key: "old", at: now - 91 * DAY },
      { key: "edge", at: now - 90 * DAY },
      { key: "new", at: now - 1 * DAY },
    ];
    expect(pruneSettledKeys(list, now).map((t) => t.key)).toEqual(["edge", "new"]);
  });
  it("caps the count, evicting OLDEST first", () => {
    const list = Array.from({ length: SETTLED_KEY_CAP + 25 }, (_, i) => ({
      key: `k${i}`,
      at: now - 1000 + i,
    }));
    const out = pruneSettledKeys(list, now);
    expect(out).toHaveLength(SETTLED_KEY_CAP);
    expect(out[0]!.key).toBe("k25");
    expect(out[out.length - 1]!.key).toBe(`k${SETTLED_KEY_CAP + 24}`);
  });
  it("NEVER evicts a key still referenced by the queue / failed list, even when aged or over the cap", () => {
    const list = Array.from({ length: SETTLED_KEY_CAP + 5 }, (_, i) => ({
      key: `k${i}`,
      at: now - 1000 + i,
    }));
    list.unshift({ key: "aged-but-queued", at: now - 200 * DAY });
    const out = pruneSettledKeys(list, now, new Set(["aged-but-queued", "k0"]));
    expect(out.map((t) => t.key)).toContain("aged-but-queued");
    expect(out.map((t) => t.key)).toContain("k0");
    expect(out).toHaveLength(SETTLED_KEY_CAP);
    expect(out.map((t) => t.key)).not.toContain("k1"); // oldest UNprotected goes first
  });
  it("returns the SAME array when nothing needs pruning", () => {
    const list = [{ key: "a", at: now }];
    expect(pruneSettledKeys(list, now)).toBe(list);
  });
});
