/**
 * SA-091b (offline-path half): a capture delivered — or definitively refused — FROM THE OFFLINE
 * QUEUE never ran through useCaptureInlineReturn's onSuccess/onError, so nothing ever settled its
 * nonce; the drain only dequeued it (hooks/useNetworkSync.ts). That is the SA-091 bug again, on
 * the offline path. This spec drives the REAL hook + the REAL drainQueue (same recipe as
 * network-sync-wiring.test.ts, kept as its own file/module registry rather than added to that
 * one, so each file's queued fixture and mock lifecycle stay independent) and pins that a
 * `/returns/inline/capture` entry's outcome reaches the inline-return store's settleAfterDrain
 * with the right (customerId, orderId, nonceSuffix) record — and that a mid-flight 5xx does NOT.
 */

jest.mock("react", () => ({
  useEffect: (fn: () => void | (() => void)) => {
    fn();
  },
  useRef: <T>(v: T) => ({ current: v }),
  // #2389: the hook imports onlineManager from @tanstack/react-query (module init calls createContext).
  createContext: () => ({ Provider: () => null }),
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
const restampAction = jest.fn();
const captureAction = {
  id: "cap-1",
  endpoint: "/returns/inline/capture",
  method: "POST" as const,
  body: {
    customerId: "cust-1",
    orderId: "order-1",
    returnKey: "inl:cust-1:order-1:p1x3:nonce-QUEUED",
  },
  timestamp: 1,
  retries: 0,
};
jest.mock("../store/offlineQueue", () => {
  const storeApi = {
    queue: [captureAction],
    isOnline: false,
    setOnline: jest.fn(),
    setSyncing: jest.fn(),
    dequeue,
    incrementRetry,
    addFailedAction,
    restampAction,
    failedActions: [],
    clearFailedAction: jest.fn(),
    clearFailedActions: jest.fn(),
  };
  return {
    useOfflineQueue: jest.fn((selector?: (s: any) => unknown) =>
      selector ? selector({ failedActions: [] }) : storeApi,
    ),
    selectFailedActionCount: (s: any) => s.failedActions.length,
  };
});

jest.mock("../lib/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u-1" } }) },
}));
jest.mock("../lib/tenant-store", () => ({
  useTenantStore: { getState: () => ({ slug: "t-1" }) },
}));

const request = jest.fn();
// #2410: the hook refreshes route queries through the shared client (lib/query-client imports
// react-native, which this lane cannot load) — stubbed at the module boundary.
const mockInvalidate = jest.fn();
jest.mock("../lib/query-client", () => ({
  queryClient: { invalidateQueries: (...a: any[]) => mockInvalidate(...a) },
}));
jest.mock("../lib/api-client", () => ({
  apiClient: { get: jest.fn(), request: (...args: any[]) => request(...args) },
}));

jest.mock("../lib/toast", () => ({ showToast: jest.fn() }));
jest.mock("../lib/confirm", () => ({ alertInfo: jest.fn() }));

const settleAfterDrain = jest.fn();
jest.mock("../store/inlineReturnSubmissionStore", () => ({
  useInlineReturnSubmissionStore: (selector: (s: any) => unknown) => selector({ settleAfterDrain }),
}));

import { useNetworkSync } from "../hooks/useNetworkSync";

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("useNetworkSync → inline-return nonce settle wiring (SA-091b, offline-queue path)", () => {
  beforeEach(() => {
    // Call counts only — mocked implementations (useOfflineQueue's selector logic, NetInfo's
    // subscription capture) must survive between the two tests below.
    jest.clearAllMocks();
  });

  it("a capture that lands from the queue settles its nonce via settleAfterDrain", async () => {
    request.mockResolvedValueOnce({ data: { id: "ret-1" } });

    useNetworkSync();
    expect(netListener).not.toBeNull();
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();

    expect(dequeue).toHaveBeenCalledWith("cap-1");
    expect(settleAfterDrain).toHaveBeenCalledTimes(1);
    expect(settleAfterDrain).toHaveBeenCalledWith([
      { customerId: "cust-1", orderId: "order-1", nonceSuffix: "nonce-QUEUED" },
    ]);
  });

  it("a capture that fails with a 5xx from the queue does NOT settle — outcome unknown, same as the direct onError path", async () => {
    request.mockRejectedValueOnce({
      response: { status: 503, data: { message: "Service unavailable" } },
      message: "Request failed with status code 503",
    });

    useNetworkSync();
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();

    // A 5xx is a retriable failure in drainQueue's own classification (not a terminal
    // 4xx-refusal), so it stays queued rather than landing in addFailedAction — confirming this
    // spec actually drove the uncertain-outcome path, not merely an empty queue.
    expect(incrementRetry).toHaveBeenCalledWith("cap-1");
    expect(settleAfterDrain).toHaveBeenCalledTimes(1);
    expect(settleAfterDrain).toHaveBeenCalledWith([]);
  });
});
