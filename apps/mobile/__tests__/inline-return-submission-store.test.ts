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
jest.mock("../lib/queue-identity", () => ({
  resolveQueueIdentity: () => ({ userId: "u1", tenantId: "t1" }),
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

// ── SA-198: direct capture -> sign-out -> sign-in, against the REAL nonce + offline-queue stores ──
describe("a direct capture's nonce across sign-out / sign-in (SA-198)", () => {
  const { useOfflineQueue } = jest.requireActual(
    "../store/offlineQueue",
  ) as typeof import("../store/offlineQueue");
  const handlers = () =>
    captureSettleHandlers(store().settleCapture, {
      add: (rec) => {
        useOfflineQueue.getState().clearFailedAction(rec.action.id);
        useOfflineQueue.getState().addFailedAction(rec);
      },
      clear: (id) => useOfflineQueue.getState().clearFailedAction(id),
    });
  const signOutThenIn = () => {
    store().reset(); // teardown: memory always emptied
    const { queue, failedActions } = useOfflineQueue.getState(); // the queue survives sign-out
    store().seedFromQueues(queue, failedActions, "u1");
  };
  const request = (nonce: string) => ({ ...vars(nonce), reason: "DAMAGED", items: [] }) as any;

  beforeEach(() => {
    useOfflineQueue.setState({ queue: [], failedActions: [] });
  });

  it("a direct 5xx keeps the SAME nonce after sign-out + sign-in", () => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError({ response: { status: 503, data: {} } }, request(n1));
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
  });

  it("a timeout with no response keeps it too", () => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError({ code: "ECONNABORTED", message: "timeout" }, request(n1));
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).toBe(n1);
  });

  it("a direct 403 does NOT survive: the next attempt mints fresh", () => {
    const n1 = store().getOrCreateNonce(KEY);
    handlers().onError({ response: { status: 403, data: {} } }, request(n1));
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
  });

  it("a later success settles the attempt and removes its failed-action record", () => {
    const n1 = store().getOrCreateNonce(KEY);
    const h = handlers();
    h.onError({ response: { status: 503, data: {} } }, request(n1));
    expect(useOfflineQueue.getState().failedActions).toHaveLength(1);
    h.onSuccess(undefined, request(n1));
    expect(useOfflineQueue.getState().failedActions).toHaveLength(0);
    signOutThenIn();
    expect(store().getOrCreateNonce(KEY)).not.toBe(n1);
  });
});
