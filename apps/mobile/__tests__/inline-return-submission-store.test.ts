// Behavioural test of the REAL persisted store + the capture settle handlers the hook spreads
// into useMutation (replaces a source-regex wiring pin: it could not tell a correct call from
// a comment containing the same text).
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
let mockUserId = "u1";
jest.mock("../lib/queue-identity", () => ({
  resolveQueueIdentity: () => ({ userId: mockUserId, tenantId: "t1" }),
}));
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
  RETURN_STATE_RACE_RETRY_MESSAGE,
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

  it("a coded business refusal settles; a 403 and an offline-queued error do not", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const h = captureSettleHandlers(store().settleCapture);
    h.onError({ isOfflineQueued: true }, vars(n1));
    expect(store().nonces[KEY]).toBe(n1);
    h.onError({ response: { status: 403, data: {} } }, vars(n1));
    expect(store().nonces[KEY]).toBe(n1);
    h.onError(
      { response: { status: 400, data: { code: "INLINE_RETURN_ORDER_CANCELLED", message: "x" } } },
      vars(n1),
    );
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

// ── SA-198 + Opus re-review: direct capture -> sign-out -> sign-in, REAL nonce + offline-queue stores ──
describe("a direct capture's nonce across sign-out / sign-in / relaunch", () => {
  const { useOfflineQueue } = jest.requireActual(
    "../store/offlineQueue",
  ) as typeof import("../store/offlineQueue");
  const handlers = () =>
    captureSettleHandlers(store().settleCapture, {
      add: (rec) => {
        useOfflineQueue.getState().clearFailedAction(rec.action.id);
        useOfflineQueue.getState().addFailedAction(rec);
      },
    });
  // sign-out empties memory; sign-in (and a cold start) rebuild from the user's own queue + failed list
  const signOutThenIn = () => {
    store().reset();
    const { queue, failedActions } = useOfflineQueue.getState();
    store().seedFromQueues(queue, failedActions, "u1");
  };
  const request = (nonce: string) => ({ ...vars(nonce), reason: "DAMAGED", items: [] }) as any;

  beforeEach(() => {
    mockUserId = "u1";
    useOfflineQueue.setState({ queue: [], failedActions: [], settledInlineReturnKeys: {} });
  });

  it.each([
    ["503", { response: { status: 503, data: {} } }],
    ["408", { response: { status: 408, data: {} } }],
    ["429", { response: { status: 429, data: {} } }],
    [
      "retry-409",
      { response: { status: 409, data: { message: RETURN_STATE_RACE_RETRY_MESSAGE } } },
    ],
    ["timeout, no response", { code: "ECONNABORTED", message: "timeout" }],
    ["network error, no response", { message: "Network Error" }],
  ])("a direct %s keeps the SAME nonce after sign-out + sign-in", (_n, err) => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError(err, request(n1));
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
  });

  it.each([
    ["403", { response: { status: 403, data: {} } }],
    ["401", { response: { status: 401, data: {} } }],
    ["code-less 400", { response: { status: 400, data: { message: "validation" } } }],
  ])("SA-204: a first-attempt %s KEEPS the nonce, also across sign-out + sign-in", (_n, err) => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError(err, request(n1));
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
  });

  it("SA-204: a 403 after a timeout keeps the same nonce; the retry once permission is restored resends the SAME key", () => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError({ code: "ECONNABORTED", message: "timeout" }, request(n1));
    handlers().onError({ response: { status: 403, data: {} } }, request(n1));
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
  });

  it("a coded business refusal settles: the next attempt mints fresh", () => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError(
      { response: { status: 400, data: { code: "INLINE_RETURN_ORDER_CANCELLED", message: "x" } } },
      request(n1),
    );
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
  });

  it("PIN (settled keys are never restored): fail -> re-enter -> land -> relaunch -> a NEW capture gets a FRESH key", () => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError({ response: { status: 503, data: {} } }, request(n1));
    signOutThenIn(); // re-enter: the nonce is rebuilt from the failed record
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
    handlers().onSuccess(undefined, request(n1)); // the retry lands with the SAME key
    expect(useOfflineQueue.getState().failedActions).toHaveLength(0);
    signOutThenIn(); // relaunch
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
  });

  it("a settle clears EVERY record carrying that returnKey, including queue-drain-origin ones", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const req = request(n1);
    useOfflineQueue.getState().addFailedAction({
      action: {
        id: "drain-1",
        endpoint: "/returns/inline/capture",
        method: "POST",
        body: req,
        timestamp: 1,
        retries: 3,
      },
      reason: "Retries exhausted after 3 attempts",
      failedAt: 1,
    });
    handlers().onError({ response: { status: 503, data: {} } }, req);
    expect(useOfflineQueue.getState().failedActions.length).toBe(2);
    handlers().onSuccess(undefined, req);
    expect(useOfflineQueue.getState().failedActions).toHaveLength(0);
  });

  it("a definite refusal also clears the records; the rebuild skips a key with a recorded terminal outcome even if a stale record reappears", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const req = request(n1);
    handlers().onError({ response: { status: 503, data: {} } }, req);
    const stale = useOfflineQueue.getState().failedActions[0]!;
    handlers().onError(
      { response: { status: 409, data: { code: "INLINE_RETURN_KEY_CONFLICT", message: "x" } } },
      req,
    );
    expect(useOfflineQueue.getState().failedActions).toHaveLength(0);
    useOfflineQueue.getState().addFailedAction(stale); // a stale record resurfaces
    signOutThenIn();
    expect(store().nonces[KEY]).toBeUndefined();
  });

  it("SA-206 PIN: fail -> sign-out -> land -> sign-out -> sign-in -> a FRESH key (tombstones survive sign-out)", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const req = request(n1);
    handlers().onError({ response: { status: 503, data: {} } }, req);
    store().reset(); // sign-out #1: memory emptied, the queue + tombstones survive
    handlers().onSuccess(undefined, req); // it lands (e.g. the queue drain / a retry), memory has no nonce
    signOutThenIn(); // sign-out #2 then sign-in
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
  });

  it("SA-206: seeding prunes tombstones older than 90 days (never unbounded growth)", () => {
    const DAY = 86_400_000;
    useOfflineQueue.setState({
      settledInlineReturnKeys: {
        u1: [
          { key: "stale", at: Date.now() - 100 * DAY },
          { key: "fresh", at: Date.now() - DAY },
        ],
      },
    });
    signOutThenIn();
    expect(useOfflineQueue.getState().settledInlineReturnKeys.u1!.map((t) => t.key)).toEqual([
      "fresh",
    ]);
  });

  it("the offline-queue drain settle also clears matching failed records and tombstones the key", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const req = request(n1);
    handlers().onError({ response: { status: 503, data: {} } }, req);
    store().settleAfterDrain([{ customerId: "c", orderId: "o", nonceSuffix: n1 }]);
    expect(useOfflineQueue.getState().failedActions).toHaveLength(0);
    signOutThenIn();
    expect(store().nonces[KEY]).toBeUndefined();
  });

  it("Opus (3) RACE: a queue drain that settles BEFORE rehydrate cannot bring the settled key back (getOrCreateNonce + seed both filter tombstones)", () => {
    const n1 = store().getOrCreateNonce(KEY);
    store().settleAfterDrain([{ customerId: "c", orderId: "o", nonceSuffix: n1 }]); // drain settles first
    // ...then rehydrate restores the OLD persisted blob over memory:
    useInlineReturnSubmissionStore.setState({ nonces: { [KEY]: n1 } });
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
    // and the seed path filters the stored map too
    useInlineReturnSubmissionStore.setState({ nonces: { [KEY]: n1 } });
    store().seedFromQueues([], [], "u1");
    expect(store().nonces[KEY]).toBeUndefined();
  });

  it("Opus (2): tombstones are per USER — A's tombstones never suppress B, and each user has their own cap", () => {
    const nA = store().getOrCreateNonce(KEY);
    handlers().onSuccess(undefined, request(nA)); // A settles
    expect(Object.keys(useOfflineQueue.getState().settledInlineReturnKeys)).toEqual(["u1"]);
    mockUserId = "u2"; // B signs in on the same device and (same customer/order, same nonce value by construction) meets the key
    useInlineReturnSubmissionStore.setState({ nonces: { [KEY]: nA } });
    expect(store().getOrCreateNonce(KEY)).toBe(nA); // NOT filtered: the tombstone belongs to A
    // per-user cap: 205 tombstones for A never evict B's
    mockUserId = "u2";
    useOfflineQueue.getState().settleInlineReturnKey("inl:b:only:1");
    mockUserId = "u1";
    for (let i = 0; i < 205; i++)
      useOfflineQueue.getState().settleInlineReturnKey(`inl:a:${i}:x`, "u1");
    expect(useOfflineQueue.getState().settledInlineReturnKeys.u2!.map((t) => t.key)).toEqual([
      "inl:b:only:1",
    ]);
    useOfflineQueue.getState().pruneSettledInlineReturnKeys("u1");
    expect(useOfflineQueue.getState().settledInlineReturnKeys.u1!.length).toBeLessThanOrEqual(200);
  });
});
