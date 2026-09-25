// Behavioural test of the REAL persisted store + the capture settle handlers the hook spreads
// into useMutation (replaces a source-regex wiring pin: it could not tell a correct call from
// a comment containing the same text).
jest.mock("../lib/user-scoped-storage", () => ({
  userScopedStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

import { useInlineReturnSubmissionStore } from "../store/inlineReturnSubmissionStore";
import {
  captureSettleHandlers,
  inlineReturnNonceKey,
  inlineReturnSubmitKey,
} from "../lib/inline-return-submit-key";

const store = () => useInlineReturnSubmissionStore.getState();
const KEY = inlineReturnNonceKey("c", "o");
const vars = (nonce: string) => ({
  customerId: "c",
  orderId: "o",
  returnKey: inlineReturnSubmitKey({ customerId: "c", orderId: "o" }, nonce),
});

beforeEach(() => store().reset());

describe("useCaptureInlineReturn settle wiring against the real store", () => {
  it("success settles only the attempt's own nonce; the next attempt mints fresh", () => {
    const n1 = store().getOrCreateNonce(KEY);
    captureSettleHandlers(store().settleCapture).onSuccess(undefined, vars(n1));
    expect(store().nonces[KEY]).toBeUndefined();
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
  });

  it("a 5xx and a timeout keep the nonce, so a retry resends the SAME key (double-credit guard)", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const h = captureSettleHandlers(store().settleCapture);
    h.onError({ response: { status: 503, data: {} } }, vars(n1));
    h.onError({ code: "ECONNABORTED" }, vars(n1));
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
  });

  it("a 403 refusal settles; an offline-queued error does not", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const h = captureSettleHandlers(store().settleCapture);
    h.onError({ isOfflineQueued: true }, vars(n1));
    expect(store().nonces[KEY]).toBe(n1);
    h.onError({ response: { status: 403, data: {} } }, vars(n1));
    expect(store().nonces[KEY]).toBeUndefined();
  });

  it("a late result from an OLD attempt never clears a NEWER attempt's nonce", () => {
    const n1 = store().getOrCreateNonce(KEY);
    store().settleCapture(vars(n1), { kind: "success" });
    const n2 = store().getOrCreateNonce(KEY);
    // the old attempt's queued outcome arrives late
    captureSettleHandlers(store().settleCapture).onSuccess(undefined, vars(n1));
    expect(store().nonces[KEY]).toBe(n2);
  });

  it("seedFromQueues merges the signed-in user's queued nonce and never overrides an existing one", () => {
    const n1 = store().getOrCreateNonce(KEY);
    store().seedFromQueues(
      [{ endpoint: "/returns/inline/capture", body: vars("other") }],
      [
        {
          action: { endpoint: "/returns/inline/capture", body: { ...vars("n9"), orderId: "o2" } },
          reason: "HTTP 500: x",
        },
      ],
      "u1",
    );
    expect(store().nonces[KEY]).toBe(n1);
    expect(store().nonces[inlineReturnNonceKey("c", "o2")]).toBe("n9");
  });
});
