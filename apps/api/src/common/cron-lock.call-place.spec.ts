/**
 * B5-6 (SA-1105 A-3): `@LeaderCron` runs the job body inside `runAtPlace(<its name>)`, and ONLY that: inside the body the
 * tenant context is untouched (`kind()` NONE, `getOrNull()` null, `get()` throws), so no job sees a different tenant
 * answer than before. The lock and scheduler behaviour stays pinned by `cron-lock.spec.ts`, which is unchanged.
 */
jest.mock("./db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
  LockUnavailableError: class extends Error {},
}));

import { callPlace } from "./call-place";
import { LeaderCron } from "./cron-lock";
import { TenantContextService } from "../tenant/tenant-context.service";

const ctx = new TenantContextService();

class Jobs {
  @LeaderCron("* * * * *", "a.one")
  async one() {
    await Promise.resolve();
    return { place: callPlace(), kind: ctx.kind(), id: ctx.getOrNull(), threw: this.getThrows() };
  }

  @LeaderCron("* * * * *", "b.two")
  two() {
    return Promise.resolve(callPlace());
  }

  private getThrows(): boolean {
    try {
      ctx.get();
      return false;
    } catch {
      return true;
    }
  }
}

describe("B5-6 @LeaderCron names the job and changes nothing about the tenant context", () => {
  it("callPlace() is the job's name inside the body, awaits included, and absent outside", async () => {
    const jobs = new Jobs();
    expect(callPlace()).toBeUndefined();
    expect((await jobs.one()).place).toBe("a.one");
    expect(await jobs.two()).toBe("b.two");
    expect(callPlace()).toBeUndefined();
  });

  it("inside the body kind() is NONE, getOrNull() is null and get() throws, as with no store", async () => {
    expect(await new Jobs().one()).toMatchObject({ kind: "NONE", id: null, threw: true });
  });
});
