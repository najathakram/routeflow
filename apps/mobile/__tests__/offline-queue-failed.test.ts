/**
 * Never-silent offline queue drain (F30 · REG-B143 / REG-B111).
 *
 * useNetworkSync's drain loop today discards two kinds of entry with zero
 * signal: a non-retriable 4xx response (e.g. 409 MERGE_CHOICE_REQUIRED,
 * guaranteed whenever the customer has an open order) and any entry that has
 * already exhausted MAX_RETRIES — both are just `dequeue`d. A whole scanned
 * order can evaporate from the operator's cart with no alert, no log, no
 * trace anywhere (fix-cards/F30-mobile-scan-loss.md, B143/B111 chain).
 *
 * The fix (build-plan.md P4) never dequeues either case silently: both land
 * in a persisted `failedActions` list with a reason, and an alert fires.
 * `drainQueue` (lib/queue-drain.ts) is the pure extraction target this test
 * pins — currently a signature-only stub, so every assertion below fails on
 * the stub's `undefined` return, not on a crash.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { QueuedAction } from "../store/offlineQueue";
import {
  drainQueue,
  MAX_RETRIES,
  type DrainDeps,
  type FailedActionRecord,
} from "../lib/queue-drain";

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

describe("drainQueue — never-silent failures (T-B143, REG-B143 REG-B111)", () => {
  it("a 409 and a retry-exhausted entry both land in failedActions with reasons; nothing is silently dequeued", async () => {
    const okAction = action({ id: "q-ok" });
    const conflictAction = action({ id: "q-409" });
    const exhaustedAction = action({ id: "q-exhausted", retries: MAX_RETRIES });

    const attempted: string[] = [];
    const notifyFailed = jest.fn();

    const request = jest.fn(async (a: QueuedAction) => {
      attempted.push(a.id);
      if (a.id === "q-409") {
        const err = new Error("Conflict") as Error & { response?: { status: number } };
        err.response = { status: 409 };
        throw err;
      }
      if (a.id === "q-exhausted") {
        throw new Error("must never be attempted — already retry-exhausted");
      }
      return { data: { id: "server-order-1" } };
    });

    const result = await drainQueue([okAction, conflictAction, exhaustedAction], {
      request,
      notifyFailed,
    });

    // The stub returns undefined today — this is the gating assertion that
    // fails cleanly (no property access on undefined) until the real
    // extraction lands.
    expect(result).toBeTruthy();

    // An already retry-exhausted entry must never even be re-attempted.
    expect(attempted).toEqual(["q-ok", "q-409"]);

    expect(result.delivered).toEqual(["q-ok"]);
    expect(result.retriedIds).toEqual([]);

    const failedIds = result.failedActions.map((f: FailedActionRecord) => f.action.id).sort();
    expect(failedIds).toEqual(["q-409", "q-exhausted"]);

    const conflictRecord = result.failedActions.find((f) => f.action.id === "q-409");
    expect(conflictRecord?.reason).toEqual(expect.stringContaining("409"));

    const exhaustedRecord = result.failedActions.find((f) => f.action.id === "q-exhausted");
    expect(exhaustedRecord?.reason.toLowerCase()).toEqual(expect.stringContaining("retr"));

    // Every id passed in must be accounted for exactly once — proves nothing
    // silently vanished outside delivered/retriedIds/failedActions.
    const allAccounted = [...result.delivered, ...result.retriedIds, ...failedIds].sort();
    expect(allAccounted).toEqual(["q-409", "q-exhausted", "q-ok"]);

    // Alert fired for each failed entry (never a bare dequeue).
    expect(notifyFailed).toHaveBeenCalledTimes(2);
    expect(notifyFailed).toHaveBeenCalledWith(expect.objectContaining({ action: conflictAction }));
    expect(notifyFailed).toHaveBeenCalledWith(expect.objectContaining({ action: exhaustedAction }));

    // …and the record persisted is the VERY record returned. A copy would let
    // the badge and the drain result drift (different reason, different
    // failedAt), which is how "recorded" quietly stops meaning "what was lost".
    const persisted = notifyFailed.mock.calls.map(
      (call: unknown[]) => call[0] as FailedActionRecord,
    );
    expect(persisted).toHaveLength(result.failedActions.length);
    persisted.forEach((record, i) => {
      expect(record).toBe(result.failedActions[i]);
    });
  });

  it("refuses to classify a failure it cannot record — an absent notifyFailed throws instead of no-op'ing", async () => {
    const conflict = action({ id: "q-409" });
    const request = jest.fn(async () => {
      const err = new Error("Conflict") as Error & { response?: { status: number } };
      err.response = { status: 409 };
      throw err;
    });

    // `notifyFailed` is required by DrainDeps, so this only happens by mistake
    // — but "by mistake" is exactly the REG-B143 shape: the caller dequeues
    // everything in `failedActions`, so a persistence hook that silently
    // no-ops loses the order all over again. It must be loud.
    await expect(drainQueue([conflict], { request } as unknown as DrainDeps)).rejects.toThrow();
  });

  it("a 5xx / network failure below MAX_RETRIES is retried, not moved to failedActions", async () => {
    const flaky = action({ id: "q-flaky", retries: 1 });
    const request = jest.fn(async () => {
      const err = new Error("Bad Gateway") as Error & { response?: { status: number } };
      err.response = { status: 502 };
      throw err;
    });

    const result = await drainQueue([flaky], { request, notifyFailed: jest.fn() });

    expect(result).toBeTruthy();
    expect(result.retriedIds).toEqual(["q-flaky"]);
    expect(result.failedActions).toEqual([]);
    expect(result.delivered).toEqual([]);
  });
});

/**
 * WIRING — `drainQueue` is an extraction target. Implementing it alone turns
 * the two contracts above green while `useNetworkSync.ts` keeps the loop that
 * actually loses orders: a 4xx (the 409 MERGE_CHOICE_REQUIRED an operator hits
 * whenever the customer already has an open order) and a retry-exhausted entry
 * are each just `dequeue`d — no alert, no persistence, no log. A whole scanned
 * cart evaporates.
 *
 * Mobile tests are pure-logic only (no React tree), so the delegation is pinned
 * at the source level, as barcode-normalize.test.ts already does for its two
 * copies. Note the hook must KEEP dequeuing on success and on the cancelled-run
 * branch — only the two silent-loss branches are forbidden, so the assertions
 * below name those branches rather than banning `dequeue` outright.
 */
describe("useNetworkSync delegates its drain (REG-B143 / REG-B111 wiring)", () => {
  const hookSrc = readFileSync(join(__dirname, "..", "hooks", "useNetworkSync.ts"), "utf8");

  it("REG-B143: the hook imports the shared drain instead of hand-rolling classification", () => {
    expect(hookSrc).toMatch(/from\s+["']\.\.\/lib\/queue-drain["']/);
  });

  it("REG-B143: the drain is handed the persistence hook, and its verdict is alerted", () => {
    // The assertions around this one only forbid the OLD hand-rolled shapes
    // (`status >= 400 … dequeue`, `retries >= MAX_RETRIES … dequeue`, a private
    // MAX_RETRIES). Deleting `notifyFailed: addFailedAction` from the deps
    // object below reintroduces NONE of them, yet it restores REG-B143
    // verbatim: drainQueue still classifies the entry, the hook still dequeues
    // it, and the operator's order leaves the queue with no badge. So the
    // wiring is pinned positively — by what must be there, not by what must
    // not.
    expect(hookSrc).toMatch(/drainQueue\s*\([\s\S]{0,400}?notifyFailed\s*:\s*addFailedAction\b/);
    expect(hookSrc).toMatch(/result\.failedActions[\s\S]{0,80}?dequeue\s*\(/);
    expect(hookSrc).toMatch(/describeFailedDrain\s*\([\s\S]{0,160}?alertInfo\s*\(/);
  });

  it("REG-B143: a 4xx no longer ends in a bare dequeue", () => {
    // useNetworkSync.ts:55-56 today:
    //   if (status !== undefined && status >= 400 && status < 500) { dequeue(action.id); }
    expect(hookSrc).not.toMatch(/status\s*>=\s*400[\s\S]{0,160}?dequeue\s*\(/);
  });

  it("REG-B111: a retry-exhausted entry no longer ends in a bare dequeue", () => {
    // useNetworkSync.ts:22-24 today: `if (action.retries >= MAX_RETRIES) { dequeue(...) }`.
    expect(hookSrc).not.toMatch(/retries\s*>=\s*MAX_RETRIES[\s\S]{0,120}?dequeue\s*\(/);
  });

  it("R6 badge: the hook exposes the persisted failure count to its consumers", () => {
    // Without this the failures are recorded and still invisible — the alert
    // is one-shot, so the standing count is the whole point of the list.
    expect(hookSrc).toMatch(/selectFailedActionCount/);
    expect(hookSrc).toMatch(/failedCount/);
  });

  it("REG-B143: MAX_RETRIES has ONE home — the hook must not keep a private copy", () => {
    // The hook declares `const MAX_RETRIES = 3;` (useNetworkSync.ts:7) while
    // this spec's premise ("already exhausted") reads the value from
    // lib/queue-drain. Two constants silently drift and the premise stops
    // meaning anything.
    expect(hookSrc).not.toMatch(/const\s+MAX_RETRIES\s*=/);
    expect(MAX_RETRIES).toBeGreaterThan(0);
  });
});

/**
 * BADGE — R6's second surface. A persisted `failedActions` list with no reader
 * is the same invisible failure B143/B111 describe, just stored. The banner
 * both role layouts already render is the badge's home, so it must (a) read
 * the count, (b) stay visible while ONLINE — the drain that produces failures
 * only runs online, so an `isOnline`-gated banner could never show one — and
 * (c) offer a way to clear, or the list only ever grows.
 */
describe("OfflineBanner surfaces failedActions (R6 badge)", () => {
  const bannerSrc = readFileSync(join(__dirname, "..", "components", "OfflineBanner.tsx"), "utf8");

  it("renders the persisted failure count", () => {
    expect(bannerSrc).toMatch(/failedCount/);
  });

  it("is not hidden by being back online", () => {
    // The old per-layout banner opened with `if (isOnline) return null;`.
    expect(bannerSrc).not.toMatch(/if\s*\(\s*isOnline\s*\)\s*return\s+null/);
    expect(bannerSrc).toMatch(/isOnline\s*&&\s*failedCount\s*===\s*0/);
  });

  it("offers a way to clear the persisted failures", () => {
    expect(bannerSrc).toMatch(/clearFailedAction\b/);
    expect(bannerSrc).toMatch(/clearFailedActions\b/);
  });

  it("both role layouts render the shared banner rather than a private copy", () => {
    for (const group of ["(operator)", "(driver)"]) {
      const layoutSrc = readFileSync(join(__dirname, "..", "app", group, "_layout.tsx"), "utf8");
      expect(layoutSrc).toMatch(/from\s+["']\.\.\/\.\.\/components\/OfflineBanner["']/);
      expect(layoutSrc).not.toMatch(/function\s+OfflineBanner/);
    }
  });
});
