// A read-only POST (the inline-return QUOTE) must never enter the offline queue: replaying a
// quote later is meaningless and a queued quote would surface as a pending success (Opus #2087
// point 3). Opt out per request with `_skipOfflineQueue`.
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
const mockEnqueue = jest.fn();
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => ({ enqueue: mockEnqueue, isOnline: false }) },
}));

import { apiClient } from "../lib/api-client";

const rejected = () =>
  (apiClient.interceptors.response as unknown as { handlers: any[] }).handlers[0]!.rejected as (
    e: unknown,
  ) => Promise<unknown>;
const netErr = (extra: Record<string, unknown>) => ({
  config: { url: "/returns/inline/quote", method: "post", headers: {}, data: "{}", ...extra },
  request: {},
  message: "Network Error",
});

beforeEach(() => mockEnqueue.mockClear());

it("a normal offline POST to an allow-listed endpoint is still queued", async () => {
  await expect(
    rejected()(netErr({ url: "/returns", headers: { "Idempotency-Key": "k-0" } })),
  ).rejects.toMatchObject({
    isOfflineQueued: true,
  });
  expect(mockEnqueue).toHaveBeenCalledTimes(1);
});

it("a POST flagged _skipOfflineQueue is NOT queued and rejects with the original error", async () => {
  const err = netErr({ _skipOfflineQueue: true });
  await expect(rejected()(err)).rejects.toBe(err);
  expect(mockEnqueue).not.toHaveBeenCalled();
});
