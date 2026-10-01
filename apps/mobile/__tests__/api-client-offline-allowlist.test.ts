// B923: the response interceptor queues a no-response mutation ONLY for an allow-listed endpoint. Any other
// mutation is online-only: nothing is enqueued and the caller gets a plain "You're offline" error that is
// distinct from `isOfflineQueued` (screens treat isOfflineQueued as a pending SUCCESS).
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
const mockEnqueue = jest.fn();
let mockOnline = true;
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: {
    getState: () => ({ enqueue: mockEnqueue, isOnline: mockOnline }),
  },
}));

import { apiClient } from "../lib/api-client";

const rejected = () =>
  (apiClient.interceptors.response as unknown as { handlers: any[] }).handlers[0]!.rejected as (
    e: unknown,
  ) => Promise<unknown>;

const netErr = (
  url: string,
  method = "post",
  extra: Record<string, unknown> = {},
  code?: string,
) => ({
  config: { url, method, headers: {}, data: "{}", ...extra },
  request: {},
  message: "Network Error",
  ...(code ? { code } : {}),
});

beforeEach(() => {
  mockEnqueue.mockClear();
  mockOnline = true;
});

describe("allow-listed endpoints are still queued", () => {
  const ALLOWED: Array<[string, string]> = [
    ["post", "/orders"],
    ["post", "/returns"],
    ["post", "/returns/inline/capture"],
    ["patch", "/route-runs/run-1/stops/stop-1"],
    ["post", "/route-runs/run-1/stops/stop-1/complete-with-payment"],
    ["post", "/route-runs/run-1/stops/stop-1/pod-artifact"],
    ["post", "/orders/ord-1/change-requests/cr-1/resolve"],
  ];

  it.each(ALLOWED)("%s %s is enqueued once and rejects isOfflineQueued", async (method, url) => {
    // keyed entries are queued only with their key (B1), so every allow-listed call carries one here
    await expect(
      rejected()(netErr(url, method, { headers: { "idempotency-key": "k-0" } })),
    ).rejects.toMatchObject({ isOfflineQueued: true });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][0]).toMatchObject({ endpoint: url });
  });

  it("keeps the Idempotency-Key header across the replay", async () => {
    await expect(
      rejected()(
        netErr("/returns", "post", { headers: { "idempotency-key": "ret-key-1", other: "x" } }),
      ),
    ).rejects.toMatchObject({ isOfflineQueued: true });
    expect(mockEnqueue.mock.calls[0][0].headers).toEqual({ "idempotency-key": "ret-key-1" });
  });
});

describe("every other mutation is online-only", () => {
  const BLOCKED: Array<[string, string]> = [
    ["patch", "/orders/ord-1/status"],
    ["patch", "/orders/ord-1/items"],
    ["post", "/orders/sell"],
    ["post", "/orders/ord-1/change-requests"],
    ["post", "/drafts"],
    ["patch", "/drafts/d-1"],
    ["post", "/drivers/me/location"],
    ["post", "/auth/login"],
    ["post", "/auth/refresh"],
    ["post", "/notifications/register-token"],
    ["patch", "/users/me/preferences"],
    ["post", "/auth/change-password"],
    ["post", "/customers"],
    ["delete", "/customers/c-1"],
    ["put", "/inventory/stock-counts/sc-1/lines"],
    ["post", "/invoices/inv-1/payments"],
  ];

  it.each(BLOCKED)(
    "%s %s: not enqueued, rejects a plain 'You're offline' error",
    async (method, url) => {
      let err: any;
      try {
        await rejected()(netErr(url, method));
      } catch (e) {
        err = e;
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("You're offline. Connect and try again.");
      expect(err.isOnlineRequired).toBe(true);
      expect(err.isOfflineQueued).toBeUndefined();
    },
  );
});

describe("the existing guards are unchanged", () => {
  it("a timeout while the app believes it is ONLINE is never queued or reported as offline (allowed or not)", async () => {
    mockOnline = true;
    for (const [method, url] of [
      ["post", "/returns"],
      ["post", "/customers"],
    ] as const) {
      const err = netErr(url, method, {}, "ECONNABORTED");
      await expect(rejected()(err)).rejects.toBe(err);
    }
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("a timeout while the app KNOWS it is offline follows the allow-list", async () => {
    mockOnline = false;
    await expect(
      rejected()(
        netErr("/returns", "post", { headers: { "idempotency-key": "k-0" } }, "ECONNABORTED"),
      ),
    ).rejects.toMatchObject({
      isOfflineQueued: true,
    });
    await expect(
      rejected()(netErr("/customers", "post", {}, "ECONNABORTED")),
    ).rejects.toMatchObject({
      isOnlineRequired: true,
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("FormData is never queued, even on an allow-listed path", async () => {
    const err = netErr("/orders", "post", { data: new FormData() });
    await expect(rejected()(err)).rejects.toBe(err);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("_skipOfflineQueue and an already-queued replay pass the original error through", async () => {
    const skip = netErr("/returns", "post", { _skipOfflineQueue: true });
    await expect(rejected()(skip)).rejects.toBe(skip);
    const replay = netErr("/returns", "post", { _offlineQueued: true });
    await expect(rejected()(replay)).rejects.toBe(replay);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("a GET network error is untouched", async () => {
    const err = netErr("/orders", "get");
    await expect(rejected()(err)).rejects.toBe(err);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("B1 (runtime): an entry that relies on an Idempotency-Key is queued ONLY when the request carries it", () => {
  const KEYED: Array<[string, string]> = [
    ["post", "/orders"],
    ["post", "/returns"],
    ["post", "/route-runs/run-1/stops/stop-1/complete-with-payment"],
  ];

  it.each(KEYED)(
    "%s %s without the header is online-only, with it is queued",
    async (method, url) => {
      let err: any;
      try {
        await rejected()(netErr(url, method));
      } catch (e) {
        err = e;
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(err?.isOnlineRequired).toBe(true);
      expect(err?.isOfflineQueued).toBeUndefined();

      await expect(
        rejected()(netErr(url, method, { headers: { "Idempotency-Key": "k-1" } })),
      ).rejects.toMatchObject({ isOfflineQueued: true });
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue.mock.calls[0][0].headers).toEqual({ "Idempotency-Key": "k-1" });
    },
  );

  it("an idempotent-by-contract entry needs no header", async () => {
    await expect(
      rejected()(netErr("/route-runs/run-1/stops/stop-1", "patch")),
    ).rejects.toMatchObject({ isOfflineQueued: true });
  });
});
