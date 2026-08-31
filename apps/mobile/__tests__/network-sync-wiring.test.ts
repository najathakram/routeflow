/**
 * REG-B143 / REG-B111 — hook-level wiring: useNetworkSync must hand
 * `notifyFailed` (the store's addFailedAction) to drainQueue.
 *
 * The lib tests (offline-queue-failed.test.ts) prove drainQueue's own
 * classification, but nothing above them proved the HOOK actually wires the
 * store into it — an F30 mutation probe deleted `notifyFailed:
 * addFailedAction` from the drainQueue call and every existing test stayed
 * green (ts-jest runs with diagnostics off, so the required-field type error
 * does not fail tests either). This spec drives the real hook + the real
 * drainQueue with mocked natives and pins the wiring end to end: a 4xx replay
 * must land in addFailedAction (persisted badge) before it leaves the queue.
 */

// React outside a renderer: run effects immediately, refs are plain boxes.
jest.mock("react", () => ({
  useEffect: (fn: () => void | (() => void)) => {
    fn();
  },
  useRef: <T>(v: T) => ({ current: v }),
}));

let netListener: ((state: any) => void) | null = null;
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn((cb: (state: any) => void) => {
      netListener = cb;
      return () => {};
    }),
  },
}));

const dequeue = jest.fn();
const incrementRetry = jest.fn();
const addFailedAction = jest.fn();
const queuedAction = {
  id: "a1",
  endpoint: "/orders",
  method: "POST" as const,
  body: { customerId: "cust-1" },
  timestamp: 1,
  retries: 0,
};
jest.mock("../store/offlineQueue", () => {
  const storeApi = {
    queue: [queuedAction],
    isOnline: false,
    setOnline: jest.fn(),
    setSyncing: jest.fn(),
    dequeue,
    incrementRetry,
    addFailedAction,
    failedActions: [],
    clearFailedAction: jest.fn(),
    clearFailedActions: jest.fn(),
  };
  return {
    // Bare call → the store slice; selector call → a scalar (failedCount).
    useOfflineQueue: jest.fn((selector?: (s: any) => unknown) =>
      selector ? selector({ failedActions: [] }) : storeApi,
    ),
    selectFailedActionCount: (s: any) => s.failedActions.length,
  };
});

const request = jest.fn();
jest.mock("../lib/api-client", () => ({
  apiClient: { get: jest.fn(), request: (...args: any[]) => request(...args) },
}));

const showToast = jest.fn();
jest.mock("../lib/toast", () => ({ showToast: (...a: any[]) => showToast(...a) }));

const alertInfo = jest.fn();
jest.mock("../lib/confirm", () => ({ alertInfo: (...a: any[]) => alertInfo(...a) }));

// lib/queue-drain is deliberately REAL — the pin is that the hook feeds it.

import { useNetworkSync } from "../hooks/useNetworkSync";

const flush = async () => {
  // runDrain is fired-and-forgotten from the NetInfo listener; drain twice
  // through the microtask queue so its awaits settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("useNetworkSync → drainQueue wiring (REG-B143 / REG-B111)", () => {
  it("a 4xx replay is persisted via addFailedAction before it leaves the queue — never a bare dequeue", async () => {
    request.mockRejectedValueOnce({
      response: { status: 400 },
      message: "Request failed with status code 400",
    });

    useNetworkSync();
    expect(netListener).not.toBeNull();

    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();

    // The wiring under test: the hook handed the store's addFailedAction to
    // drainQueue as notifyFailed, so the classified failure was PERSISTED.
    expect(addFailedAction).toHaveBeenCalledTimes(1);
    expect(addFailedAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ id: "a1" }),
        reason: expect.stringMatching(/HTTP 400/),
      }),
    );
    // Only after persistence does the entry leave the retry queue …
    expect(dequeue).toHaveBeenCalledWith("a1");
    expect(incrementRetry).not.toHaveBeenCalled();
    // … and the operator is told once, for the whole drain.
    expect(alertInfo).toHaveBeenCalledTimes(1);
  });
});
