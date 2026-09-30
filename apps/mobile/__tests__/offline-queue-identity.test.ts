/**
 * T2 (bug-test-plan.md) — REG-B137: identity-stamped offline queue.
 *
 * Design of record: cause-ruling.md §3 D2. Today the drain always replays
 * under the NEW signed-in user's token regardless of who queued the entry —
 * misattribution, not an authz bypass, but wrong all the same on a shared
 * device. The fix stamps `{ userId, tenantId }` at enqueue time, filters the
 * queue against the CURRENT identity before anything reaches `drainQueue`
 * (lib/queue-drain.ts, real and unmodified here), and never auto-adopts a
 * legacy unstamped entry more than once.
 *
 * `drainQueue` itself is the REAL, already-shipped F30 extraction — only the
 * ownership partitioning ahead of it is new. The first five tests below pin
 * that partition as pure logic (they kept the `toBeTruthy()` gate from the
 * stub phase of `lib/queue-identity.ts`); REG-B137-E and REG-B137-F drive the
 * REAL `store/offlineQueue`, so a store that stops stamping — or a settle
 * step that stops evicting another user's entry — turns this file red instead
 * of leaving the bug live under a green helper suite.
 */
import type { QueuedAction } from "../store/offlineQueue";
import type { FailedActionRecord } from "../lib/queue-drain";
import { drainQueue } from "../lib/queue-drain";
import {
  stampQueuedAction,
  filterQueueForCurrentUser,
  selectFailedActionsForUser,
  settleQueueOwnership,
  type StampedAction,
} from "../lib/queue-identity";
import { useOfflineQueue } from "../store/offlineQueue";

// The store persists through AsyncStorage, and `lib/queue-identity` reads the
// signed-in identity off the auth/tenant stores (`lib/auth-store` in turn
// pulls in react-native) — all three are stubbed so the REAL store logic runs
// in the plain node environment. `mockUser` is mutable so a test can change
// who is signed in; ts-jest hoists these factories above the imports, and they
// only read it when a store method is actually called.
let mockUser: { id: string; tenantId?: string } | null = { id: "u-1", tenantId: "t-1" };

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock("../lib/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));

jest.mock("../lib/tenant-store", () => ({
  useTenantStore: { getState: () => ({ slug: "t-1" }) },
}));

function action(overrides: Partial<QueuedAction> & Record<string, unknown>): StampedAction {
  return {
    id: "q-default",
    endpoint: "/orders",
    method: "POST",
    body: { lines: [] },
    timestamp: 1_000,
    retries: 0,
    ...overrides,
  } as StampedAction;
}

const ME = { userId: "u-1", tenantId: "t-1" };
const SOMEONE_ELSE = { userId: "u-2", tenantId: "t-1" };

describe("REG-B137-A: enqueue stamps userId+tenantId", () => {
  it("stamps the identity onto the action being queued — TODAY: stampQueuedAction is an unfilled stub", () => {
    const raw = { endpoint: "/orders", method: "POST" as const, body: { lines: [] } };

    const stamped = stampQueuedAction(raw, ME);

    expect(stamped).toBeTruthy();
    expect(stamped!.userId).toBe("u-1");
    expect(stamped!.tenantId).toBe("t-1");
  });
});

describe("REG-B137-B: drain replays only the current user's entries", () => {
  it('a different-user entry is NEVER attempted and lands in mismatched with reason "different-user" — TODAY: both are executed', async () => {
    const mine = action({ id: "mine-1", ...ME });
    const theirs = action({ id: "theirs-1", ...SOMEONE_ELSE });

    const partition = filterQueueForCurrentUser([mine, theirs], ME);
    expect(partition).toBeTruthy();

    const attempted: string[] = [];
    const request = jest.fn(async (a: QueuedAction) => {
      attempted.push(a.id);
      return { data: {} };
    });
    await drainQueue(partition!.toDrain, { request, notifyFailed: jest.fn() });

    // The core regression: today filterQueueForCurrentUser doesn't exist, so
    // the caller would hand BOTH entries straight to drainQueue and the
    // other user's action gets executed under my session.
    expect(attempted).not.toContain("theirs-1");
    expect(attempted).toContain("mine-1");

    const mismatchedRecord = partition!.mismatched.find((f) => f.action.id === "theirs-1");
    expect(mismatchedRecord?.reason).toBe("different-user");
  });
});

describe("REG-B137-C: failedActions listed per user", () => {
  it("the selector returns only the current user's failures — TODAY: unfilled stub returns everyone's", () => {
    const mine: FailedActionRecord = {
      action: action({ id: "mine-fail", ...ME }),
      reason: "HTTP 400: bad request",
      failedAt: 1,
    };
    const theirs: FailedActionRecord = {
      action: action({ id: "their-fail", ...SOMEONE_ELSE }),
      reason: "HTTP 400: bad request",
      failedAt: 2,
    };

    const result = selectFailedActionsForUser([mine, theirs], ME.userId);

    expect(result).toBeTruthy();
    expect(result!.map((f) => f.action.id)).toEqual(["mine-fail"]);
  });
});

describe("REG-B137-D: a legacy unstamped entry is adopted ONCE, then stamped", () => {
  // No userId/tenantId at all — an entry queued before this fix shipped.
  const legacy = action({ id: "legacy-1" });

  it("is drained for the first user who encounters it, and comes back marked to persist the stamp — TODAY: unfilled stub", () => {
    const partition = filterQueueForCurrentUser([legacy], ME);

    expect(partition).toBeTruthy();
    expect(partition!.toDrain.map((a) => a.id)).toContain("legacy-1");
    const restamped = partition!.restamped.find((a) => a.id === "legacy-1");
    expect(restamped).toMatchObject({ userId: ME.userId, tenantId: ME.tenantId });
  });

  it("once restamped, a DIFFERENT user no longer auto-adopts it — it is mismatched instead — TODAY: unfilled stub", () => {
    const stampedLegacy = action({ id: "legacy-1", ...ME });

    const partition = filterQueueForCurrentUser([stampedLegacy], SOMEONE_ELSE);

    expect(partition).toBeTruthy();
    expect(partition!.mismatched.map((f) => f.action.id)).toContain("legacy-1");
  });
});

describe("REG-B137-E: the REAL store stamps what it writes", () => {
  beforeEach(() => {
    mockUser = { id: "u-1", tenantId: "t-1" };
    useOfflineQueue.setState({ queue: [], failedActions: [] });
  });

  it("enqueue writes the signed-in identity onto the queued entry", () => {
    useOfflineQueue.getState().enqueue({
      endpoint: "/orders",
      method: "POST",
      body: { items: [] },
    });

    const [entry] = useOfflineQueue.getState().queue;
    expect(entry.userId).toBe("u-1");
    expect(entry.tenantId).toBe("t-1");
  });

  it("addFailedAction stamps a record whose action predates the stamp", () => {
    useOfflineQueue.getState().addFailedAction({
      action: action({ id: "legacy-fail" }),
      reason: "HTTP 400: bad request",
      failedAt: 1,
    });

    const [record] = useOfflineQueue.getState().failedActions;
    expect(record.action.userId).toBe("u-1");
    expect(record.action.tenantId).toBe("t-1");
  });
});

describe("REG-B137-F: settleQueueOwnership applies the partition to the REAL store", () => {
  it("drains mine + the legacy entry, evicts theirs into failedActions, persists the adopted stamp", () => {
    mockUser = { id: "u-1", tenantId: "t-1" };
    const mine = action({ id: "mine-1", ...ME });
    const theirs = action({ id: "theirs-1", ...SOMEONE_ELSE });
    const legacy = action({ id: "legacy-1" });
    useOfflineQueue.setState({ queue: [mine, theirs, legacy], failedActions: [] });

    const store = useOfflineQueue.getState();
    const toDrain = settleQueueOwnership(store.queue, ME, {
      addFailedAction: store.addFailedAction,
      removeAction: store.dequeue,
      restampAction: store.restampAction,
    });

    // Only my own entry and the adopted legacy one are ever handed to the drain.
    expect(toDrain.map((a) => a.id)).toEqual(["mine-1", "legacy-1"]);

    const after = useOfflineQueue.getState();
    // The other driver's entry left the queue instead of being replayed under my token …
    expect(after.queue.map((a) => a.id)).not.toContain("theirs-1");
    // … and it is recorded as THEIR failure, with the reason that says why.
    expect(after.failedActions).toHaveLength(1);
    expect(after.failedActions[0].action.id).toBe("theirs-1");
    expect(after.failedActions[0].reason).toBe("different-user");
    expect(after.failedActions[0].action.userId).toBe(SOMEONE_ELSE.userId);
    // The legacy entry keeps its adoption, so the NEXT user cannot adopt it again.
    expect(after.queue.find((a) => a.id === "legacy-1")).toMatchObject({
      userId: "u-1",
      tenantId: "t-1",
    });
  });
});
