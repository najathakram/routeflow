/**
 * #2389 (tier 1, F2 #938 5852141859): on the Expo web export, a stop completion queued OFFLINE
 * (case C) was dead-lettered by the drain itself: a NetInfo re-subscribe reported "connected"
 * while the browser was offline, the drain replayed 3× into ERR_INTERNET_DISCONNECTED, and
 * MAX_RETRIES moved the completion to failedActions ("Nothing is resent") — the stop stayed
 * PENDING. The fold: drain only when LIVE-online, re-trigger on reconnect, and a network-class
 * failure never counts toward MAX_RETRIES. A server 4xx still dead-letters; a 5xx still retries.
 */
import { onlineManager } from "@tanstack/react-query";
import {
  drainQueue,
  MAX_RETRIES,
  nextDrainDelayMs,
  queriesToRefreshAfterDrain,
} from "../lib/queue-drain";

// Effect cleanups are collected and run after each test, so one test's hook instance (its
// onlineManager subscription, its backoff timer) never leaks into the next.
const mockCleanups: Array<() => void> = [];
jest.mock("react", () => ({
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (typeof cleanup === "function") mockCleanups.push(cleanup);
  },
  useRef: <T>(v: T) => ({ current: v }),
  // #2389: the hook now imports onlineManager from @tanstack/react-query, whose module init calls
  // React.createContext — a stub keeps that import loadable under this renderer-less mock.
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
const completion = {
  id: "c1",
  endpoint: "/route-runs/run-1/stops/stop-1/complete-with-payment",
  method: "POST" as const,
  body: { deliveries: [] },
  headers: { "idempotency-key": "stop-stop-1-1" },
  timestamp: 1,
  retries: 0,
};
jest.mock("../store/offlineQueue", () => {
  const storeApi = {
    queue: [completion],
    isOnline: true,
    setOnline: jest.fn(),
    setSyncing: jest.fn(),
    dequeue,
    incrementRetry,
    addFailedAction,
    restampAction: jest.fn(),
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
  apiClient: {
    // RF-170's pre-check: the run is still active.
    get: jest.fn(async () => ({ data: { status: "IN_PROGRESS" } })),
    request: (...args: any[]) => request(...args),
  },
}));
jest.mock("../lib/toast", () => ({ showToast: jest.fn() }));
const alertInfo = jest.fn();
jest.mock("../lib/confirm", () => ({ alertInfo: (...a: any[]) => alertInfo(...a) }));
jest.mock("../store/inlineReturnSubmissionStore", () => ({
  useInlineReturnSubmissionStore: (selector: (s: any) => unknown) =>
    selector({ settleAfterDrain: jest.fn() }),
}));

import { useNetworkSync } from "../hooks/useNetworkSync";

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const offlineError = () =>
  Object.assign(new Error("Network Error"), {
    isAxiosError: true,
    code: "ERR_NETWORK",
    request: {},
  });

beforeEach(() => {
  jest.clearAllMocks();
  onlineManager.setOnline(true);
});
afterEach(() => {
  while (mockCleanups.length) mockCleanups.pop()!();
});

describe("drainQueue: network-class failures never count toward MAX_RETRIES (#2389)", () => {
  const q = (id: string, retries = 0) => ({ ...completion, id, retries });

  it("an unreached entry and everything after it stay queued, retries untouched, FIFO kept", async () => {
    const req = jest.fn().mockRejectedValueOnce(offlineError());
    const r = await drainQueue([q("a"), q("b")], { request: req, notifyFailed: jest.fn() });
    expect(r).toEqual({
      delivered: [],
      retriedIds: [],
      creditsPending: [],
      unreachedIds: ["a", "b"],
      failedActions: [],
    });
    expect(req).toHaveBeenCalledTimes(1); // stops at the first unreachable replay
  });

  it("offline for any number of drains, the entry is NEVER dead-lettered", async () => {
    const notifyFailed = jest.fn();
    for (let i = 0; i < MAX_RETRIES + 3; i++) {
      const r = await drainQueue([q("a")], {
        request: jest.fn().mockRejectedValue(offlineError()),
        notifyFailed,
      });
      expect(r.unreachedIds).toEqual(["a"]);
    }
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("a timed-out replay (no response) is network-class too", async () => {
    const timeout = Object.assign(new Error("timeout"), {
      isAxiosError: true,
      code: "ECONNABORTED",
      request: {},
    });
    const r = await drainQueue([q("a")], {
      request: jest.fn().mockRejectedValue(timeout),
      notifyFailed: jest.fn(),
    });
    expect(r.unreachedIds).toEqual(["a"]);
    expect(r.retriedIds).toEqual([]);
  });

  it("Opus nit (a): a NON-axios error with no response (api-client's 'No refresh token') is NOT unreachable — it keeps the retry → dead-letter path, so it surfaces", async () => {
    const r = await drainQueue([q("a")], {
      request: jest.fn().mockRejectedValue(new Error("No refresh token")),
      notifyFailed: jest.fn(),
    });
    expect(r.unreachedIds).toEqual([]);
    expect(r.retriedIds).toEqual(["a"]);
  });

  it("Opus nit (a): a cancelled axios request (ERR_CANCELED) is not network-class", async () => {
    const cancelled = Object.assign(new Error("canceled"), {
      isAxiosError: true,
      code: "ERR_CANCELED",
    });
    const r = await drainQueue([q("a")], {
      request: jest.fn().mockRejectedValue(cancelled),
      notifyFailed: jest.fn(),
    });
    expect(r.unreachedIds).toEqual([]);
  });

  it("a server 4xx still DEAD-LETTERS, exactly as before", async () => {
    const notifyFailed = jest.fn();
    const r = await drainQueue([q("a")], {
      request: jest.fn().mockRejectedValue({ response: { status: 400, data: { message: "bad" } } }),
      notifyFailed,
    });
    expect(r.failedActions).toHaveLength(1);
    expect(r.failedActions[0].reason).toMatch(/HTTP 400/);
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("a 5xx keeps the existing retry policy (counted toward MAX_RETRIES)", async () => {
    const r = await drainQueue([q("a")], {
      request: jest.fn().mockRejectedValue({ response: { status: 503 } }),
      notifyFailed: jest.fn(),
    });
    expect(r.retriedIds).toEqual(["a"]);
    expect(r.unreachedIds).toEqual([]);
  });

  it("#2410: only a delivered route-run write refreshes the route queries", () => {
    expect(queriesToRefreshAfterDrain([{ endpoint: "/route-runs/r1/stops/s1/complete" }])).toEqual([
      ["route-runs"],
    ]);
    expect(queriesToRefreshAfterDrain([{ endpoint: "/orders" }])).toEqual([]);
    expect(queriesToRefreshAfterDrain([])).toEqual([]);
  });

  it("backoff is bounded: 2s, 4s, 8s … capped at 60s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(nextDrainDelayMs)).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
});

describe("useNetworkSync: a throwing drain never leaves `syncing` stuck (Opus nit c)", () => {
  it("after a drain step throws, the NEXT drain still runs", async () => {
    // Throw from inside the drain via the RF-170 run pre-check's NON-caught path: make the
    // store's dequeue throw once on delivery, then succeed.
    request.mockResolvedValue({ status: 201 });
    dequeue.mockImplementationOnce(() => {
      throw new Error("store write failed");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    useNetworkSync();
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(2); // the second drain was not blocked by `syncing`
    expect(warn).toHaveBeenCalledWith("[offline-queue] drain failed", expect.any(Error));
    warn.mockRestore();
    request.mockReset();
  });
});

describe("useNetworkSync: case C — queued offline, then reconnect, replays and delivers (#2389)", () => {
  it("A (control): online, the queued completion replays and is delivered", async () => {
    request.mockResolvedValueOnce({ status: 201 });
    useNetworkSync();
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(dequeue).toHaveBeenCalledWith("c1");
    expect(addFailedAction).not.toHaveBeenCalled();
    // #2410: the delivered completion refreshes the route list right away.
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["route-runs"] });
  });

  it("#2410: an unreachable drain refreshes nothing (nothing was delivered)", async () => {
    request.mockRejectedValueOnce(offlineError());
    useNetworkSync();
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();
    expect(mockInvalidate).not.toHaveBeenCalled();
    request.mockReset();
  });

  it("C: browser offline + a NetInfo 'connected' glitch → NO replay; reconnect → replay 201 → delivered", async () => {
    onlineManager.setOnline(false); // the web export's window went offline
    useNetworkSync();
    // The web NetInfo re-subscribe fires "connected" while the browser is offline (F2's trace).
    netListener!({ isConnected: true, isInternetReachable: true });
    await flush();
    expect(request).not.toHaveBeenCalled(); // never drained offline
    expect(incrementRetry).not.toHaveBeenCalled();
    expect(addFailedAction).not.toHaveBeenCalled();

    // Reconnect: the window "online" event (TanStack onlineManager) re-triggers the drain.
    request.mockResolvedValueOnce({ status: 201 });
    onlineManager.setOnline(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(dequeue).toHaveBeenCalledWith("c1"); // the stop completion is DELIVERED
    expect(addFailedAction).not.toHaveBeenCalled();
    expect(alertInfo).not.toHaveBeenCalled();
  });

  it("C': online but the replay can't reach the API → stays queued, no retry counted, no dead-letter", async () => {
    jest.useFakeTimers();
    try {
      request.mockRejectedValue(offlineError());
      useNetworkSync();
      netListener!({ isConnected: true, isInternetReachable: true });
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(60_000); // walk the bounded backoff several times
        await Promise.resolve();
      }
    } finally {
      jest.useRealTimers();
    }
    await flush();
    // Opus nit (b): the backoff really re-attempted — not a drain that simply never ran.
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(incrementRetry).not.toHaveBeenCalled();
    expect(addFailedAction).not.toHaveBeenCalled();
    expect(dequeue).not.toHaveBeenCalled();
    request.mockReset();
  });
});
