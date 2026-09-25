// Sign-in rebuilds the inline-return nonces from the signed-in user's OWN offline queue and
// failed-actions list (Opus review of #1270) — sign-out empties memory, so this is how a queued
// or failed capture's key survives without leaking across users.
const seed = jest.fn();
const rehydrateInline = jest.fn(async () => undefined);
jest.mock("../store/inlineReturnSubmissionStore", () => ({
  useInlineReturnSubmissionStore: {
    persist: { rehydrate: () => rehydrateInline() },
    getState: () => ({ seedFromQueues: seed }),
  },
}));
for (const m of [
  "podStore:usePodStore",
  "runSettlementStore:useRunSettlementStore",
  "stopCartStore:useStopCartStore",
  "returnSubmissionStore:useReturnSubmissionStore",
]) {
  const [file, name] = m.split(":");
  jest.mock(
    `../store/${file}`,
    () => ({ [name!]: { persist: { rehydrate: async () => undefined } } }),
    { virtual: false },
  );
}
const queueState = { queue: [] as unknown[], failedActions: [] as unknown[] };
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => queueState },
}));
jest.mock("../lib/auth", () => ({ getStoredUser: async () => ({ id: "u1" }) }));

import { rehydrateUserScopedStores } from "../lib/session-hydrate";

it("seeds the store from the signed-in user's own queue + failed actions AFTER its rehydrate", async () => {
  queueState.queue = [{ id: "q" }];
  queueState.failedActions = [{ action: { id: "f" }, reason: "HTTP 500: x" }];
  const order: string[] = [];
  rehydrateInline.mockImplementationOnce(async () => void order.push("rehydrate"));
  seed.mockImplementationOnce(() => void order.push("seed"));
  await rehydrateUserScopedStores();
  expect(order).toEqual(["rehydrate", "seed"]);
  expect(seed).toHaveBeenCalledWith(queueState.queue, queueState.failedActions, "u1");
});
