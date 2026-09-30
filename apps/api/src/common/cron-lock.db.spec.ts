/**
 * T4 (R1) — real-Postgres proof that `@LeaderCron` is a leader lock: two concurrent ticks of the
 * SAME decorated job (two instances, two pinned lock sessions — which is what two replicas are)
 * run the body exactly once.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js's `.db.spec.ts$` lane), against the
 * compose Postgres — never in the default `npm run test` red gate (test-plan.md T4).
 *
 * UNEXECUTED: written 2026-09-04; first execution owed at ship (compose DB was down during the
 * build). Until it has run green once, it is a stated intention, not evidence.
 *
 * House rule for tests of NEW modules: guarded `require` plus a call-site fallback, so the
 * module's absence fails on this spec's own value (the body ran twice) rather than on an
 * unresolved import.
 */

import { requireLocalDatabaseUrl, describeDb } from "./testing/db-spec";
import { _resetLockPoolForTests } from "./db-locks";

let mod: any = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require("./cron-lock");
} catch {
  mod = {};
}

// No-op fallback: leaves the method UNWRAPPED, so a missing decorator shows up as "the body ran
// on both instances" (started === 2 where 1 is expected) instead of a TypeError at class
// definition time.
const NOOP_DECORATOR: MethodDecorator = () => undefined;
const LeaderCron = (...args: any[]): MethodDecorator =>
  typeof mod.LeaderCron === "function" ? mod.LeaderCron(...args) : NOOP_DECORATOR;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let started = 0;

class DbJob {
  @LeaderCron("* * * * *", "t.dbjob")
  async run(): Promise<string> {
    started++;
    await sleep(400);
    return "ran";
  }
}

describeDb("cron-lock — real-Postgres leader election (T4, R1)", () => {
  beforeAll(() => {
    // db-locks builds its pool from process.env.DATABASE_URL itself, so this call is the guard,
    // not a fixture.
    requireLocalDatabaseUrl();
  });

  beforeEach(() => {
    started = 0;
  });

  afterAll(async () => {
    await _resetLockPoolForTests();
  });

  it("module shape: exports LeaderCron as a function", () => {
    expect(typeof mod.LeaderCron).toBe("function");
  });

  it("two concurrent ticks of the same job on two instances run the body exactly once", async () => {
    const a = new DbJob();
    const b = new DbJob();

    const results = await Promise.all([a.run(), b.run()]);

    expect(started).toBe(1);
    // The winner returns the body's value; the loser's tick is skipped and resolves undefined.
    expect([...results].sort()).toEqual([undefined, "ran"].sort());
  }, 20_000);

  it("a later tick, after the lock is released, runs the body again", async () => {
    const a = new DbJob();
    const b = new DbJob();

    await Promise.all([a.run(), b.run()]);
    expect(started).toBe(1);

    await expect(a.run()).resolves.toBe("ran");
    expect(started).toBe(2);
  }, 20_000);
});
