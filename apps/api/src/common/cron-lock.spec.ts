/**
 * T1 (R1) — `apps/api/src/common/cron-lock.ts` contract: `@LeaderCron` composes
 * `withAdvisoryLock({ family: "cron", key: <name>, mode: "try" })` around the tick and then
 * applies `@Cron(expr, { name })` so the scheduler registers the WRAPPED method under a stable
 * name (see test-plan.md T1).
 *
 * House rule for tests of NEW modules: guarded `require` at module scope plus call-site
 * fallbacks, so the module's absence fails each case on its OWN oracle (a wrong value / a
 * missing throw), never on an unresolved import or a `TypeError`. See
 * `testing/db-spec.spec.ts` for the pattern.
 */

// The factory owns the mock so nothing in it closes over a `const` declared further down
// (a hoisted factory would hit the TDZ). Read it back with `jest.requireMock` instead.
jest.mock("./db-locks", () => {
  class LockUnavailableError extends Error {
    constructor(public readonly cause?: unknown) {
      super("advisory lock connection unavailable");
      this.name = "LockUnavailableError";
    }
  }
  class LockTimeoutError extends Error {
    constructor() {
      super("advisory lock timeout");
      this.name = "LockTimeoutError";
    }
  }
  return { withAdvisoryLock: jest.fn(), LockUnavailableError, LockTimeoutError };
});

import { Injectable, Logger } from "@nestjs/common";
import { ScheduleModule, SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";

const dbLocks = jest.requireMock("./db-locks") as {
  withAdvisoryLock: jest.Mock;
  LockUnavailableError: new (cause?: unknown) => Error;
};

let mod: any = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require("./cron-lock");
} catch {
  mod = {};
}

// Call-site fallback: a missing export would otherwise throw `TypeError: mod.LeaderCron is not a
// function` at class-definition time, before any assertion runs. The no-op decorator leaves the
// method UNWRAPPED, so every case below then fails on its own value (the body ran when it should
// not have, the mock was never called, the invalid name never threw).
const NOOP_DECORATOR: MethodDecorator = () => undefined;
const LeaderCron = (...args: any[]): MethodDecorator =>
  typeof mod.LeaderCron === "function" ? mod.LeaderCron(...args) : NOOP_DECORATOR;

@Injectable()
class Job {
  calls = 0;
  lastArg: number | undefined;

  @LeaderCron("* * * * *", "t.job")
  async run(x: number): Promise<number> {
    this.calls++;
    this.lastArg = x;
    return x * 2;
  }
}

describe("cron-lock — @LeaderCron (T1, R1)", () => {
  // The module holds a module-scope `new Logger("LeaderCron")`, which owns none of these methods
  // itself — spying on the PROTOTYPE therefore intercepts calls made through that already-built
  // instance, and keeps the skip lines out of the suite's output.
  let debugSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    dbLocks.withAdvisoryLock.mockReset();
    debugSpy = jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe("module shape", () => {
    it("exports LeaderCron as a function", () => {
      expect(typeof mod.LeaderCron).toBe("function");
    });

    it("exports CRON_LOCK_FAMILY as 'cron'", () => {
      expect(mod.CRON_LOCK_FAMILY).toBe("cron");
    });
  });

  it("(a) when the lock is acquired: the body runs once, its value is returned, and the lock is taken with family 'cron', the job name as key, and mode 'try'", async () => {
    dbLocks.withAdvisoryLock.mockImplementation(
      async (_opts: unknown, fn: () => Promise<unknown>) => ({
        acquired: true,
        value: await fn(),
      }),
    );

    const job = new Job();
    await expect(job.run(21)).resolves.toBe(42);

    expect(job.calls).toBe(1);
    expect(job.lastArg).toBe(21);
    expect(dbLocks.withAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(dbLocks.withAdvisoryLock.mock.calls[0][0]).toEqual({
      family: "cron",
      key: "t.job",
      mode: "try",
    });
  });

  it("(b) when another instance holds the lock: the body does not run, the tick resolves undefined, and the skip is logged at DEBUG naming the job", async () => {
    dbLocks.withAdvisoryLock.mockResolvedValue({ acquired: false });

    const job = new Job();
    await expect(job.run(21)).resolves.toBeUndefined();

    expect(job.calls).toBe(0);
    // A losing election is the NORMAL steady state on every replica but one, so it must stay at
    // debug and must say WHY the tick did not run — an operator reading "skipped" with no reason
    // cannot tell a healthy election from a job that is failing to start.
    expect(debugSpy).toHaveBeenCalledWith(
      "cron t.job: another instance holds the lock — tick skipped",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("(c) when the lock connection is unavailable: the tick is skipped, not thrown — the body does not run and the skip is logged at WARN naming the job", async () => {
    dbLocks.withAdvisoryLock.mockRejectedValue(new dbLocks.LockUnavailableError(new Error("boom")));

    const job = new Job();
    await expect(job.run(21)).resolves.toBeUndefined();

    expect(job.calls).toBe(0);
    // WARN, not debug: unlike a lost election this is a pool that could not hand out a
    // connection — the tick is still skipped rather than crashing the process, but it is a
    // capacity signal an operator should see.
    expect(warnSpy).toHaveBeenCalledWith("cron t.job: lock connection unavailable — tick skipped");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("(d) an error thrown by the body propagates to the caller", async () => {
    const boom = new Error("body exploded");
    dbLocks.withAdvisoryLock.mockImplementation(
      async (_opts: unknown, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
    );

    @Injectable()
    class Exploding {
      @LeaderCron("* * * * *", "t.explode")
      async run(): Promise<void> {
        throw boom;
      }
    }

    await expect(new Exploding().run()).rejects.toBe(boom);
  });

  it("(e) an invalid job name throws at class-definition time", () => {
    expect(() => {
      class Bad {
        @LeaderCron("* * * * *", "BadName")
        async run(): Promise<void> {
          return undefined;
        }
      }
      return Bad;
    }).toThrow(/BadName/);
  });

  it("(f) the scheduler registers the job under its stable name, and the REGISTERED tick is the locked one", async () => {
    dbLocks.withAdvisoryLock.mockResolvedValue({ acquired: false });

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [Job],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const registry = app.get(SchedulerRegistry);
      const job = registry.getCronJob("t.job");
      expect(job).toBeDefined();

      // Registration alone would still pass if `Cron` had been applied to the UNWRAPPED method
      // (the ordering hazard the header calls out): the name would resolve and every replica
      // would run the tick. So fire the registered tick and prove it goes through the lock.
      // `fireOnTick` invokes the callback synchronously, and the wrapper calls `withAdvisoryLock`
      // before its first `await`, so the call is recorded by the time this resolves.
      await job.fireOnTick();

      expect(dbLocks.withAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(dbLocks.withAdvisoryLock.mock.calls[0][0]).toEqual({
        family: "cron",
        key: "t.job",
        mode: "try",
      });
    } finally {
      await app.close();
    }
  });
});
