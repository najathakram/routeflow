// Sign-in rebuilds the inline-return nonces from the signed-in user's OWN offline queue and
// failed-actions list (Opus review of #1270) — sign-out empties memory, so this is how a queued
// or failed capture's key survives without leaking across users.
const mockOrder: string[] = [];
const seed = jest.fn(() => void mockOrder.push("seed"));
jest.mock("../store/inlineReturnSubmissionStore", () => ({
  useInlineReturnSubmissionStore: {
    persist: { rehydrate: async () => void mockOrder.push("inline") },
    getState: () => ({ seedFromQueues: seed }),
  },
}));
jest.mock("../store/podStore", () => ({
  usePodStore: { persist: { rehydrate: async () => void mockOrder.push("pod") } },
}));
jest.mock("../store/runSettlementStore", () => ({
  useRunSettlementStore: {
    persist: { rehydrate: async () => void mockOrder.push("runSettlement") },
  },
}));
jest.mock("../store/stopCartStore", () => ({
  useStopCartStore: { persist: { rehydrate: async () => void mockOrder.push("stopCart") } },
}));
jest.mock("../store/returnSubmissionStore", () => ({
  useReturnSubmissionStore: {
    persist: { rehydrate: async () => void mockOrder.push("returnSubmission") },
  },
}));
const queueState = { queue: [] as unknown[], failedActions: [] as unknown[] };
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => queueState },
}));
jest.mock("../lib/auth", () => ({ getStoredUser: async () => ({ id: "u1" }) }));

import { rehydrateUserScopedStores } from "../lib/session-hydrate";

beforeEach(() => {
  mockOrder.length = 0;
  seed.mockClear();
});

it("seeds the store from the signed-in user's own queue + failed actions AFTER its rehydrate", async () => {
  queueState.queue = [{ id: "q" }];
  queueState.failedActions = [{ action: { id: "f" }, reason: "HTTP 500: x" }];
  await rehydrateUserScopedStores();
  expect(mockOrder.indexOf("seed")).toBeGreaterThan(mockOrder.indexOf("inline"));
  expect(seed).toHaveBeenCalledWith(queueState.queue, queueState.failedActions, "u1");
});

it("hydrates the inline store FIRST, before the four other user-scoped stores (a queue drain on a 2nd in-process login must not write {} over the incoming user's blob while they hydrate)", async () => {
  await rehydrateUserScopedStores();
  expect(mockOrder[0]).toBe("inline");
  expect(mockOrder.filter((n) => n !== "seed")).toHaveLength(5);
});
