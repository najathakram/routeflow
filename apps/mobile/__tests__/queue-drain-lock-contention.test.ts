/**
 * F-B1 (PR-2 / imp-02, order-merge advisory lock).
 *
 * The API now serialises order merges per customer with a Postgres advisory
 * lock (apps/api/src/common/db-locks.ts). Lock contention surfaces to
 * clients as a 409 `{ code: "MERGE_IN_PROGRESS" }` or a 503
 * `{ code: "LOCK_UNAVAILABLE" }`, raised ONLY before any write — so a retry
 * is always safe. Before this fix, `drainQueue` (lib/queue-drain.ts)
 * classified every 4xx as permanently non-retriable, which would strand a
 * queued mobile action in `failedActions` (never resent — see
 * `describeFailedDrain`'s "nothing is resent automatically" footer) on a
 * contention response that the very next drain would have succeeded on.
 *
 * This pins the fix: a 409/MERGE_IN_PROGRESS and a 503/LOCK_UNAVAILABLE take
 * the same path as a 5xx/network failure (left queued, retried), while a
 * 409 with any other code and a plain 400 keep the old non-retriable
 * behavior.
 */
import type { QueuedAction } from "../store/offlineQueue";
import { drainQueue, type FailedActionRecord } from "../lib/queue-drain";

function action(overrides: Partial<QueuedAction>): QueuedAction {
  return {
    id: "q-default",
    endpoint: "/orders",
    method: "POST",
    body: { lines: [] },
    timestamp: 1_000,
    retries: 0,
    ...overrides,
  };
}

function httpError(
  status: number,
  data?: unknown,
): Error & { response: { status: number; data?: unknown } } {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    response: { status: number; data?: unknown };
  };
  err.response = { status, data };
  return err;
}

describe("drainQueue — order-merge lock contention is retriable (F-B1)", () => {
  it("409 MERGE_IN_PROGRESS is retried, not moved to failedActions", async () => {
    const entry = action({ id: "q-merge-conflict" });
    const request = jest.fn(async () => {
      throw httpError(409, {
        code: "MERGE_IN_PROGRESS",
        message: "Another merge for this customer is in progress — retry.",
      });
    });

    const result = await drainQueue([entry], { request, notifyFailed: jest.fn() });

    expect(result.retriedIds).toEqual(["q-merge-conflict"]);
    expect(result.failedActions).toEqual([]);
    expect(result.delivered).toEqual([]);
  });

  it("503 LOCK_UNAVAILABLE is retried, not moved to failedActions", async () => {
    const entry = action({ id: "q-lock-unavailable" });
    const request = jest.fn(async () => {
      throw httpError(503, {
        code: "LOCK_UNAVAILABLE",
        message: "Could not acquire the merge lock.",
      });
    });

    const result = await drainQueue([entry], { request, notifyFailed: jest.fn() });

    expect(result.retriedIds).toEqual(["q-lock-unavailable"]);
    expect(result.failedActions).toEqual([]);
    expect(result.delivered).toEqual([]);
  });

  it("409 with a different code stays non-retriable (pins prior behavior)", async () => {
    const entry = action({ id: "q-merge-choice" });
    const notifyFailed = jest.fn();
    const request = jest.fn(async () => {
      throw httpError(409, { code: "MERGE_CHOICE_REQUIRED", message: "Choose a merge target." });
    });

    const result = await drainQueue([entry], { request, notifyFailed });

    expect(result.retriedIds).toEqual([]);
    expect(result.delivered).toEqual([]);
    const failedIds = result.failedActions.map((f: FailedActionRecord) => f.action.id);
    expect(failedIds).toEqual(["q-merge-choice"]);
    expect(result.failedActions[0].reason).toEqual(expect.stringContaining("409"));
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("plain 400 stays non-retriable", async () => {
    const entry = action({ id: "q-bad-request" });
    const notifyFailed = jest.fn();
    const request = jest.fn(async () => {
      throw httpError(400, { message: "Validation failed" });
    });

    const result = await drainQueue([entry], { request, notifyFailed });

    expect(result.retriedIds).toEqual([]);
    expect(result.delivered).toEqual([]);
    const failedIds = result.failedActions.map((f: FailedActionRecord) => f.action.id);
    expect(failedIds).toEqual(["q-bad-request"]);
    expect(result.failedActions[0].reason).toEqual(expect.stringContaining("400"));
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });
});
