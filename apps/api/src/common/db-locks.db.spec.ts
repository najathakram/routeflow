/**
 * T4 (R1) — real-Postgres contention spec for `apps/api/src/common/db-locks.ts`.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js's `.db.spec.ts$` lane), against
 * the compose Postgres — never in the default `npm run test` red gate (test-plan.md T4).
 *
 * WHY THE FAMILY IS `order-merge` AND NOT A TEST-ONLY ONE: `LOCK_FAMILIES` is a closed
 * allow-list (PR-2b gave each family its own pool, so an unrecognised family would stand up a
 * ninth-through-sixteenth connection nobody sized for) and `withAdvisoryLock` throws a TypeError
 * on anything outside it. The keys below are test-only, which is what actually keeps these
 * contention cases off any real lock.
 *
 * House rule for tests of NEW modules: guarded `require` inside the test body, so the module's
 * absence fails on an assertion (`typeof mod.withAdvisoryLock` is `"undefined"`), never on an
 * unresolved import. See test-plan.md T4 and `testing/db-spec.spec.ts` for the pattern.
 */

import { requireLocalDatabaseUrl, describeDb } from "./testing/db-spec";

let mod: any = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require("./db-locks");
} catch {
  mod = {};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Call-site fallback: the guarded require above protects the module LOAD, but calling a
// missing export would throw a TypeError before any test's own assertion runs. This wrapper
// keeps every case failing on its OWN oracle instead. It still invokes `fn` (swallowing
// whatever it throws) so the callback-driven synchronization these contention tests use
// (a promise the callback resolves once "inside the lock") does not hang forever waiting for
// a callback nothing ever calls — a fallback that never invoked `fn` would time out the whole
// lane rather than fail on an assertion.
const NOT_IMPLEMENTED_ACQUIRED = "not-implemented" as unknown as boolean;
async function withAdvisoryLock(
  opts: { family: string; key: string; mode: "wait" | "try"; waitMs?: number },
  fn: () => Promise<unknown>,
): Promise<{ acquired: boolean; value?: unknown }> {
  if (typeof mod.withAdvisoryLock === "function") {
    return mod.withAdvisoryLock(opts, fn);
  }
  try {
    await fn();
  } catch {
    // The stub's job here is to keep the test moving, not to reproduce error semantics —
    // the test's own assertions decide whether that counts as pass or fail.
  }
  return { acquired: NOT_IMPLEMENTED_ACQUIRED };
}

async function resetLockPoolForTests(): Promise<void> {
  if (typeof mod._resetLockPoolForTests === "function") {
    await mod._resetLockPoolForTests();
  }
}

describeDb("db-locks — real-Postgres contention (T4, R1)", () => {
  beforeAll(() => {
    // Asserts DATABASE_URL is set and local — db-locks.ts reads it from process.env itself
    // (a lazily created module-level pool per R1), so this call is the guard, not a fixture.
    requireLocalDatabaseUrl();
  });

  afterAll(async () => {
    await resetLockPoolForTests();
  });

  it("module shape: exports withAdvisoryLock as a function", () => {
    // Before implementation: typeof is "undefined" (fails on its own value, per test-plan T4).
    expect(typeof mod.withAdvisoryLock).toBe("function");
  });

  it("(a) two concurrent wait locks on the SAME key serialize: the later start is not before the earlier end", async () => {
    const events: { start: number; end: number }[] = [];
    const run = () =>
      withAdvisoryLock(
        { family: "order-merge", key: "same", mode: "wait", waitMs: 20_000 },
        async () => {
          const start = Date.now();
          await sleep(300);
          const end = Date.now();
          events.push({ start, end });
          return end;
        },
      );

    const [r1, r2] = await Promise.all([run(), run()]);

    expect(r1).toEqual({ acquired: true, value: expect.any(Number) });
    expect(r2).toEqual({ acquired: true, value: expect.any(Number) });
    expect(events).toHaveLength(2);
    const [first, second] = [...events].sort((x, y) => x.start - y.start);
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  }, 15_000);

  it("(b) two concurrent wait locks on DIFFERENT keys run concurrently: their intervals overlap", async () => {
    const events: Record<string, { start: number; end: number }> = {};
    const run = (key: string) =>
      withAdvisoryLock({ family: "order-merge", key, mode: "wait", waitMs: 20_000 }, async () => {
        const start = Date.now();
        await sleep(300);
        const end = Date.now();
        events[key] = { start, end };
        return key;
      });

    const [r1, r2] = await Promise.all([run("b1"), run("b2")]);

    expect(r1).toEqual({ acquired: true, value: "b1" });
    expect(r2).toEqual({ acquired: true, value: "b2" });
    expect(events.b1).toBeDefined();
    expect(events.b2).toBeDefined();
    // Overlap ⇔ the later start happens before the earlier end.
    const laterStart = Math.max(events.b1.start, events.b2.start);
    const earlierEnd = Math.min(events.b1.end, events.b2.end);
    expect(laterStart).toBeLessThan(earlierEnd);
  }, 15_000);

  it("(c) a wait lock whose waitMs is shorter than the holder's hold time rejects with LockTimeoutError before the holder releases", async () => {
    let signalHolderAcquired!: () => void;
    const holderAcquired = new Promise<void>((resolve) => {
      signalHolderAcquired = resolve;
    });

    const holderPromise = withAdvisoryLock(
      { family: "order-merge", key: "held", mode: "wait", waitMs: 20_000 },
      async () => {
        signalHolderAcquired();
        await sleep(1500);
        return "holder-done";
      },
    );

    await holderAcquired;

    const waiterStart = Date.now();
    let waiterError: any;
    try {
      await withAdvisoryLock(
        { family: "order-merge", key: "held", mode: "wait", waitMs: 500 },
        async () => {
          throw new Error(
            "T4(c) violated: the waiter's fn ran while the holder still held the lock",
          );
        },
      );
    } catch (err) {
      waiterError = err;
    }
    const waiterElapsedMs = Date.now() - waiterStart;

    expect(waiterError).toBeDefined();
    expect(waiterError?.name).toBe("LockTimeoutError");
    expect(waiterElapsedMs).toBeLessThan(1500);

    // Let the holder finish so it doesn't leak into a later test.
    await holderPromise;
  }, 15_000);

  it("(d) a try lock on a held key reports acquired:false without running fn; after release, try acquires", async () => {
    let signalHolderAcquired!: () => void;
    const holderAcquired = new Promise<void>((resolve) => {
      signalHolderAcquired = resolve;
    });
    let releaseHolder!: () => void;
    const holderMayRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holderPromise = withAdvisoryLock(
      { family: "order-merge", key: "trykey", mode: "wait", waitMs: 20_000 },
      async () => {
        signalHolderAcquired();
        await holderMayRelease;
        return "holder-done";
      },
    );

    await holderAcquired;

    let tryFnCalled = false;
    const tryWhileHeld = await withAdvisoryLock(
      { family: "order-merge", key: "trykey", mode: "try" },
      async () => {
        tryFnCalled = true;
        return "should-not-run";
      },
    );

    expect(tryWhileHeld).toEqual({ acquired: false });
    expect(tryFnCalled).toBe(false);

    releaseHolder();
    await holderPromise;

    const tryAfterRelease = await withAdvisoryLock(
      { family: "order-merge", key: "trykey", mode: "try" },
      async () => {
        return "after-release";
      },
    );

    expect(tryAfterRelease).toEqual({ acquired: true, value: "after-release" });
  }, 15_000);
});
